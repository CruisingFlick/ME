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
  status: "ok" | "failed" | "not_configured" | "unreachable" | "busy";
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
/**
 * A service that is temporarily busy is not a broken credential.
 *
 * An overloaded API returns an error like any other, and calling that "your
 * credential does not work" sends someone to regenerate a key that was fine -
 * the same mistake as blaming a blocked network on the credential.
 */
export function isTransientlyBusy(message: string): boolean {
  return /overloaded|rate.?limit|too many requests|\b429\b|\b503\b|\b529\b|temporarily unavailable/i.test(
    message,
  );
}

export function isNetworkBlocked(message: string): boolean {
  return /not in allowlist|egress policy|CONNECT tunnel failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|proxy/i.test(
    message,
  );
}

export type Check = () => Promise<string>;

/**
 * Prove a model provider can actually be driven, not merely that it is present.
 *
 * The shallow check asks the CLI for its version, which proves a binary exists
 * on PATH and nothing else. A change to how the process is spawned broke a run
 * between dispatching a task and the first model call - with the version check
 * still passing perfectly. This exercises the exact path a run uses: the same
 * spawn, the same argument shape, the same response parsing.
 */
export async function exerciseProvider(
  provider: {
    id: string;
    defaultModel: string;
    complete(model: string, request: never): Promise<{ text: string; usage: { costUsd: number } }>;
  },
  model?: string,
): Promise<string> {
  const request = {
    system: "You are a connectivity probe. Answer with one word and nothing else.",
    messages: [{ role: "user", content: [{ type: "text", text: "Reply with the word READY." }] }],
    tools: [],
    // Room for a reasoning model to think before it answers. At 64 the whole
    // ceiling went to reasoning tokens on gpt-5: billed, timed, and empty - and
    // reported as ok, which is the one thing this check exists to catch.
    maxTokens: 2048,
    effort: "low",
  } as never;

  const started = Date.now();
  const result = await provider.complete(model ?? provider.defaultModel, request);
  const elapsed = Date.now() - started;
  const cost = result.usage.costUsd > 0 ? `, $${result.usage.costUsd.toFixed(4)}` : "";
  const reply = result.text.trim().slice(0, 40);
  // An empty answer is a failure, not a pass. A reviewer that returns no text
  // renders no verdict, and a missing verdict is request_changes - so a
  // provider that silently answers nothing would never approve any work.
  if (!reply) {
    throw new Error(
      `the model was driven and billed${cost} but returned no text - ` +
        `it cannot render a verdict or a plan in this state`,
    );
  }
  return `answered in ${elapsed}ms${cost}: ${JSON.stringify(reply)}`;
}

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
      status: isNetworkBlocked(message)
        ? "unreachable"
        : isTransientlyBusy(message)
          ? "busy"
          : "failed",
      detail: trim(message),
      ms: Date.now() - started,
    };
  }
}

function trim(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > 180 ? `${oneLine.slice(0, 180)}...` : oneLine;
}
