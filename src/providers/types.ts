import type { Usage } from "../types.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12 subset) describing the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; callId: string; content: string; isError?: boolean };

export interface Turn {
  role: "user" | "assistant";
  content: ContentPart[];
  /**
   * Provider-native content blocks for this turn, kept verbatim.
   *
   * Some providers require their own blocks to be replayed unchanged - notably
   * Anthropic thinking blocks, which must be echoed back on the same model. The
   * normalised `content` above is lossy by design, so the original is carried
   * alongside it and used only by the provider that produced it.
   */
  native?: { provider: string; blocks: unknown };
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface CompletionRequest {
  system: string;
  messages: Turn[];
  tools: ToolSpec[];
  maxTokens?: number;
  effort?: Effort;
}

export interface CompletionResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: Usage;
  /** Native blocks for the assistant turn, to be replayed on the next request. */
  native?: unknown;
}

export interface ModelProvider {
  readonly id: string;
  readonly defaultModel: string;
  /** True when credentials (or a local binary) are actually present. */
  available(): boolean;
  /** Why it is unavailable, for the run report. */
  unavailableReason(): string | null;
  complete(model: string, request: CompletionRequest): Promise<CompletionResult>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
