import { randomUUID } from "node:crypto";

/** Short, sortable-ish id with a human-readable prefix. */
export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
