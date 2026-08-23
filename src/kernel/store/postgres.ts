import pg from "pg";
import type { BoardEntry, LedgerEvent, Message, Task } from "../../types.js";
import type { Store } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hive_event (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  type        TEXT NOT NULL,
  actor       TEXT NOT NULL,
  at          TIMESTAMPTZ NOT NULL,
  data        JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS hive_event_run_idx ON hive_event (run_id, at);

CREATE TABLE IF NOT EXISTS hive_message (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  sender      TEXT NOT NULL,
  recipient   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  thread_id   TEXT NOT NULL,
  task_id     TEXT,
  created_at  TIMESTAMPTZ NOT NULL,
  read_by     TEXT[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS hive_message_run_idx ON hive_message (run_id, created_at);

CREATE TABLE IF NOT EXISTS hive_board (
  run_id      TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       JSONB NOT NULL,
  author      TEXT NOT NULL,
  version     INTEGER NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (run_id, key)
);

CREATE TABLE IF NOT EXISTS hive_task (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS hive_task_run_idx ON hive_task (run_id, created_at);
`;

/**
 * Neon-backed store. Neon is serverless Postgres, so the pool is kept small and
 * connections are allowed to go idle rather than being held open for the run.
 */
export class PostgresStore implements Store {
  readonly kind = "postgres" as const;
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      max: 4,
      idleTimeoutMillis: 10_000,
      ssl: connectionString.includes("localhost") ? undefined : { rejectUnauthorized: true },
    });
  }

  async init(): Promise<void> {
    await this.pool.query(SCHEMA);
  }

  async appendEvent(event: LedgerEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO hive_event (id, run_id, type, actor, at, data)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [event.id, event.runId, event.type, event.actor, event.at, JSON.stringify(event.data)],
    );
  }

  async listEvents(runId: string): Promise<LedgerEvent[]> {
    const { rows } = await this.pool.query(
      `SELECT id, run_id, type, actor, at, data FROM hive_event WHERE run_id = $1 ORDER BY at`,
      [runId],
    );
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      type: r.type,
      actor: r.actor,
      at: new Date(r.at).toISOString(),
      data: r.data,
    }));
  }

  async putMessage(message: Message): Promise<void> {
    await this.pool.query(
      `INSERT INTO hive_message
         (id, run_id, sender, recipient, kind, subject, body, thread_id, task_id, created_at, read_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET read_by = EXCLUDED.read_by`,
      [
        message.id, message.runId, message.from, message.to, message.kind,
        message.subject, message.body, message.threadId, message.taskId ?? null,
        message.createdAt, message.readBy,
      ],
    );
  }

  async listMessages(runId: string): Promise<Message[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM hive_message WHERE run_id = $1 ORDER BY created_at`,
      [runId],
    );
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      from: r.sender,
      to: r.recipient,
      kind: r.kind,
      subject: r.subject,
      body: r.body,
      threadId: r.thread_id,
      taskId: r.task_id ?? undefined,
      createdAt: new Date(r.created_at).toISOString(),
      readBy: r.read_by ?? [],
    }));
  }

  async markRead(runId: string, messageIds: string[], reader: string): Promise<void> {
    if (messageIds.length === 0) return;
    await this.pool.query(
      `UPDATE hive_message
          SET read_by = array_append(read_by, $3)
        WHERE run_id = $1 AND id = ANY($2) AND NOT ($3 = ANY(read_by))`,
      [runId, messageIds, reader],
    );
  }

  async putBoard(entry: BoardEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO hive_board (run_id, key, value, author, version, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (run_id, key) DO UPDATE
         SET value = EXCLUDED.value, author = EXCLUDED.author,
             version = EXCLUDED.version, updated_at = EXCLUDED.updated_at`,
      [entry.runId, entry.key, JSON.stringify(entry.value), entry.author, entry.version, entry.updatedAt],
    );
  }

  async getBoard(runId: string, key: string): Promise<BoardEntry | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM hive_board WHERE run_id = $1 AND key = $2`,
      [runId, key],
    );
    const row = rows[0];
    return row ? this.toBoard(row) : null;
  }

  async listBoard(runId: string): Promise<BoardEntry[]> {
    const { rows } = await this.pool.query(`SELECT * FROM hive_board WHERE run_id = $1`, [runId]);
    return rows.map((r) => this.toBoard(r));
  }

  private toBoard(row: Record<string, any>): BoardEntry {
    return {
      runId: row.run_id,
      key: row.key,
      value: row.value,
      author: row.author,
      version: row.version,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  async putTask(task: Task): Promise<void> {
    await this.pool.query(
      `INSERT INTO hive_task (id, run_id, payload, created_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`,
      [task.id, task.runId, JSON.stringify(task), task.createdAt],
    );
  }

  async listTasks(runId: string): Promise<Task[]> {
    const { rows } = await this.pool.query(
      `SELECT payload FROM hive_task WHERE run_id = $1 ORDER BY created_at`,
      [runId],
    );
    return rows.map((r) => r.payload as Task);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
