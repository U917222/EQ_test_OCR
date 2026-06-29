import { HttpError } from "./errors";

interface AccessJwtEnv {
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  MVP_OPERATOR_EMAIL?: string;
  ALLOW_INSECURE_DEV_AUTH?: string;
  APP_ACCESS_PASSWORD?: string;
  APP_ACCESS_EMAIL?: string;
}

interface JwksCacheEntry {
  fetchedAt: number;
  keys: JsonWebKey[];
}

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface JwtClaims {
  aud?: string | string[];
  email?: string;
  exp?: number;
  [key: string]: unknown;
}

export interface VerifiedAccessJwt {
  email: string;
  claims: JwtClaims;
}

const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;
const jwksCache = new Map<string, JwksCacheEntry>();

export async function verifyAccessJwt(
  request: Request,
  env: AccessJwtEnv,
): Promise<VerifiedAccessJwt> {
  const sharedPassword = env.APP_ACCESS_PASSWORD?.trim();
  if (sharedPassword && (await sharedPasswordMatches(request, sharedPassword))) {
    const email = env.APP_ACCESS_EMAIL?.trim() || env.MVP_OPERATOR_EMAIL?.trim() || "operator@example.com";
    return { email, claims: { email, auth: "shared-password" } };
  }

  const bypassEmail = env.MVP_OPERATOR_EMAIL?.trim();
  if (bypassEmail && envFlag(env.ALLOW_INSECURE_DEV_AUTH)) {
    return { email: bypassEmail, claims: { email: bypassEmail } };
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    throw new HttpError(401, "unauthorized", "Missing Cloudflare Access JWT");
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new HttpError(401, "unauthorized", "Invalid Cloudflare Access JWT");
  }

  const header = decodeJwtPart<JwtHeader>(parts[0]);
  const claims = decodeJwtPart<JwtClaims>(parts[1]);

  if (header.alg !== "RS256" || !header.kid) {
    throw new HttpError(401, "unauthorized", "Unsupported Cloudflare Access JWT");
  }

  assertAudience(claims, env.CF_ACCESS_AUD);
  assertNotExpired(claims);

  const verified = await verifySignature(env.CF_ACCESS_TEAM_DOMAIN, header.kid, parts);
  if (!verified) {
    throw new HttpError(401, "unauthorized", "Invalid Cloudflare Access JWT signature");
  }

  if (typeof claims.email !== "string" || claims.email.trim() === "") {
    throw new HttpError(401, "unauthorized", "Cloudflare Access JWT does not include email");
  }

  return {
    email: claims.email,
    claims,
  };
}

function requestPassword(request: Request): string {
  const header = request.headers.get("X-App-Password")?.trim();
  if (header) return header;

  const cookie = request.headers.get("Cookie") ?? "";
  const match = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("cheq_app_password="));
  if (!match) return "";

  try {
    return decodeURIComponent(match.slice("cheq_app_password=".length));
  } catch {
    return "";
  }
}

async function sharedPasswordMatches(request: Request, expected: string): Promise<boolean> {
  const supplied = requestPassword(request);
  if (!supplied) return false;

  const encoder = new TextEncoder();
  const [suppliedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);

  return bytesEqual(new Uint8Array(suppliedHash), new Uint8Array(expectedHash));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}

function envFlag(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

function decodeJwtPart<T>(part: string): T {
  try {
    const json = new TextDecoder().decode(base64UrlToBytes(part));
    return JSON.parse(json) as T;
  } catch {
    throw new HttpError(401, "unauthorized", "Invalid Cloudflare Access JWT");
  }
}

async function verifySignature(
  teamDomain: string,
  kid: string,
  parts: string[],
): Promise<boolean> {
  const signingInput = `${parts[0]}.${parts[1]}`;
  const signature = base64UrlToBytes(parts[2]);
  const key = await findVerificationKey(teamDomain, kid, false);

  if (key && (await verifyWithKey(key, signingInput, signature))) {
    return true;
  }

  const refreshedKey = await findVerificationKey(teamDomain, kid, true);
  return refreshedKey ? verifyWithKey(refreshedKey, signingInput, signature) : false;
}

async function findVerificationKey(
  teamDomain: string,
  kid: string,
  forceRefresh: boolean,
): Promise<CryptoKey | null> {
  const keys = await getJwks(teamDomain, forceRefresh);
  const jwk = keys.find((candidate) => (candidate as JsonWebKey & { kid?: string }).kid === kid);
  if (!jwk) {
    return null;
  }

  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

async function getJwks(teamDomain: string, forceRefresh: boolean): Promise<JsonWebKey[]> {
  const normalized = normalizeTeamDomain(teamDomain);
  const cached = jwksCache.get(normalized);
  const now = Date.now();
  if (!forceRefresh && cached && now - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cached.keys;
  }

  const response = await fetch(`https://${normalized}/cdn-cgi/access/certs`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new HttpError(401, "unauthorized", "Unable to fetch Cloudflare Access JWKS");
  }

  const body = await response.json();
  if (!isJwks(body)) {
    throw new HttpError(401, "unauthorized", "Invalid Cloudflare Access JWKS");
  }

  jwksCache.set(normalized, { fetchedAt: now, keys: body.keys });
  return body.keys;
}

function normalizeTeamDomain(teamDomain: string): string {
  if (typeof teamDomain !== "string") {
    throw new HttpError(500, "internal", "Missing CF_ACCESS_TEAM_DOMAIN");
  }

  const normalized = teamDomain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");

  if (!normalized) {
    throw new HttpError(500, "internal", "Missing CF_ACCESS_TEAM_DOMAIN");
  }

  return normalized;
}

function assertAudience(claims: JwtClaims, expectedAudience: string): void {
  if (typeof expectedAudience !== "string" || expectedAudience.trim() === "") {
    throw new HttpError(500, "internal", "Missing CF_ACCESS_AUD");
  }

  const normalizedExpectedAudience = expectedAudience.trim();
  const audience = claims.aud;
  const matches =
    typeof audience === "string"
      ? audience === normalizedExpectedAudience
      : Array.isArray(audience) && audience.includes(normalizedExpectedAudience);

  if (!matches) {
    throw new HttpError(401, "unauthorized", "Cloudflare Access JWT audience mismatch");
  }
}

function assertNotExpired(claims: JwtClaims): void {
  const exp = claims.exp;
  if (typeof exp !== "number") {
    throw new HttpError(401, "unauthorized", "Cloudflare Access JWT is missing exp");
  }

  if (Math.floor(Date.now() / 1000) >= exp) {
    throw new HttpError(401, "unauthorized", "Cloudflare Access JWT is expired");
  }
}

async function verifyWithKey(
  key: CryptoKey,
  signingInput: string,
  signature: Uint8Array,
): Promise<boolean> {
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature as BufferSource,
    new TextEncoder().encode(signingInput) as BufferSource,
  );
}

function isJwks(value: unknown): value is { keys: JsonWebKey[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { keys?: unknown }).keys)
  );
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
