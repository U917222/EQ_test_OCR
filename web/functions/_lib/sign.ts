import { HttpError } from "./errors";
import type { Action, Role } from "./roles";

export type EnvelopeAction = Action | "saveCandidateFile";

export interface EnvelopeClaims {
  iss: "cf-functions";
  aud: "gas-api";
  action: EnvelopeAction;
  operator: string;
  role: Role | "unknown";
  operationId: string | null;
  ts: number;
  nonce: string;
}

export interface Envelope {
  claims: EnvelopeClaims;
  payload: Record<string, unknown>;
}

interface EnvelopeInput {
  action: EnvelopeAction;
  operator: string;
  role: Role | "unknown";
  operationId: string | null;
  payload: Record<string, unknown>;
}

export function createEnvelope(input: EnvelopeInput): Envelope {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomHex(16);

  return {
    claims: {
      iss: "cf-functions",
      aud: "gas-api",
      action: input.action,
      operator: input.operator,
      role: input.role,
      operationId: input.operationId,
      ts,
      nonce,
    },
    payload: input.payload,
  };
}

export async function signEnvelope(envelope: Envelope, secret: string): Promise<string> {
  if (!secret) {
    throw new HttpError(500, "internal", "Missing FUNCTIONS_GAS_SECRET");
  }

  const signingInput = `${canonicalJson(envelope.claims)}.${canonicalJson(envelope.payload)}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));

  return `sha256=${bytesToHex(new Uint8Array(signature))}`;
}

export function canonicalJson(value: unknown): string {
  const normalized = normalizeForCanonicalJson(value);
  return stringifyCanonical(normalized);
}

function normalizeForCanonicalJson(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new HttpError(400, "validation", "JSON body contains a non-finite number");
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeForCanonicalJson(item));
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      if (child !== undefined) {
        result[key] = normalizeForCanonicalJson(child);
      }
    }
    return result;
  }

  throw new HttpError(400, "validation", "JSON body contains an unsupported value");
}

function stringifyCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stringifyCanonical(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .map((key) => `${JSON.stringify(key)}:${stringifyCanonical(record[key])}`)
    .join(",")}}`;
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
