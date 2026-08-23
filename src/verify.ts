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
  status: "ok" | "failed" | "not_configured";
  detail: string;
  ms: number;
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
    return {
      name,
      kind,
      status: "failed",
      detail: trim(err instanceof Error ? err.message : String(err)),
      ms: Date.now() - started,
    };
  }
}

function trim(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > 180 ? `${oneLine.slice(0, 180)}...` : oneLine;
}
