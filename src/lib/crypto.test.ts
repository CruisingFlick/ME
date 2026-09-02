/**
 * Session token tests. Run with: npm run test:session
 *
 * These cover the properties that make a stolen or stale cookie useless:
 * the expiry lives inside the signature (so the server enforces it rather than
 * trusting the browser's maxAge), and the version lets an account invalidate
 * every outstanding cookie at once.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

// Set before any signing happens — crypto.ts reads the secret lazily, inside
// each call, so a plain import is fine.
process.env.SESSION_SECRET ??= "test-secret-at-least-sixteen-characters-long";

import {
  hashPassword,
  signSession,
  verifyPassword,
  verifySession,
} from "./crypto";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err instanceof Error ? err.message : String(err)}`);
  }
}

const SUB = "11111111-1111-1111-1111-111111111111";

console.log("\nsession tokens");

test("a fresh token round-trips with its subject and version", () => {
  const s = verifySession(signSession(SUB, 3600, 7));
  assert.ok(s);
  assert.equal(s.sub, SUB);
  assert.equal(s.v, 7);
  assert.ok(s.exp > Math.floor(Date.now() / 1000));
});

test("an expired token is refused even though the signature is valid", () => {
  // Negative TTL — the signature is genuine, only the clock has moved past it.
  const expired = signSession(SUB, -1, 1);
  assert.equal(verifySession(expired), null);
});

test("a token expiring in the future is accepted", () => {
  assert.ok(verifySession(signSession(SUB, 60, 1)));
});

test("a tampered payload is refused", () => {
  const token = signSession(SUB, 3600, 1);
  const [, sig] = token.split(".");
  const forged = Buffer.from(
    JSON.stringify({
      sub: "22222222-2222-2222-2222-222222222222",
      exp: Math.floor(Date.now() / 1000) + 3600,
      v: 1,
    }),
  ).toString("base64url");
  assert.equal(verifySession(`${forged}.${sig}`), null);
});

test("a tampered signature is refused", () => {
  const [body] = signSession(SUB, 3600, 1).split(".");
  assert.equal(verifySession(`${body}.notarealsignature`), null);
});

test("an unsigned payload is refused", () => {
  const body = Buffer.from(
    JSON.stringify({ sub: SUB, exp: Math.floor(Date.now() / 1000) + 3600, v: 1 }),
  ).toString("base64url");
  assert.equal(verifySession(body), null);
});

test("garbage and empty input are refused rather than throwing", () => {
  for (const bad of [undefined, "", ".", "a.b", "not-a-token", "%%%.%%%"]) {
    assert.equal(verifySession(bad as string | undefined), null, `${bad}`);
  }
});

test("a token missing required fields is refused", () => {
  // A validly signed payload that simply isn't a session.
  const raw = JSON.stringify({ hello: "world" });
  const body = Buffer.from(raw).toString("base64url");
  // Sign it the same way the real code would.
  const sig = createHmac("sha256", process.env.SESSION_SECRET!)
    .update(raw)
    .digest("base64url");
  assert.equal(verifySession(`${body}.${sig}`), null);
});

test("the version is what makes revocation possible", () => {
  // The rep row says version 2; a cookie issued at version 1 must not match.
  const oldCookie = verifySession(signSession(SUB, 3600, 1));
  assert.ok(oldCookie);
  assert.notEqual(oldCookie.v, 2, "a stale cookie must be distinguishable");
});

console.log("\npassword hashing");

test("a correct password verifies and a wrong one does not", () => {
  const stored = hashPassword("correct horse battery staple");
  assert.equal(verifyPassword("correct horse battery staple", stored), true);
  assert.equal(verifyPassword("wrong password", stored), false);
});

test("the same password hashes differently each time (salted)", () => {
  assert.notEqual(hashPassword("same"), hashPassword("same"));
});

test("a malformed stored hash is refused rather than throwing", () => {
  for (const bad of ["", "nonsense", "scrypt:onlysalt", "md5:a:b"]) {
    assert.equal(verifyPassword("x", bad), false, bad);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
