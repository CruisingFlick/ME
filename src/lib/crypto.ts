import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      "SESSION_SECRET is missing or too short. Set a random 32+ character string (see .env.example).",
    );
  }
  return s;
}

/** scrypt password hashing — no native dependency, works on Vercel's Node runtime. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, expected] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const derived = scryptSync(password, salt, 64);
  const expectedBuf = Buffer.from(expected, "hex");
  if (derived.length !== expectedBuf.length) return false;
  return timingSafeEqual(derived, expectedBuf);
}

function mac(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/**
 * Sessions are a signed payload rather than a DB row: there is no session table
 * to garbage-collect, and it survives serverless cold starts for free.
 *
 * The payload carries its own expiry and a version number, both inside the
 * signature. `maxAge` on the cookie is only a hint to the browser — a copied
 * cookie value would otherwise be valid forever, with no way to revoke it. The
 * server checks `exp` on every request, and compares `v` against the account's
 * current session version so a password change or a "log out everywhere" can
 * invalidate outstanding cookies.
 */
export type SessionToken = {
  /** Subject — the rep or customer id. */
  sub: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
  /** Session version this token was issued under. */
  v: number;
};

export function signSession(sub: string, ttlSeconds: number, version = 1): string {
  const payload: SessionToken = {
    sub,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    v: version,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(JSON.stringify(payload))}`;
}

/**
 * Verifies the signature and the expiry. Returns null for anything that fails —
 * a tampered token, an unparseable one, or one that has simply run out.
 * Checking the version is the caller's job, since it needs the account row.
 */
export function verifySession(token: string | undefined): SessionToken | null {
  if (!token) return null;

  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  let raw: string;
  try {
    raw = Buffer.from(body, "base64url").toString();
  } catch {
    return null;
  }

  const expected = mac(raw);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as SessionToken).sub !== "string" ||
    typeof (parsed as SessionToken).exp !== "number" ||
    typeof (parsed as SessionToken).v !== "number"
  ) {
    return null;
  }

  const session = parsed as SessionToken;

  // The whole point: an old cookie is refused by the server, not just dropped
  // by a cooperative browser.
  if (session.exp <= Math.floor(Date.now() / 1000)) return null;

  return session;
}

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "rep";
}
