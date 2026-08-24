import { getConfig } from "../../config.js";
import { logger } from "../../util/log.js";
import { FileStore } from "./file.js";
import { MemoryStore } from "./memory.js";
import { PostgresStore } from "./postgres.js";
import type { Store } from "./types.js";

export type { Store } from "./types.js";
export { FileStore } from "./file.js";
export { MemoryStore } from "./memory.js";
export { PostgresStore } from "./postgres.js";

const log = logger("store");

/**
 * Prefer durable Postgres when a connection string is configured, but never let
 * a database outage stop a run: fall back to memory and say so loudly.
 */
export async function openStore(runId: string, connectionString?: string): Promise<Store> {
  const config = getConfig();
  const url = connectionString ?? config.HIVE_DATABASE_URL;
  if (!url) {
    // Local disk rather than memory, so an interrupted run can still be resumed
    // without anyone having had to set up a database first.
    const store = new FileStore(config.HIVE_STATE_DIR, runId);
    await store.init();
    return store;
  }
  const store = new PostgresStore(url);
  try {
    await store.init();
    log.info("using postgres store");
    return store;
  } catch (err) {
    log.warn("postgres unavailable, falling back to local file store", String(err));
    await store.close().catch(() => {});
    const fallback = new FileStore(config.HIVE_STATE_DIR, runId);
    await fallback.init();
    return fallback;
  }
}
