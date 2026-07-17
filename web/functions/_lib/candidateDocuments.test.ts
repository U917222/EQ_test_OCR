import { describe, expect, it, vi } from "vitest";
import {
  deleteCandidateDocument,
  listCandidateDocuments,
  uploadCandidateDocument,
} from "./candidateDocuments";

const documentId = "11111111-1111-4111-8111-111111111111";

function pdfBase64(body = "document") {
  return Buffer.from(`%PDF-1.7\n${body}`).toString("base64");
}

function encodedMetadata(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

describe("candidate documents in private R2", () => {
  it("uploads a PDF separately from scoring sheets and preserves its Japanese filename", async () => {
    const put = vi.fn(async () => undefined);
    const bucket = { put } as unknown as R2Bucket;

    const document = await uploadCandidateDocument(
      bucket,
      "cand-1",
      "resume",
      {
        name: "履歴書 2026.pdf",
        mimeType: "application/pdf",
        base64: pdfBase64(),
      },
      "operator@example.test",
      documentId,
    );

    expect(document).toMatchObject({
      documentId,
      candidateId: "cand-1",
      category: "resume",
      filename: "履歴書 2026.pdf",
      mimeType: "application/pdf",
      sizeBytes: 17,
      uploadedBy: "operator@example.test",
    });
    expect(document.url).toBe(
      `/files/r2/cand-1/documents/resume/${documentId}/document-2026.pdf`,
    );
    expect(put).toHaveBeenCalledWith(
      `candidates/cand-1/documents/resume/${documentId}/document-2026.pdf`,
      expect.any(Uint8Array),
      expect.objectContaining({
        httpMetadata: { contentType: "application/pdf" },
        customMetadata: expect.objectContaining({
          candidateId: "cand-1",
          documentId,
          category: "resume",
          originalFilenameBase64: encodedMetadata("履歴書 2026.pdf"),
          uploadedByBase64: encodedMetadata("operator@example.test"),
        }),
      }),
    );
  });

  it("rejects a non-PDF MIME type and a spoofed PDF", async () => {
    const bucket = { put: vi.fn() } as unknown as R2Bucket;

    await expect(
      uploadCandidateDocument(
        bucket,
        "cand-1",
        "essay",
        { name: "essay.png", mimeType: "image/png", base64: pdfBase64() },
        "operator@example.test",
        documentId,
      ),
    ).rejects.toThrow("PDFのみアップロードできます");

    await expect(
      uploadCandidateDocument(
        bucket,
        "cand-1",
        "essay",
        { name: "essay.pdf", mimeType: "application/pdf", base64: Buffer.from("not-pdf").toString("base64") },
        "operator@example.test",
        documentId,
      ),
    ).rejects.toThrow("PDFファイルの内容を確認できませんでした");
  });

  it("lists every page newest-first and restores display metadata", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        objects: [
          {
            key: `candidates/cand-1/documents/essay/${documentId}/essay.pdf`,
            size: 1200,
            uploaded: new Date("2026-07-16T01:00:00.000Z"),
            customMetadata: {
              originalFilenameBase64: encodedMetadata("作文.pdf"),
              uploadedByBase64: encodedMetadata("writer@example.test"),
            },
          },
        ],
        truncated: true,
        cursor: "next-page",
      })
      .mockResolvedValueOnce({
        objects: [
          {
            key: "candidates/cand-1/documents/other/22222222-2222-4222-8222-222222222222/portfolio.pdf",
            size: 2400,
            uploaded: new Date("2026-07-17T01:00:00.000Z"),
            customMetadata: {
              originalfilenamebase64: encodedMetadata("資格証明.pdf"),
              uploadedbybase64: encodedMetadata("operator@example.test"),
            },
          },
        ],
        truncated: false,
      });
    const bucket = { list } as unknown as R2Bucket;

    const documents = await listCandidateDocuments(bucket, "cand-1");

    expect(documents.map((document) => document.filename)).toEqual(["資格証明.pdf", "作文.pdf"]);
    expect(documents[0].uploadedBy).toBe("operator@example.test");
    expect(documents[1]).toMatchObject({
      category: "essay",
      uploadedBy: "writer@example.test",
      mimeType: "application/pdf",
    });
    expect(list).toHaveBeenNthCalledWith(1, {
      prefix: "candidates/cand-1/documents/",
      include: ["customMetadata", "httpMetadata"],
    });
    expect(list).toHaveBeenNthCalledWith(2, {
      prefix: "candidates/cand-1/documents/",
      include: ["customMetadata", "httpMetadata"],
      cursor: "next-page",
    });
  });

  it("deletes only the requested candidate document", async () => {
    const key = `candidates/cand-1/documents/resume/${documentId}/resume.pdf`;
    const bucket = {
      list: vi.fn(async () => ({ objects: [{ key, size: 1, uploaded: new Date() }], truncated: false })),
      delete: vi.fn(async () => undefined),
    } as unknown as R2Bucket;

    const deleted = await deleteCandidateDocument(bucket, "cand-1", documentId);

    expect(deleted.documentId).toBe(documentId);
    expect(bucket.delete).toHaveBeenCalledWith(key);
  });
});
