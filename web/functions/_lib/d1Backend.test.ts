import { describe, expect, it, vi } from "vitest";
import { deleteCandidate, registerCandidate, uploadCandidateDocument } from "./d1Backend";

// registerCandidate() の DB 呼び出しだけを満たす最小限のフェイク D1。
// candidates テーブルの INSERT/UPDATE/SELECT のみを実データとして扱い、
// raw_cells/review_queue/candidate_files などその他のテーブルへの書き込みは無視する。
function createFakeD1() {
  const candidateRows = new Map<string, Record<string, unknown>>();

  function applyCandidatesInsert(args: unknown[]) {
    const [
      candidateId, name, testDate, gender, role, postalCode, prefecture, city, addressLine,
      uploadedAt, status, sourceUrl, memo, updatedAt,
    ] = args;
    candidateRows.set(String(candidateId), {
      candidate_id: candidateId, name, test_date: testDate, gender, role,
      postal_code: postalCode, prefecture, city, address_line: addressLine,
      uploaded_at: uploadedAt, status, source_url: sourceUrl, memo, updated_at: updatedAt,
    });
  }

  function applyCandidatesUpdate(sql: string, args: unknown[]) {
    const candidateId = String(args[args.length - 1]);
    const row = candidateRows.get(candidateId);
    if (!row) return;
    if (sql.includes("source_url = ?")) row.source_url = args[0];
    else if (sql.includes("status = ?")) row.status = args[0];
  }

  const statement = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      run: async () => {
        if (/^INSERT INTO candidates\b/.test(sql)) applyCandidatesInsert(args);
        else if (/^UPDATE candidates\b/.test(sql)) applyCandidatesUpdate(sql, args);
        return { success: true, meta: {} };
      },
      first: async <T>() => {
        if (/^SELECT \* FROM candidates WHERE candidate_id = \?/.test(sql)) {
          return (candidateRows.get(String(args[0])) as T) ?? null;
        }
        return null;
      },
    }),
  });

  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => Promise.all(stmts.map((s) => s.run())),
  };

  return { db: db as unknown as D1Database, candidateRows };
}

function baseContext(payload: Record<string, unknown>) {
  return {
    action: "registerCandidate" as const,
    operator: "operator@example.test",
    role: "operator" as const,
    operationId: "op-1",
    payload,
  };
}

describe("d1Backend registerCandidate", () => {
  it("registers without a scoresheet file as uploaded (応募済み), not needs_review", async () => {
    const { db, candidateRows } = createFakeD1();
    const env = { CHEQ_DB: db } as unknown as Parameters<typeof registerCandidate>[0];

    const { candidate } = await registerCandidate(
      env,
      baseContext({ name: "PDF無しテスト", testDate: "2026-07-01" }),
    );

    expect(candidate.status).toBe("uploaded");
    const [storedRow] = candidateRows.values();
    expect(storedRow.status).toBe("UPLOADED");
  });

  it("registers with a scoresheet file (OCR unconfigured) as recognizing, not needs_review", async () => {
    const { db, candidateRows } = createFakeD1();
    const env = { CHEQ_DB: db } as unknown as Parameters<typeof registerCandidate>[0];
    const base64 = Buffer.from("not a real pdf, just enough bytes").toString("base64");

    const { candidate } = await registerCandidate(
      env,
      baseContext({
        name: "ファイルありテスト",
        testDate: "2026-07-01",
        file: { name: "scoresheet.pdf", mimeType: "application/pdf", base64 },
      }),
    );

    expect(candidate.status).toBe("recognizing");
    const [storedRow] = candidateRows.values();
    expect(storedRow.status).toBe("PROCESSING");
  });
});

const documentOperationId = "11111111-1111-4111-8111-111111111111";

function pdfBase64(body = "document") {
  return Buffer.from(`%PDF-1.7\n${body}`).toString("base64");
}

