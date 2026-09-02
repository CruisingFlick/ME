import type { TriagePriority } from "@/db/schema";

/**
 * Pure, network-free half of triage. Kept out of `triage.ts` so it can be
 * tested directly — that module is marked `server-only` because it holds the
 * API client, and `server-only` refuses to load outside a server component.
 */

export type RawVerdict = {
  request_id: string;
  summary: string;
  priority: TriagePriority;
};

export type TriageVerdict = {
  requestId: string;
  summary: string;
  priority: TriagePriority;
};

/**
 * Matches model verdicts back to the requests we sent.
 *
 * The ids come back through the model, and the prompt contains customer-written
 * text, so a returned id is a claim — not a key to write against. Anything that
 * isn't one of the ids we just fetched for this rep is dropped, and a duplicate
 * id only counts once. Without this, text a customer typed could steer a write
 * onto a different rep's request.
 */
export function reconcile(
  verdicts: RawVerdict[],
  requests: { id: string }[],
): TriageVerdict[] {
  const allowed = new Set(requests.map((r) => r.id));
  const seen = new Set<string>();
  const out: TriageVerdict[] = [];

  for (const v of verdicts) {
    if (!allowed.has(v.request_id) || seen.has(v.request_id)) continue;
    seen.add(v.request_id);
    out.push({
      requestId: v.request_id,
      summary: v.summary.trim().slice(0, 1000),
      priority: v.priority,
    });
  }

  return out;
}
