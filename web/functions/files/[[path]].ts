import { verifyAccessJwt } from "../_lib/accessJwt";
import { errorResponse, HttpError, responseFromError } from "../_lib/errors";
import {
  assertScoringApiConfig,
  canDispatchScoringApi,
  dispatchScoringApi,
} from "../_lib/scoringApiBackend";

interface Env {
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  MVP_OPERATOR_EMAIL?: string;
  ALLOW_INSECURE_DEV_AUTH?: string;
  CHEQ_DB: D1Database;
  CHEQ_FILES?: R2Bucket;
  SCORING_API_URL?: string;
  SCORING_API_SECRET?: string;
  /** Temporary rolling-migration fallback. */
  FUNCTIONS_GAS_SECRET?: string;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const { email } = await verifyAccessJwt(context.request, context.env);

    const routeSegments = getRouteSegments(context.params.path);
    if (routeSegments[0] === "r2") {
      const location = directR2Location(routeSegments);
      const rejection = await candidateFileAccessRejection(context.env, email, location.candidateId);
      if (rejection) return rejection;
      return await serveDirectR2File(context.request, context.env, location);
    }

    if (!context.env.CHEQ_DB) throw new HttpError(500, "internal", "Missing CHEQ_DB binding");
    const fileId = getFileId(routeSegments);
    const row = await context.env.CHEQ_DB
      .prepare("SELECT candidate_id, r2_key, filename, content_type, checksum_sha256, storage_kind, body_base64 FROM candidate_files WHERE file_id = ?")
      .bind(fileId)
      .first<{ candidate_id: string; r2_key: string; filename: string; content_type: string; checksum_sha256: string; storage_kind?: string; body_base64?: string }>();
    if (!row) throw new HttpError(404, "not_found", "File not found");
    const rejection = await candidateFileAccessRejection(context.env, email, row.candidate_id);
    if (rejection) return rejection;

    if (row.storage_kind === "d1") {
      const headers = fileHeaders(row.filename, row.content_type, row.checksum_sha256);
      return new Response(toArrayBuffer(base64ToBytes(row.body_base64 ?? "")), { headers });
    }

    if (row.storage_kind === "d1_chunks") {
      const chunks = await context.env.CHEQ_DB
        .prepare("SELECT body_base64 FROM candidate_file_chunks WHERE file_id = ? ORDER BY chunk_index")
        .bind(fileId)
        .all<{ body_base64: string }>();
      const headers = fileHeaders(row.filename, row.content_type, row.checksum_sha256);
      return new Response(toArrayBuffer(base64ToBytes(chunks.results.map((chunk) => chunk.body_base64).join(""))), { headers });
    }

    if (!context.env.CHEQ_FILES) throw new HttpError(500, "internal", "Missing CHEQ_FILES binding");
    const object = await context.env.CHEQ_FILES.get(row.r2_key, {
      onlyIf: context.request.headers,
      range: context.request.headers,
    });
    if (!object) throw new HttpError(404, "not_found", "File object not found");

    const headers = fileHeaders(row.filename, row.content_type, row.checksum_sha256);
    object.writeHttpMetadata(headers);
    headers.set("Cache-Control", "private, max-age=300");
    headers.set("ETag", object.httpEtag);

    return new Response("body" in object ? object.body : undefined, {
      status: "body" in object ? 200 : 412,
      headers,
    });
  } catch (error) {
    return responseFromError(error);
  }
};

export const onRequest: PagesFunction<Env> = async () =>
  errorResponse(405, "method_not_allowed", "Only GET is allowed for /files/*");

function getRouteSegments(routeParam: unknown): string[] {
  return Array.isArray(routeParam)
    ? routeParam
    : typeof routeParam === "string" && routeParam.length > 0
      ? [routeParam]
      : [];
}

function getFileId(segments: string[]): string {
  const fileId = typeof segments[0] === "string" ? segments[0].trim() : "";
  if (!/^[0-9a-fA-F-]{36}$/.test(fileId)) {
    throw new HttpError(404, "not_found", "File not found");
  }
  return fileId;
}

type DirectR2Location = { candidateId: string; key: string; filename: string };

