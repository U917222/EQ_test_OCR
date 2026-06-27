import { afterEach, describe, expect, it, vi } from "vitest";
import { postToGas, readJsonResponse, type GasEnv } from "./gasClient";
import { createEnvelope } from "./sign";

const env: GasEnv = {
  SCORING_API_URL: "https://scoring.example.test/api",
  FUNCTIONS_GAS_SECRET: "test-secret",
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

describe("gasClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries transient upstream statuses with a fresh nonce", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await postToGas(env, envelope());

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

    const response = await postToGas(env, envelope());

    expect(response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid upstream JSON", async () => {
    await expect(readJsonResponse(new Response("not json", { status: 200 }))).rejects.toThrow("invalid JSON");
  });
});
