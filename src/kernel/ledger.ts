import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LedgerEvent, LedgerEventType } from "../types.js";
import { id, nowIso } from "../util/id.js";
import { logger } from "../util/log.js";
import type { Store } from "./store/index.js";

const log = logger("ledger");

/**
 * Append-only record of everything that happened in a run.
 *
 * With no human watching, the ledger is the only account of what the swarm did,
 * so writes are best-effort-durable in two places: the store, and a JSONL file
 * you can `tail -f` while a run is in flight.
 */
export class Ledger {
  private readonly jsonlPath: string;

  constructor(
    private readonly store: Store,
    private readonly runId: string,
    stateDir: string,
  ) {
    this.jsonlPath = join(stateDir, "runs", `${runId}.jsonl`);
    mkdirSync(dirname(this.jsonlPath), { recursive: true });
  }

  async record(
    type: LedgerEventType,
    actor: string,
    data: Record<string, unknown> = {},
  ): Promise<LedgerEvent> {
    const event: LedgerEvent = {
      id: id("ev"),
      runId: this.runId,
      type,
      actor,
      at: nowIso(),
      data,
    };
    try {
      appendFileSync(this.jsonlPath, JSON.stringify(event) + "\n");
    } catch (err) {
      log.warn("could not write ledger file", String(err));
    }
    try {
      await this.store.appendEvent(event);
    } catch (err) {
      log.warn("could not persist ledger event", String(err));
    }
    return event;
  }

  async history(): Promise<LedgerEvent[]> {
    return this.store.listEvents(this.runId);
  }

  get path(): string {
    return this.jsonlPath;
  }
}
