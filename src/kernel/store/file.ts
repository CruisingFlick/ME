import { mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { BoardEntry, LedgerEvent, Message, Task } from "../../types.js";
import type { Store } from "./types.js";

/**
 * Durable run state on the local disk.
 *
 * Postgres is the right answer when several machines share a run, but it is a
 * heavy prerequisite for the common case of one machine building one project.
 * Without this, a run that loses its process loses everything it knew, which
 * makes "resume an interrupted run" impossible for anyone who has not set up a
 * database first - a poor default for a system meant to work unattended.
 */
export class FileStore implements Store {
  readonly kind = "memory" as const; // behaves as a local store, not a shared one
  private readonly dir: string;

  private events: LedgerEvent[] = [];
  private messages = new Map<string, Message>();
  private board = new Map<string, BoardEntry>();
  private tasks = new Map<string, Task>();

  constructor(stateDir: string, runId: string) {
    this.dir = join(stateDir, "state", runId);
  }

  async init(): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    this.events = this.readLines<LedgerEvent>("events.jsonl");
    this.messages = new Map(this.readJson<Message[]>("messages.json", []).map((m) => [m.id, m]));
    this.board = new Map(
      this.readJson<BoardEntry[]>("board.json", []).map((e) => [`${e.runId}:${e.key}`, e]),
    );
    this.tasks = new Map(this.readJson<Task[]>("tasks.json", []).map((t) => [t.id, t]));
  }

  async appendEvent(event: LedgerEvent): Promise<void> {
    this.events.push(event);
    appendFileSync(join(this.dir, "events.jsonl"), JSON.stringify(event) + "\n");
  }

  async listEvents(runId: string): Promise<LedgerEvent[]> {
    return this.events.filter((e) => e.runId === runId);
  }

  async putMessage(message: Message): Promise<void> {
    this.messages.set(message.id, message);
    this.flush("messages.json", [...this.messages.values()]);
  }

  async listMessages(runId: string): Promise<Message[]> {
    return [...this.messages.values()]
      .filter((m) => m.runId === runId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async markRead(_runId: string, messageIds: string[], reader: string): Promise<void> {
    for (const messageId of messageIds) {
      const message = this.messages.get(messageId);
      if (message && !message.readBy.includes(reader)) message.readBy.push(reader);
    }
    this.flush("messages.json", [...this.messages.values()]);
  }

  async putBoard(entry: BoardEntry): Promise<void> {
    this.board.set(`${entry.runId}:${entry.key}`, entry);
    this.flush("board.json", [...this.board.values()]);
  }

  async getBoard(runId: string, key: string): Promise<BoardEntry | null> {
    return this.board.get(`${runId}:${key}`) ?? null;
  }

  async listBoard(runId: string): Promise<BoardEntry[]> {
    return [...this.board.values()].filter((e) => e.runId === runId);
  }

  async putTask(task: Task): Promise<void> {
    this.tasks.set(task.id, task);
    this.flush("tasks.json", [...this.tasks.values()]);
  }

  async listTasks(runId: string): Promise<Task[]> {
    return [...this.tasks.values()]
      .filter((t) => t.runId === runId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async close(): Promise<void> {}

  /**
   * Write through a temporary file and rename.
   *
   * A run killed mid-write is exactly the situation this store exists for, so
   * it must not be the thing that corrupts the state needed to resume.
   */
  private flush(name: string, value: unknown): void {
    const target = join(this.dir, name);
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2));
    renameSync(temporary, target);
  }

  private readJson<T>(name: string, fallback: T): T {
    const path = join(this.dir, name);
    if (!existsSync(path)) return fallback;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  private readLines<T>(name: string): T[] {
    const path = join(this.dir, name);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as T];
        } catch {
          return []; // a torn final line is expected after a kill
        }
      });
  }
}
