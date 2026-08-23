import { getConfig } from "../config.js";
import {
  ProviderError,
  type CompletionRequest,
  type CompletionResult,
  type ModelProvider,
  type StopReason,
  type ToolCall,
  type Turn,
} from "./types.js";

/**
 * OpenAI (GPT / Codex) over the Chat Completions API.
 *
 * Raw fetch rather than the vendor SDK: this adapter needs perhaps 2% of that
 * package's surface, and the hive already carries one SDK. Model ids are read
 * from the environment rather than hardcoded, because vendor naming moves
 * faster than this file will.
 */
export class OpenAIProvider implements ModelProvider {
  readonly id = "openai";
  readonly defaultModel = process.env.OPENAI_MODEL ?? "gpt-5";
  private readonly endpoint =
    process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1/chat/completions";

  available(): boolean {
    return Boolean(getConfig().OPENAI_API_KEY);
  }

  unavailableReason(): string | null {
    return this.available() ? null : "OPENAI_API_KEY is not set";
  }

  async verify(): Promise<string> {
    const key = getConfig().OPENAI_API_KEY;
    const base = this.endpoint.replace(/\/chat\/completions$/, "");
    const response = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!response.ok) {
      throw new Error(`${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const json = (await response.json()) as { data?: Array<{ id: string }> };
    const ids = json.data?.map((m) => m.id) ?? [];
    return ids.includes(this.defaultModel)
      ? `${ids.length} model(s); ${this.defaultModel} is available`
      : `${ids.length} model(s), but OPENAI_MODEL "${this.defaultModel}" is not among them`;
  }

  async complete(model: string, request: CompletionRequest): Promise<CompletionResult> {
    const key = getConfig().OPENAI_API_KEY;
    if (!key) throw new ProviderError("OPENAI_API_KEY is not set", this.id, false);

    const body = {
      model,
      messages: [{ role: "system", content: request.system }, ...request.messages.flatMap(toOpenAiTurns)],
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
          }
        : {}),
      max_completion_tokens: request.maxTokens ?? 32_000,
    };

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ProviderError(
        `openai ${response.status}: ${detail.slice(0, 400)}`,
        this.id,
        response.status === 429 || response.status >= 500,
      );
    }

    const json = (await response.json()) as OpenAiResponse;
    const choice = json.choices?.[0];
    const toolCalls: ToolCall[] =
      choice?.message?.tool_calls?.map((call) => ({
        id: call.id,
        name: call.function.name,
        input: safeParse(call.function.arguments),
      })) ?? [];

    const usage = json.usage;
    const inputTokens = usage?.prompt_tokens ?? 0;
    const outputTokens = usage?.completion_tokens ?? 0;
    const cachedInputTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;

    return {
      text: choice?.message?.content ?? "",
      toolCalls,
      stopReason: mapFinish(choice?.finish_reason),
      usage: {
        inputTokens,
        outputTokens,
        cachedInputTokens,
        // Priced conservatively: this table only knows Anthropic rates, and an
        // under-priced model would defeat the run's spend cap.
        costUsd: (inputTokens / 1_000_000) * 5 + (outputTokens / 1_000_000) * 25,
      },
    };
  }
}

interface OpenAiResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

function toOpenAiTurns(turn: Turn): Array<Record<string, unknown>> {
  const results = turn.content.filter((p) => p.type === "tool_result");
  const others = turn.content.filter((p) => p.type !== "tool_result");
  const out: Array<Record<string, unknown>> = [];

  // Tool results are their own messages in this API, not blocks inside a turn.
  for (const part of results) {
    if (part.type !== "tool_result") continue;
    out.push({ role: "tool", tool_call_id: part.callId, content: part.content });
  }

  const text = others
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  const calls = others.filter((p) => p.type === "tool_call");

  if (turn.role === "assistant" && calls.length > 0) {
    out.push({
      role: "assistant",
      content: text || null,
      tool_calls: calls.map((part) =>
        part.type === "tool_call"
          ? {
              id: part.id,
              type: "function",
              function: { name: part.name, arguments: JSON.stringify(part.input) },
            }
          : null,
      ),
    });
  } else if (text.trim().length > 0) {
    out.push({ role: turn.role, content: text });
  }

  return out;
}

function mapFinish(reason: string | undefined): StopReason {
  switch (reason) {
    case "stop":
      return "end";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
