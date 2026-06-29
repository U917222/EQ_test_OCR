import { verifyAccessJwt } from "../_lib/accessJwt";
import { errorResponse, HttpError, responseFromError } from "../_lib/errors";

interface Env {
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  MVP_OPERATOR_EMAIL?: string;
  ALLOW_INSECURE_DEV_AUTH?: string;
  CHEQ_DB: D1Database;
  CHEQ_FILES?: R2Bucket;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    if (!context.env.CHEQ_DB) throw new HttpError(500, "internal", "Missing CHEQ_DB binding");
    await verifyAccessJwt(context.request, context.env);

    const fileId = getFileId(context.params.path);
    const row = await context.env.CHEQ_DB
      .prepare("SELECT r2_key, filename, content_type, checksum_sha256, storage_kind, body_base64 FROM candidate_files WHERE file_id = ?")
      .bind(fileId)
      .first<{ r2_key: string; filename: string; content_type: string; checksum_sha256: string; storage_kind?: string; body_base64?: string }>();
    if (!row) throw new HttpError(404, "not_found", "File not found");

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

function getFileId(routeParam: unknown): string {
  const segments = Array.isArray(routeParam)
    ? routeParam
    : typeof routeParam === "string" && routeParam.length > 0
      ? [routeParam]
      : [];
  const fileId = typeof segments[0] === "string" ? segments[0].trim() : "";
  if (!/^[0-9a-fA-F-]{36}$/.test(fileId)) {
    throw new HttpError(404, "not_found", "File not found");
  }
  return fileId;
}

function downloadFilename(filename: string): string {
  return filename.replace(/["\r\n]/g, "_");
}

function fileHeaders(filename: string, contentType: string, checksumSha256: string): Headers {
  const headers = new Headers();
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
