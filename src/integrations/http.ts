import { truncate } from "../util/json.js";

export class IntegrationError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
    message: string,
  ) {
    super(`${service} ${status}: ${message}`);
    this.name = "IntegrationError";
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Retry on 429 and 5xx this many times, with exponential backoff. */
  retries?: number;
  timeoutMs?: number;
}

/**
 * One HTTP path for every integration, so retry, timeout and error shape are
 * identical whichever vendor is on the other end. An unattended run cannot ask
 * anyone what to do about a flaky 502, so transient failures are absorbed here.
 */
export async function request<T>(
  service: string,
  url: string,
  options: RequestOptions = {},
): Promise<T> {
  const retries = options.retries ?? 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await sleep(Math.min(2 ** attempt * 500, 8000));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
    try {
      const response = await fetch(url, {
        method: options.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
          ...options.headers,
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
      });

      if (response.status === 429 || response.status >= 500) {
        lastError = new IntegrationError(
          service,
          response.status,
          truncate(await response.text().catch(() => ""), 300),
        );
        continue;
      }
      if (!response.ok) {
        throw new IntegrationError(
          service,
          response.status,
          truncate(await response.text().catch(() => ""), 500),
        );
      }
      if (response.status === 204) return undefined as T;
      const text = await response.text();
      return (text.length > 0 ? JSON.parse(text) : undefined) as T;
    } catch (err) {
      if (err instanceof IntegrationError && err.status < 500 && err.status !== 429) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new IntegrationError(service, 0, "request failed");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
