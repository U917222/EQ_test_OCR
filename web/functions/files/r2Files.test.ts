import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../_lib/accessJwt", () => ({
  verifyAccessJwt: vi.fn(async () => ({ email: "operator@example.test", claims: {} })),
}));

import { onRequestGet } from "./[[path]]";

const fileId = "11111111-1111-4111-8111-111111111111";

function createContext(
  path: string[],
  bucket?: { get: ReturnType<typeof vi.fn> },
  options: { active?: boolean; candidateExists?: boolean; role?: string; scoringApi?: boolean } = {},
) {
  const { active = true, candidateExists = true, role = "operator", scoringApi = false } = options;
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...args: unknown[]) => ({
        first: vi.fn(async () => {
          if (sql.includes("FROM users")) {
            return active ? { email: "operator@example.test", role, active: 1 } : null;
          }
          if (sql.includes("FROM candidates")) {
            return candidateExists ? { candidate_id: String(args[0]) } : null;
          }
          throw new Error(`Unexpected D1 query: ${sql}`);
        }),
      })),
    })),
  };
  return {
    request: new Request(`https://example.test/files/${path.join("/")}`),
    env: {
      CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      CF_ACCESS_AUD: "audience",
      CHEQ_DB: db,
      CHEQ_FILES: bucket,
      ...(scoringApi ? {
        SCORING_API_URL: "https://scoring.example.test/api",
        SCORING_API_SECRET: "test-secret",
      } : {}),
    },
    params: { path },
  } as unknown as Parameters<typeof onRequestGet>[0];
}

function createBucket() {
  const get = vi.fn(async () => ({
    body: new Response("r2 file body").body,
    httpEtag: '"etag-1"',
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { "checksum-sha256": "abc123" },
    writeHttpMetadata(headers: Headers) {
      headers.set("Content-Type", "application/pdf");
    },
  }));
  return { get };
}

describe("authenticated scoring-api R2 files", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("serves a valid private R2 object after checking the active app user and candidate", async () => {
    const bucket = createBucket();
    const context = createContext(["r2", "cand-1", fileId, "cand-1_scoresheet.pdf"], bucket);

    const response = await onRequestGet(context);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("r2 file body");
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toBe('inline; filename="cand-1_scoresheet.pdf"');
    expect(response.headers.get("X-Checksum-SHA256")).toBe("abc123");
    expect(bucket.get).toHaveBeenCalledWith(
      `candidates/cand-1/${fileId}/cand-1_scoresheet.pdf`,
      expect.objectContaining({ onlyIf: context.request.headers, range: context.request.headers }),
    );
    expect(context.env.CHEQ_DB.prepare).toHaveBeenCalledWith(expect.stringContaining("FROM users"));
    expect(context.env.CHEQ_DB.prepare).toHaveBeenCalledWith(expect.stringContaining("FROM candidates"));
    expect(context.env.CHEQ_DB.prepare).not.toHaveBeenCalledWith(expect.stringContaining("candidate_files"));
  });

  it("serves a candidate reference PDF from the isolated documents prefix", async () => {
    const bucket = createBucket();
    const context = createContext(
      ["r2", "cand-1", "documents", "resume", fileId, "resume.pdf"],
      bucket,
    );

    const response = await onRequestGet(context);

    expect(response.status).toBe(200);
    expect(bucket.get).toHaveBeenCalledWith(
      `candidates/cand-1/documents/resume/${fileId}/resume.pdf`,
      expect.objectContaining({ onlyIf: context.request.headers, range: context.request.headers }),
    );
  });

  it("rejects an inactive app user before accessing R2", async () => {
    const bucket = createBucket();
    const context = createContext(
      ["r2", "cand-1", "documents", "resume", fileId, "resume.pdf"],
      bucket,
      { active: false },
    );

    const response = await onRequestGet(context);

    expect(response.status).toBe(403);
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it("rejects a missing candidate before accessing R2", async () => {
    const bucket = createBucket();
    const context = createContext(
      ["r2", "cand-1", "documents", "resume", fileId, "resume.pdf"],
      bucket,
      { candidateExists: false },
    );

    const response = await onRequestGet(context);

    expect(response.status).toBe(404);
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it("uses scoring-api authorization when the upstream backend is configured", async () => {
    const bucket = createBucket();
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: { code: "forbidden", message: "User is not active" },
    }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", upstreamFetch);
    const context = createContext(
      ["r2", "cand-1", "documents", "resume", fileId, "resume.pdf"],
      bucket,
      { scoringApi: true },
    );

    const response = await onRequestGet(context);

    expect(response.status).toBe(403);
    expect(upstreamFetch).toHaveBeenCalledOnce();
    expect(context.env.CHEQ_DB.prepare).not.toHaveBeenCalled();
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it("rejects path traversal before accessing R2", async () => {
    const bucket = createBucket();
    const context = createContext(["r2", "cand-1", fileId, "..", "secret.pdf"], bucket);

    const response = await onRequestGet(context);

    expect(response.status).toBe(404);
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it("fails closed when the R2 binding is missing", async () => {
    const context = createContext(["r2", "cand-1", fileId, "cand-1_scoresheet.pdf"]);

    const response = await onRequestGet(context);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "internal", message: "Missing CHEQ_FILES binding" },
    });
  });
});
