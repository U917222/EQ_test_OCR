import { HttpError } from "./errors";
import { postToGas, readJsonResponse, type GasEnv } from "./gasClient";
import { createEnvelope } from "./sign";
import type { Action } from "./roles";

type JsonBody = Record<string, unknown>;

export interface GasDispatchEnv extends GasEnv {}

const GAS_ACTIONS = new Set<Action>([
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

export function canDispatchGas(env: Partial<GasDispatchEnv>, action: Action): env is GasDispatchEnv {
  return Boolean((env.SCORING_API_URL || env.GAS_API_URL) && env.FUNCTIONS_GAS_SECRET && GAS_ACTIONS.has(action));
}

export async function dispatchGas(
  env: GasDispatchEnv,
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
  const upstream = await postToGas(env, envelope);
  const body = await readJsonResponse(upstream);
  if (!isRecord(body)) {
    throw new HttpError(502, "upstream", "GAS returned an invalid API response");
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
