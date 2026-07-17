import { HttpError } from "./errors";

export type CandidateDocumentCategory = "resume" | "essay" | "other";

export type CandidateDocument = {
  documentId: string;
  candidateId: string;
  category: CandidateDocumentCategory;
  filename: string;
  mimeType: "application/pdf";
  sizeBytes: number;
  uploadedAt: string;
  uploadedBy: string;
  url: string;
};

type CandidateDocumentFile = {
  name?: unknown;
  mimeType?: unknown;
  contentType?: unknown;
  base64?: unknown;
};

const DOCUMENT_CATEGORIES = new Set<CandidateDocumentCategory>(["resume", "essay", "other"]);
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DOCUMENT_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const DOCUMENT_PREFIX_SEGMENT = "documents";
const MAX_DOCUMENT_BYTES = 9 * 1024 * 1024;

export async function uploadCandidateDocument(
  bucket: R2Bucket,
  candidateIdInput: string,
  categoryInput: string,
  file: CandidateDocumentFile,
  uploadedBy: string,
  documentIdInput: string,
): Promise<CandidateDocument> {
  const candidateId = requireCandidateId(candidateIdInput);
  const category = requireCategory(categoryInput);
  const documentId = requireDocumentId(documentIdInput);
  const originalFilename = normalizeOriginalFilename(file.name);
  const mimeType = String(file.mimeType ?? file.contentType ?? "").split(";")[0].trim().toLowerCase();
  if (mimeType !== "application/pdf") {
    throw new HttpError(400, "validation", "PDFのみアップロードできます");
  }

  const bytes = decodeBase64(String(file.base64 ?? ""));
  if (!hasPdfMagic(bytes)) {
    throw new HttpError(400, "validation", "PDFファイルの内容を確認できませんでした");
  }
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new HttpError(400, "validation", "PDFは9MB以下にしてください");
  }

  const storedFilename = safeStoredFilename(originalFilename);
  const key = documentKey(candidateId, category, documentId, storedFilename);
  const checksumSha256 = await sha256Hex(bytes);
  const uploadedAt = new Date().toISOString();
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: {
      candidateId,
      documentId,
      category,
      originalFilenameBase64: encodeMetadata(originalFilename),
      uploadedByBase64: encodeMetadata(uploadedBy),
      checksumSha256,
    },
  });

  return {
    documentId,
    candidateId,
    category,
    filename: originalFilename,
    mimeType: "application/pdf",
    sizeBytes: bytes.byteLength,
    uploadedAt,
    uploadedBy,
    url: documentUrl(candidateId, category, documentId, storedFilename),
  };
}

export async function listCandidateDocuments(
  bucket: R2Bucket,
  candidateIdInput: string,
): Promise<CandidateDocument[]> {
  const candidateId = requireCandidateId(candidateIdInput);
  const objects = await listDocumentObjects(bucket, candidateId);
  return objects
    .map((object) => candidateDocumentFromObject(object, candidateId))
    .filter((document): document is CandidateDocument => document !== null)
    .sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt));
}

export async function deleteCandidateDocument(
  bucket: R2Bucket,
  candidateIdInput: string,
  documentIdInput: string,
): Promise<{ documentId: string; candidateId: string; key: string }> {
  const candidateId = requireCandidateId(candidateIdInput);
  const documentId = requireDocumentId(documentIdInput);
  const objects = await listDocumentObjects(bucket, candidateId);
  const match = objects.find((object) => parseDocumentKey(object.key, candidateId)?.documentId === documentId);
  if (!match) throw new HttpError(404, "not_found", "参考資料が見つかりません");
  await bucket.delete(match.key);
  return { documentId, candidateId, key: match.key };
}

export async function deleteAllCandidateDocuments(bucket: R2Bucket, candidateIdInput: string): Promise<number> {
  const candidateId = requireCandidateId(candidateIdInput);
  const objects = await listDocumentObjects(bucket, candidateId);
  if (objects.length === 0) return 0;
  await bucket.delete(objects.map((object) => object.key));
  return objects.length;
}

function candidateDocumentFromObject(object: R2Object, candidateId: string): CandidateDocument | null {
  const location = parseDocumentKey(object.key, candidateId);
  if (!location) return null;
  const originalFilename = decodeMetadata(
    customMetadataValue(object.customMetadata, "originalFilenameBase64"),
  ) || location.filename;
  const uploadedBy = decodeMetadata(
    customMetadataValue(object.customMetadata, "uploadedByBase64"),
  );
  const uploadedAt = normalizeUploadedAt(object.uploaded);
  return {
    documentId: location.documentId,
    candidateId,
    category: location.category,
    filename: originalFilename,
    mimeType: "application/pdf",
    sizeBytes: object.size,
    uploadedAt,
    uploadedBy,
    url: documentUrl(candidateId, location.category, location.documentId, location.filename),
  };
}

