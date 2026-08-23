import type { BoardEntry, LedgerEvent, Message, Task } from "../../types.js";

/**
 * Every durable thing the hive knows sits behind this one interface, so a run
 * can execute entirely in memory (tests, dry runs) or against Neon Postgres
 * (real runs that must survive a process restart) with no other code changing.
 */
export interface Store {
  readonly kind: "memory" | "postgres";
  init(): Promise<void>;

  appendEvent(event: LedgerEvent): Promise<void>;
  listEvents(runId: string): Promise<LedgerEvent[]>;

  putMessage(message: Message): Promise<void>;
  listMessages(runId: string): Promise<Message[]>;
  markRead(runId: string, messageIds: string[], reader: string): Promise<void>;

  putBoard(entry: BoardEntry): Promise<void>;
  getBoard(runId: string, key: string): Promise<BoardEntry | null>;
  listBoard(runId: string): Promise<BoardEntry[]>;

  putTask(task: Task): Promise<void>;
  listTasks(runId: string): Promise<Task[]>;

  close(): Promise<void>;
}
