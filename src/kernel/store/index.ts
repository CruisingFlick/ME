import { getConfig } from "../../config.js";
import { logger } from "../../util/log.js";
import { MemoryStore } from "./memory.js";
import { PostgresStore } from "./postgres.js";
import type { Store } from "./types.js";

export type { Store } from "./types.js";
export { MemoryStore } from "./memory.js";
export { PostgresStore } from "./postgres.js";

const log = logger("store");

/**
 * Prefer durable Postgres when a connection string is configured, but never let
 * a database outage stop a run: fall back to memory and say so loudly.
 */
export async function openStore(connectionString?: string): Promise<Store> {
  const url = connectionString ?? getConfig().HIVE_DATABASE_URL;
  if (!url) {
    const store = new MemoryStore();
    await store.init();
    return store;
  }
  const store = new PostgresStore(url);
  try {
    await store.init();
    log.info("using postgres store");
    return store;
  } catch (err) {
    log.warn("postgres unavailable, falling back to in-memory store", String(err));
    await store.close().catch(() => {});
    const fallback = new MemoryStore();
    await fallback.init();
    return fallback;
  }
}
