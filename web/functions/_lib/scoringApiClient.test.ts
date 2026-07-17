import { afterEach, describe, expect, it, vi } from "vitest";
import {
  postToScoringApi,
  readJsonResponse,
  scoringApiSecret,
  type ScoringApiEnv,
} from "./scoringApiClient";
import { createEnvelope } from "./sign";

const env: ScoringApiEnv = {
  SCORING_API_URL: "https://scoring.example.test/api",
  SCORING_API_SECRET: "test-secret",
};

function envelope() {
  return createEnvelope({
    action: "getResult",
    operator: "operator@example.com",
    role: "unknown",
    operationId: null,
    payload: { candidateId: "cand-1" },
  });
}

describe("scoringApiClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries transient upstream statuses with a fresh nonce", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await postToScoringApi(env, envelope());

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(secondBody.claims.nonce).not.toBe(firstBody.claims.nonce);
    expect(fetchMock.mock.calls[1][0].searchParams.get("X-Nonce")).toBe(secondBody.claims.nonce);
  });

  it("does not retry validation failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await postToScoringApi(env, envelope());

    expect(response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid upstream JSON", async () => {
    await expect(readJsonResponse(new Response("not json", { status: 200 }))).rejects.toThrow("invalid JSON");
  });

  it("prefers the new secret name and falls back to the legacy name", () => {
    expect(scoringApiSecret({ SCORING_API_URL: "https://example.test", SCORING_API_SECRET: "new", FUNCTIONS_GAS_SECRET: "old" })).toBe("new");
    expect(scoringApiSecret({ SCORING_API_URL: "https://example.test", FUNCTIONS_GAS_SECRET: "old" })).toBe("old");
  });
});
