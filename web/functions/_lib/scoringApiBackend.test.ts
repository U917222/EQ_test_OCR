import { describe, expect, it } from "vitest";
import { assertScoringApiConfig, canDispatchScoringApi } from "./scoringApiBackend";

describe("scoringApiBackend configuration", () => {
  it("allows the local D1 fallback when both upstream settings are absent", () => {
    expect(() => assertScoringApiConfig({})).not.toThrow();
    expect(canDispatchScoringApi({}, "getResult")).toBe(false);
  });

  it("fails closed when only the upstream URL is configured", () => {
    expect(() => assertScoringApiConfig({ SCORING_API_URL: "https://example.test/api" })).toThrow(
      "must be configured together",
    );
  });

  it("dispatches supported actions when URL and secret are configured", () => {
    const env = {
      SCORING_API_URL: "https://example.test/api",
      SCORING_API_SECRET: "secret",
    };
    expect(() => assertScoringApiConfig(env)).not.toThrow();
    expect(canDispatchScoringApi(env, "getResult")).toBe(true);
    expect(canDispatchScoringApi(env, "listCandidateDocuments")).toBe(true);
    expect(canDispatchScoringApi(env, "uploadCandidateDocument")).toBe(true);
    expect(canDispatchScoringApi(env, "deleteCandidateDocument")).toBe(true);
    expect(canDispatchScoringApi(env, "listEvaluations")).toBe(false);
  });

  it("accepts the legacy secret name during rolling migration", () => {
    const env = {
      SCORING_API_URL: "https://example.test/api",
      FUNCTIONS_GAS_SECRET: "legacy-secret",
    };
    expect(() => assertScoringApiConfig(env)).not.toThrow();
    expect(canDispatchScoringApi(env, "getResult")).toBe(true);
  });
});
