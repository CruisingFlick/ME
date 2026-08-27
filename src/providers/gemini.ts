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
 * Google Gemini over the Generative Language API.
 *
 * Gemini's function-call ids are positional rather than server-assigned, so
 * calls are keyed by name and matched back to results by order within a turn.
 */
export class GeminiProvider implements ModelProvider {
  readonly id = "gemini";
  // `|| `, not `?? `: an override left blank in .env is an empty string, not
  // undefined, so `??` would pass "" through as the model id and every call
  // would 404 saying nothing useful. Blanking the line is the obvious thing to
  // do when an id goes stale, so it has to mean "use the default".
  //
  // Google retires model ids for new accounts while keeping them alive for
  // existing ones, so a default that works here can 404 for someone setting up
  // today - which is exactly how this failed: "no longer available to new
  // users", against a perfectly good key, twice, before anyone read the message.
  readonly defaultModel = process.env.GEMINI_MODEL?.trim() || "gemini-3.1-pro-preview";
  private readonly base =
    process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta";

  available(): boolean {
    return Boolean(getConfig().GEMINI_API_KEY);
  }

  unavailableReason(): string | null {
    return this.available() ? null : "GEMINI_API_KEY is not set";
  }

  async verify(): Promise<string> {
    const key = getConfig().GEMINI_API_KEY;
    const response = await fetch(`${this.base}/models`, { headers: { "x-goog-api-key": key ?? "" } });
    if (!response.ok) {
      throw new Error(`${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const json = (await response.json()) as { models?: Array<{ name: string }> };
    // Gemini reports model names as "models/<id>".
    const ids = json.models?.map((m) => m.name.replace(/^models\//, "")) ?? [];
    return ids.includes(this.defaultModel)
      ? `${ids.length} model(s); ${this.defaultModel} is available`
      : `${ids.length} model(s), but GEMINI_MODEL "${this.defaultModel}" is not among them`;
  }

  async complete(model: string, request: CompletionRequest): Promise<CompletionResult> {
    const key = getConfig().GEMINI_API_KEY;
    if (!key) throw new ProviderError("GEMINI_API_KEY is not set", this.id, false);

    const body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: request.messages.map(toGeminiContent),
      ...(request.tools.length > 0
        ? {
            tools: [
              {
                functionDeclarations: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: stripUnsupported(tool.inputSchema),
                })),
              },
            ],
          }
        : {}),
      generationConfig: { maxOutputTokens: request.maxTokens ?? 32_000 },
    };

    const response = await fetch(`${this.base}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ProviderError(
        `gemini ${response.status}: ${detail.slice(0, 400)}`,
        this.id,
        response.status === 429 || response.status >= 500,
      );
    }

    const json = (await response.json()) as GeminiResponse;
    const candidate = json.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    let text = "";
    const toolCalls: ToolCall[] = [];
    parts.forEach((part, index) => {
      if (part.text) text += part.text;
      if (part.functionCall) {
        toolCalls.push({
          id: `${part.functionCall.name}_${index}`,
          name: part.functionCall.name,
          input: (part.functionCall.args ?? {}) as Record<string, unknown>,
        });
      }
    });

    const usage = json.usageMetadata;
    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = usage?.candidatesTokenCount ?? 0;
    const cachedInputTokens = usage?.cachedContentTokenCount ?? 0;

    return {
      text,
      toolCalls,
      stopReason: toolCalls.length > 0 ? "tool_use" : mapFinish(candidate?.finishReason),
      usage: {
        inputTokens,
        outputTokens,
        cachedInputTokens,
        costUsd: (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15,
      },
    };
  }
}

interface GeminiResponse {
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string; functionCall?: { name: string; args?: unknown } }> };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

function toGeminiContent(turn: Turn): Record<string, unknown> {
  const parts: Array<Record<string, unknown>> = [];
  for (const part of turn.content) {
    if (part.type === "text") {
      if (part.text.trim().length > 0) parts.push({ text: part.text });
    } else if (part.type === "tool_call") {
      parts.push({ functionCall: { name: part.name, args: part.input } });
    } else {
      parts.push({
        functionResponse: {
          // The call id carries the tool name as its prefix; recover it so the
          // response is matched to the right declaration.
          name: part.callId.replace(/_\d+$/, ""),
          response: { result: part.content, error: part.isError ?? false },
        },
      });
    }
  }
  if (parts.length === 0) parts.push({ text: "(no content)" });
  return { role: turn.role === "assistant" ? "model" : "user", parts };
}

/** Gemini rejects several JSON Schema keywords the other providers accept. */
function stripUnsupported(schema: Record<string, unknown>): Record<string, unknown> {
  const drop = new Set(["$schema", "additionalProperties", "default", "examples", "const"]);
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node)) {
        if (drop.has(key)) continue;
        out[key] = walk(value);
      }
      return out;
    }
    return node;
  };
  return walk(schema) as Record<string, unknown>;
}

function mapFinish(reason: string | undefined): StopReason {
  switch (reason) {
    case "STOP":
      return "end";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "PROHIBITED_CONTENT":
      return "refusal";
    default:
      return "other";
  }
}
