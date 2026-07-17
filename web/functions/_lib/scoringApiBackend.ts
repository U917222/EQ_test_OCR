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

// D1 is the source of truth since the 2026-07-01 cutover (see d1Backend.ts, which
// implements every Action independently). Nothing is dispatched upstream today:
// SCORING_API_URL is always present as a plain var, so configuring SCORING_API_SECRET
// (required to satisfy assertScoringApiConfig below and avoid a hard 500) must never by
// itself resurrect the pre-cutover Sheets-backed dispatch. Only add an action here
// alongside an explicit, reviewed decision to route that action upstream again.
const SCORING_API_ACTIONS = new Set<Action>([]);

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
