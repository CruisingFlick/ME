import type { BoardEntry, LedgerEvent, Message, Task } from "../../types.js";
import type { Store } from "./types.js";

export class MemoryStore implements Store {
  readonly kind = "memory" as const;

  private events: LedgerEvent[] = [];
  private messages = new Map<string, Message>();
  private board = new Map<string, BoardEntry>();
  private tasks = new Map<string, Task>();

  async init(): Promise<void> {}

  async appendEvent(event: LedgerEvent): Promise<void> {
    this.events.push(event);
  }

  async listEvents(runId: string): Promise<LedgerEvent[]> {
    return this.events.filter((e) => e.runId === runId);
  }

  async putMessage(message: Message): Promise<void> {
    this.messages.set(message.id, message);
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
  }

  async putBoard(entry: BoardEntry): Promise<void> {
    this.board.set(`${entry.runId}:${entry.key}`, entry);
  }

  async getBoard(runId: string, key: string): Promise<BoardEntry | null> {
    return this.board.get(`${runId}:${key}`) ?? null;
  }

  async listBoard(runId: string): Promise<BoardEntry[]> {
    return [...this.board.values()].filter((e) => e.runId === runId);
  }

  async putTask(task: Task): Promise<void> {
    this.tasks.set(task.id, task);
  }

  async listTasks(runId: string): Promise<Task[]> {
    return [...this.tasks.values()]
      .filter((t) => t.runId === runId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async close(): Promise<void> {}
}