function createDocumentD1(options: {
  candidateReads: Array<Record<string, unknown> | null>;
  files?: Array<{ file_id: string; r2_key: string; storage_kind: string }>;
}) {
  let candidateReadIndex = 0;
  const statement = (sql: string) => ({
    bind: (..._args: unknown[]) => ({
      first: async <T>() => {
        if (/^SELECT \* FROM candidates WHERE candidate_id = \?/.test(sql)) {
          const row = options.candidateReads[candidateReadIndex] ?? null;
          candidateReadIndex += 1;
          return row as T | null;
        }
        return null;
      },
      all: async <T>() => {
        if (/^SELECT file_id, r2_key, storage_kind FROM candidate_files/.test(sql)) {
          return { results: (options.files ?? []) as T[] };
        }
        return { results: [] as T[] };
      },
      run: async () => ({ success: true, meta: {} }),
    }),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => Promise.all(statements.map((item) => item.run())),
  } as unknown as D1Database;
}

function documentUploadContext() {
  return {
    action: "uploadCandidateDocument" as const,
    operator: "operator@example.test",
    role: "operator" as const,
    operationId: documentOperationId,
    payload: {
      candidateId: "cand-1",
      category: "resume",
      file: {
        name: "resume.pdf",
        mimeType: "application/pdf",
        base64: pdfBase64(),
      },
    },
  };
}

describe("d1Backend candidate document lifecycle", () => {
  it("compensates the uploaded document when the candidate disappears during upload", async () => {
    const key = `candidates/cand-1/documents/resume/${documentOperationId}/resume.pdf`;
    const db = createDocumentD1({
      candidateReads: [{ candidate_id: "cand-1", name: "競合テスト" }, null],
    });
    const bucket = {
      put: vi.fn(async () => undefined),
      list: vi.fn(async () => ({
        objects: [{ key, size: 17, uploaded: new Date() }],
        truncated: false,
      })),
      delete: vi.fn(async () => undefined),
    } as unknown as R2Bucket;

    await expect(
      uploadCandidateDocument(
        { CHEQ_DB: db, CHEQ_FILES: bucket },
        documentUploadContext(),
        "cand-1",
      ),
    ).rejects.toMatchObject({ status: 409, code: "conflict" });

    expect(bucket.put).toHaveBeenCalledOnce();
    expect(bucket.delete).toHaveBeenCalledWith(key);
  });

  it("waits for reference-document cleanup and reports its result when deleting a candidate", async () => {
    const documentKey = `candidates/cand-1/documents/resume/${documentOperationId}/resume.pdf`;
    const db = createDocumentD1({
      candidateReads: [{ candidate_id: "cand-1", name: "削除テスト", status: "UPLOADED" }],
      files: [{ file_id: "file-1", r2_key: "candidates/cand-1/scoresheet.pdf", storage_kind: "r2" }],
    });
    let releaseDocumentCleanup: (() => void) | undefined;
    let markDocumentCleanupStarted: (() => void) | undefined;
    const documentCleanupStarted = new Promise<void>((resolve) => {
      markDocumentCleanupStarted = resolve;
    });
    const documentCleanupRelease = new Promise<void>((resolve) => {
      releaseDocumentCleanup = resolve;
    });
    const bucket = {
      list: vi.fn(async () => ({
        objects: [{ key: documentKey, size: 17, uploaded: new Date() }],
        truncated: false,
      })),
      delete: vi.fn(async (keyOrKeys: string | string[]) => {
        if (Array.isArray(keyOrKeys)) {
          markDocumentCleanupStarted?.();
          await documentCleanupRelease;
        }
      }),
    } as unknown as R2Bucket;
    const waitUntil = vi.fn((_promise: Promise<unknown>) => undefined);

    let settled = false;
    const deletion = deleteCandidate(
      { CHEQ_DB: db, CHEQ_FILES: bucket },
      "cand-1",
      waitUntil,
    ).then((result) => {
      settled = true;
      return result;
    });
    await documentCleanupStarted;
    await Promise.resolve();

    expect(settled).toBe(false);

    releaseDocumentCleanup?.();
    const result = await deletion;
    expect(result).toMatchObject({
      deleted: true,
      candidateId: "cand-1",
      filesDeleted: 1,
      filesFailed: 0,
      filesScheduledForDeletion: 1,
    });
    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it("reports a failed reference-document cleanup without hiding it", async () => {
    const db = createDocumentD1({
      candidateReads: [{ candidate_id: "cand-1", name: "削除失敗テスト", status: "UPLOADED" }],
    });
    const bucket = {
      list: vi.fn(async () => {
        throw new Error("R2 list failed");
      }),
      delete: vi.fn(async () => undefined),
    } as unknown as R2Bucket;

    const result = await deleteCandidate(
      { CHEQ_DB: db, CHEQ_FILES: bucket },
      "cand-1",
    );

    expect(result).toMatchObject({
      deleted: true,
      candidateId: "cand-1",
      filesDeleted: 0,
      filesFailed: 1,
    });
  });
});
