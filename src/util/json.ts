/**
 * Models emit JSON wrapped in prose or fences more often than anyone would like.
 * These helpers recover the payload instead of failing a run over formatting.
 */

export function parseJsonLoose<T = unknown>(raw: string): T {
  const trimmed = raw.trim();
  const attempts = [trimmed, stripFence(trimmed), extractBalanced(trimmed)];
  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // fall through to the next recovery strategy
    }
  }
  throw new Error(
    `could not parse JSON from model output: ${trimmed.slice(0, 200)}`,
  );
}

function stripFence(text: string): string | null {
  const match = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return match?.[1]?.trim() ?? null;
}

/** Pull the first balanced {...} or [...] block, ignoring brackets inside strings. */
function extractBalanced(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Keep the head and tail of long output; models care most about both ends. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.7));
  const tail = text.slice(-Math.floor(max * 0.2));
  const elided = text.length - head.length - tail.length;
  return `${head}\n... [${elided} chars elided] ...\n${tail}`;
}
