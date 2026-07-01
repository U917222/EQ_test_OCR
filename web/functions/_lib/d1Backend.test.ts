import { describe, expect, it } from "vitest";
import { registerCandidate } from "./d1Backend";

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
