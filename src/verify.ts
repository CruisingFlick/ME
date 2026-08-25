/**
 * Preflight against the real services.
 *
 * An unattended run that discovers a bad credential in its ship phase has
 * already spent the whole build budget getting there. Every check here is a
 * real network call with no side effect - a list, a read, a whoami - so that
 * "configured" and "actually works" stop being the same claim.
 */
export interface VerifyResult {
  name: string;
  kind: "model" | "service";
  status: "ok" | "failed" | "not_configured" | "unreachable";
  detail: string;
  ms: number;
}

/**
 * Tell a blocked network apart from a bad credential.
 *
 * They look identical from inside - both are a 403 - but the remedies could not
 * be more different: one is a key to reissue, the other is a host to allow. A
 * run that reports "your credential does not work" when the credential was
 * never sent sends someone to regenerate a perfectly good key.
 */
export function isNetworkBlocked(message: string): boolean {
  return /not in allowlist|egress policy|CONNECT tunnel failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|proxy/i.test(
    message,
  );
}

export type Check = () => Promise<string>;

export async function check(
  name: string,
  kind: VerifyResult["kind"],
  configured: boolean,
  reason: string | null,
  probe: Check,
): Promise<VerifyResult> {
  if (!configured) {
    return { name, kind, status: "not_configured", detail: reason ?? "not configured", ms: 0 };
  }
  const started = Date.now();
  try {
    const detail = await probe();
    return { name, kind, status: "ok", detail, ms: Date.now() - started };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name,
      kind,
      status: isNetworkBlocked(message) ? "unreachable" : "failed",
      detail: trim(message),
      ms: Date.now() - started,
    };
  }
}

function trim(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > 180 ? `${oneLine.slice(0, 180)}...` : oneLine;
}
