import type { BoardEntry } from "../types.js";
import { nowIso } from "../util/id.js";
import { truncate } from "../util/json.js";
import type { Ledger } from "./ledger.js";
import type { Store } from "./store/index.js";

/**
 * Shared long-term memory for a run.
 *
 * Messages are how agents ask each other things; the blackboard is how they
 * agree on things. Anything a later agent must not have to re-derive - the
 * chosen stack, the database schema, the API contract, the deploy URL - is
 * written here under a stable key, versioned so a reader can tell it changed.
 */
export class Blackboard {
  constructor(
    private readonly store: Store,
    private readonly ledger: Ledger,
    private readonly runId: string,
  ) {}

  async put(key: string, value: unknown, author: string): Promise<BoardEntry> {
    const previous = await this.store.getBoard(this.runId, key);
    const entry: BoardEntry = {
      runId: this.runId,
      key,
      value,
      author,
      version: (previous?.version ?? 0) + 1,
      updatedAt: nowIso(),
    };
    await this.store.putBoard(entry);
    await this.ledger.record("board.write", author, {
      key,
      version: entry.version,
      overwrote: previous?.author ?? null,
    });
    return entry;
  }

  async get(key: string): Promise<BoardEntry | null> {
    return this.store.getBoard(this.runId, key);
  }

  async list(): Promise<BoardEntry[]> {
    return this.store.listBoard(this.runId);
  }

  /**
   * A compact view of the board for a prompt. Values are truncated rather than
   * dropped so an agent can still see that a key exists and ask for it in full.
   */
  async render(maxCharsPerEntry = 1200): Promise<string> {
    const entries = await this.list();
    if (entries.length === 0) return "(blackboard is empty)";
    return entries
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((e) => {
        const text = typeof e.value === "string" ? e.value : JSON.stringify(e.value, null, 2);
        return `## ${e.key}  (v${e.version}, by ${e.author})\n${truncate(text, maxCharsPerEntry)}`;
      })
      .join("\n\n");
  }
}
