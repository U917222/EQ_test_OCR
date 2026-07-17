import { HttpError } from "./errors";
import {
  postToScoringApi,
  readJsonResponse,
  scoringApiSecret,
  type ScoringApiEnv,
} from "./scoringApiClient";
import { createEnvelope } from "./sign";
import type { Action } from "./roles";

type JsonBody = Record<string, unknown>;

export interface ScoringApiDispatchEnv extends ScoringApiEnv {}

const SCORING_API_ACTIONS = new Set<Action>([
  "me",
  "listCandidates",
  "getDashboard",
  "getCells",
  "getResult",
  "registerCandidate",
  "attachScoresheet",
  "updateCandidate",
  "saveCells",
  "updateStatus",
  "deleteCandidate",
  "finalize",
  "saveDecision",
]);

export function assertScoringApiConfig(env: Partial<ScoringApiDispatchEnv>): void {
  const hasUrl = Boolean(env.SCORING_API_URL);
  const hasSecret = Boolean(scoringApiSecret(env));
  if (hasUrl !== hasSecret) {
    throw new HttpError(
      500,
      "internal",
      "SCORING_API_URL and SCORING_API_SECRET must be configured together",
    );
  }
}

export function canDispatchScoringApi(
  env: Partial<ScoringApiDispatchEnv>,
  action: Action,
): env is ScoringApiDispatchEnv {
  return Boolean(env.SCORING_API_URL && scoringApiSecret(env) && SCORING_API_ACTIONS.has(action));
}

export async function dispatchScoringApi(
  env: ScoringApiDispatchEnv,
  action: Action,
  email: string,
  payload: JsonBody,
): Promise<Response> {
  const envelope = createEnvelope({
    action,
    operator: email,
    role: "unknown",
    operationId: operationIdFrom(payload),
    payload,
  });
  const upstream = await postToScoringApi(env, envelope);
  const body = await readJsonResponse(upstream);
  if (!isRecord(body)) {
    throw new HttpError(502, "upstream", "scoring-api returned an invalid API response");
  }

  return new Response(JSON.stringify(body), {
    status: upstream.ok ? 200 : upstream.status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function operationIdFrom(payload: JsonBody): string | null {
  const value = payload.operationId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