async function serveDirectR2File(request: Request, env: Env, location: DirectR2Location): Promise<Response> {
  if (!env.CHEQ_FILES) throw new HttpError(500, "internal", "Missing CHEQ_FILES binding");
  const object = await env.CHEQ_FILES.get(location.key, {
    onlyIf: request.headers,
    range: request.headers,
  });
  if (!object) throw new HttpError(404, "not_found", "File object not found");

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  fileHeaders(
    location.filename,
    headers.get("Content-Type") || object.httpMetadata?.contentType || "application/octet-stream",
    object.customMetadata?.["checksum-sha256"] ||
      object.customMetadata?.checksumSha256 ||
      object.customMetadata?.checksumsha256 ||
      "",
    headers,
  );
  headers.set("ETag", object.httpEtag);

  return new Response("body" in object ? object.body : undefined, {
    status: "body" in object ? 200 : 412,
    headers,
  });
}

function directR2Location(segments: string[]): DirectR2Location {
  if (segments[0] !== "r2") {
    throw new HttpError(404, "not_found", "File not found");
  }
  const isScoresheet = segments.length === 4;
  const isCandidateDocument = segments.length === 6 && segments[2] === "documents";
  if (!isScoresheet && !isCandidateDocument) {
    throw new HttpError(404, "not_found", "File not found");
  }

  const candidateId = decodeRouteSegment(segments[1]);
  const category = isCandidateDocument ? decodeRouteSegment(segments[3]) : "";
  const fileId = decodeRouteSegment(segments[isCandidateDocument ? 4 : 2]);
  const filename = decodeRouteSegment(segments[isCandidateDocument ? 5 : 3]);
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(candidateId) ||
    (isCandidateDocument && !["resume", "essay", "other"].includes(category)) ||
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(fileId) ||
    !/^[A-Za-z0-9._-]{1,255}$/.test(filename) ||
    filename.includes("..")
  ) {
    throw new HttpError(404, "not_found", "File not found");
  }
  return {
    candidateId,
    key: isCandidateDocument
      ? `candidates/${candidateId}/documents/${category}/${fileId}/${filename}`
      : `candidates/${candidateId}/${fileId}/${filename}`,
    filename,
  };
}

async function candidateFileAccessRejection(
  env: Env,
  email: string,
  candidateId: string,
): Promise<Response | null> {
  assertScoringApiConfig(env);
  if (canDispatchScoringApi(env, "getResult")) {
    const response = await dispatchScoringApi(env, "getResult", email, { candidateId });
    return response.ok ? null : response;
  }

  if (!env.CHEQ_DB) throw new HttpError(500, "internal", "Missing CHEQ_DB binding");
  const normalizedEmail = email.trim().toLowerCase();
  const user = await env.CHEQ_DB
    .prepare("SELECT email, role, active FROM users WHERE email = ?")
    .bind(normalizedEmail)
    .first<{ email: string; role: string; active: number }>();
  if (!user || !user.active || !["operator", "reviewer", "admin"].includes(user.role)) {
    throw new HttpError(403, "forbidden", "User is not active");
  }

  const candidate = await env.CHEQ_DB
    .prepare("SELECT candidate_id FROM candidates WHERE candidate_id = ?")
    .bind(candidateId)
    .first<{ candidate_id: string }>();
  if (!candidate) throw new HttpError(404, "not_found", "Candidate not found");
  return null;
}

function decodeRouteSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(404, "not_found", "File not found");
  }
}

function downloadFilename(filename: string): string {
  return filename.replace(/["\r\n]/g, "_");
}

function fileHeaders(
  filename: string,
  contentType: string,
  checksumSha256: string,
  headers = new Headers(),
): Headers {
  headers.set("Cache-Control", "private, max-age=300");
  headers.set("Content-Type", contentType || "application/octet-stream");
  headers.set("Content-Disposition", `inline; filename="${downloadFilename(filename)}"`);
  if (checksumSha256) headers.set("X-Checksum-SHA256", checksumSha256);
  return headers;
}

function base64ToBytes(value: string): Uint8Array {
  try {
    const binary = atob(value.replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw new HttpError(500, "internal", "Stored file is invalid");
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
