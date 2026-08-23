const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

export function setLogLevel(level: Level): void {
  threshold = LEVELS[level];
}

const ESC = String.fromCharCode(27);
const COLOR: Record<Level, string> = {
  debug: `${ESC}[90m`,
  info: `${ESC}[36m`,
  warn: `${ESC}[33m`,
  error: `${ESC}[31m`,
};
const RESET = `${ESC}[0m`;

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const stamp = new Date().toISOString().slice(11, 23);
  const tint = process.stderr.isTTY ? COLOR[level] : "";
  const off = process.stderr.isTTY ? RESET : "";
  let line = `${tint}${stamp} ${level.padEnd(5)} [${scope}]${off} ${msg}`;
  if (extra !== undefined) line += ` ${safe(extra)}`;
  process.stderr.write(line + "\n");
}

function safe(value: unknown): string {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > 600 ? text.slice(0, 600) + "..." : text;
  } catch {
    return String(value);
  }
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
  child(scope: string): Logger;
}

export function logger(scope: string): Logger {
  return {
    debug: (m, e) => emit("debug", scope, m, e),
    info: (m, e) => emit("info", scope, m, e),
    warn: (m, e) => emit("warn", scope, m, e),
    error: (m, e) => emit("error", scope, m, e),
    child: (sub) => logger(`${scope}:${sub}`),
  };
}
