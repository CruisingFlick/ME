import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../config.js";
import { logger } from "../util/log.js";
import { costUsd } from "./pricing.js";
import {
  ProviderError,
  type CompletionRequest,
  type CompletionResult,
  type ContentPart,
  type ModelProvider,
  type StopReason,
  type ToolCall,
  type Turn,
} from "./types.js";

const log = logger("provider:anthropic");

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5";

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic";
  readonly defaultModel = ANTHROPIC_DEFAULT_MODEL;
  private client: Anthropic | null = null;

  available(): boolean {
    const cfg = getConfig();
    // The SDK also resolves an `ant auth login` profile, so an unset key is not
    // proof of no credentials - but for an unattended run we require an explicit
    // key so a missing credential fails at startup, not mid-build.
    return Boolean(cfg.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  }

  unavailableReason(): string | null {
    return this.available() ? null : "ANTHROPIC_API_KEY is not set";
  }

  private get sdk(): Anthropic {
    this.client ??= new Anthropic({ maxRetries: 4, timeout: 15 * 60 * 1000 });
    return this.client;
  }

  /** Lists models rather than sending a message: proves the key, spends nothing. */
  async verify(): Promise<string> {
    const models = await this.sdk.models.list({ limit: 20 });
    const ids = models.data.map((m) => m.id);
    const hasDefault = ids.includes(this.defaultModel);
    return (
      `${ids.length} model(s) available; ` +
      (hasDefault
        ? `${this.defaultModel} is available`
        : `${this.defaultModel} NOT in the list - set a model this key can reach`)
    );
  }

  async complete(model: string, request: CompletionRequest): Promise<CompletionResult> {
    const messages = request.messages.map((turn) => toAnthropicTurn(turn, this.id));
    try {
      // Streaming rather than create(): agent turns routinely run long with a
      // large max_tokens, and a non-streaming request would hit the HTTP timeout.
      const stream = this.sdk.messages.stream({
        model,
        max_tokens: request.maxTokens ?? 32_000,
        system: [
          { type: "text", text: request.system, cache_control: { type: "ephemeral" } },
        ],
        messages,
        ...(request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
              })),
            }
          : {}),
        thinking: { type: "adaptive" },
        output_config: { effort: request.effort ?? "high" },
      });

      const message = await stream.finalMessage();
      return fromAnthropicMessage(model, message);
    } catch (err) {
      throw asProviderError(err);
    }
  }
}

function toAnthropicTurn(turn: Turn, providerId: string): Anthropic.MessageParam {
  // Replay the provider's own blocks when we produced them, so thinking blocks
  // survive the round trip intact.
  if (turn.native?.provider === providerId) {
    return { role: turn.role, content: turn.native.blocks as Anthropic.ContentBlockParam[] };
  }
  const content: Anthropic.ContentBlockParam[] = [];
  for (const part of turn.content) {
    if (part.type === "text") {
      if (part.text.trim().length > 0) content.push({ type: "text", text: part.text });
    } else if (part.type === "tool_call") {
      content.push({ type: "tool_use", id: part.id, name: part.name, input: part.input });
    } else {
      content.push({
        type: "tool_result",
        tool_use_id: part.callId,
        content: part.content,
        ...(part.isError ? { is_error: true } : {}),
      });
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "(no content)" });
  return { role: turn.role, content };
}

function fromAnthropicMessage(model: string, message: Anthropic.Message): CompletionResult {
  const parts: ContentPart[] = [];
  const toolCalls: ToolCall[] = [];
  let text = "";

  for (const block of message.content) {
    if (block.type === "text") {
      text += block.text;
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      const call: ToolCall = {
        id: block.id,
        name: block.name,
        // Tool inputs arrive as parsed JSON; never string-match the raw form.
        input: (block.input ?? {}) as Record<string, unknown>,
      };
      toolCalls.push(call);
      parts.push({ type: "tool_call", ...call });
    }
    // thinking blocks are carried in `native` and never surfaced as text
  }

  const usage = message.usage;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cachedInputTokens = usage.cache_read_input_tokens ?? 0;

  if (message.stop_reason === "refusal") {
    log.warn("model declined the request", {
      category: message.stop_details?.type === "refusal" ? message.stop_details.category : null,
    });
  }

  return {
    text,
    toolCalls,
    stopReason: mapStopReason(message.stop_reason),
    usage: {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      costUsd: costUsd(model, inputTokens, outputTokens, cachedInputTokens),
    },
    native: message.content,
  };
}

function mapStopReason(reason: Anthropic.Message["stop_reason"]): StopReason {
  switch (reason) {
    case "end_turn":
      return "end";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

function asProviderError(err: unknown): ProviderError {
  if (err instanceof Anthropic.APIError) {
    const status = statusOf(err);
    const overloaded = /overloaded/i.test(err.message);
    const retryable =
      overloaded || status === 429 || status >= 500 || err instanceof Anthropic.APIConnectionError;
    // "Overloaded" means the service is busy, not that anything is wrong with
    // the request or the key. Saying so is the difference between waiting a
    // moment and going to regenerate a perfectly good credential.
    const label = overloaded
      ? "anthropic is busy (overloaded); this is transient, retry shortly"
      : `anthropic ${status || "error"}: ${err.message}`;
    return new ProviderError(label, "anthropic", retryable);
  }
  return new ProviderError(`anthropic: ${String(err)}`, "anthropic", false);
}

/**
 * The status is not always on `.status`: an overload arrives as a body with no
 * usable status, which surfaced as a meaningless "anthropic 0:".
 */
function statusOf(err: InstanceType<typeof Anthropic.APIError>): number {
  const direct = err.status;
  if (typeof direct === "number" && direct > 0) return direct;
  const nested = (err as { error?: { status?: number } }).error?.status;
  return typeof nested === "number" ? nested : 0;
}