function customMetadataValue(metadata: Record<string, string> | undefined, expectedKey: string): string | undefined {
  const normalizedExpectedKey = expectedKey.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return Object.entries(metadata ?? {}).find(
    ([key]) => key.replace(/[^A-Za-z0-9]/g, "").toLowerCase() === normalizedExpectedKey,
  )?.[1];
}

async function listDocumentObjects(bucket: R2Bucket, candidateId: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    // `include` is supported by the current R2 Workers API, while the pinned
    // workers-types package still exposes the older R2ListOptions shape.
    const listOptions = {
      prefix: documentPrefix(candidateId),
      include: ["customMetadata", "httpMetadata"] as const,
      ...(cursor ? { cursor } : {}),
    };
    const page = await bucket.list(listOptions);
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

function parseDocumentKey(
  key: string,
  expectedCandidateId: string,
): { category: CandidateDocumentCategory; documentId: string; filename: string } | null {
  const segments = key.split("/");
  if (
    segments.length !== 6 ||
    segments[0] !== "candidates" ||
    segments[1] !== expectedCandidateId ||
    segments[2] !== DOCUMENT_PREFIX_SEGMENT
  ) return null;
  const category = segments[3];
  const documentId = segments[4];
  const filename = segments[5];
  if (!DOCUMENT_CATEGORIES.has(category as CandidateDocumentCategory)) return null;
  if (!DOCUMENT_ID_PATTERN.test(documentId)) return null;
  if (!/^[A-Za-z0-9._-]{1,180}$/.test(filename) || filename.includes("..")) return null;
  return { category: category as CandidateDocumentCategory, documentId, filename };
}

function documentPrefix(candidateId: string): string {
  return `candidates/${candidateId}/${DOCUMENT_PREFIX_SEGMENT}/`;
}

function documentKey(
  candidateId: string,
  category: CandidateDocumentCategory,
  documentId: string,
  filename: string,
): string {
  return `${documentPrefix(candidateId)}${category}/${documentId}/${filename}`;
}

function documentUrl(
  candidateId: string,
  category: CandidateDocumentCategory,
  documentId: string,
  filename: string,
): string {
  return ["", "files", "r2", candidateId, DOCUMENT_PREFIX_SEGMENT, category, documentId, filename]
    .map((segment, index) => index < 3 ? segment : encodeURIComponent(segment))
    .join("/");
}

function requireCandidateId(value: string): string {
  const candidateId = String(value ?? "").trim();
  if (!CANDIDATE_ID_PATTERN.test(candidateId)) {
    throw new HttpError(400, "validation", "candidateId is invalid");
  }
  return candidateId;
}

function requireDocumentId(value: string): string {
  const documentId = String(value ?? "").trim();
  if (!DOCUMENT_ID_PATTERN.test(documentId)) {
    throw new HttpError(400, "validation", "documentId is invalid");
  }
  return documentId;
}

function requireCategory(value: string): CandidateDocumentCategory {
  const category = String(value ?? "").trim() as CandidateDocumentCategory;
  if (!DOCUMENT_CATEGORIES.has(category)) {
    throw new HttpError(400, "validation", "category must be resume, essay, or other");
  }
  return category;
}

function normalizeOriginalFilename(value: unknown): string {
  const filename = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f/\\]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  if (!filename) throw new HttpError(400, "validation", "file.name is required");
  return filename.toLowerCase().endsWith(".pdf") ? filename : `${filename}.pdf`;
}

function safeStoredFilename(originalFilename: string): string {
  const stem = originalFilename.replace(/\.pdf$/i, "");
  const asciiStem = stem
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 160);
  const hasAsciiLetter = /[A-Za-z]/.test(stem);
  const safeStem = hasAsciiLetter
    ? asciiStem || "document"
    : asciiStem ? `document-${asciiStem}` : "document";
  return `${safeStem}.pdf`;
}

function decodeBase64(value: string): Uint8Array {
  if (!value.trim()) throw new HttpError(400, "validation", "file.base64 is required");
  try {
    const binary = atob(value.replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    throw new HttpError(400, "validation", "file.base64 is invalid");
  }
}

function hasPdfMagic(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 5 && String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
}

function encodeMetadata(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeMetadata(value?: string): string {
  if (!value) return "";
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function normalizeUploadedAt(value: Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
