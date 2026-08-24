import { AnthropicProvider } from "./anthropic.js";
import { ClaudeCliProvider } from "./claude-cli.js";
import { CliProvider } from "./cli.js";
import { GeminiProvider } from "./gemini.js";
import { MockProvider } from "./mock.js";
import { OpenAIProvider } from "./openai.js";
import type { ModelProvider } from "./types.js";

/**
 * Every brain the hive can recruit, keyed by id.
 *
 * The CLI entries are the "Claude Code / Codex / Gemini CLI" members: they are
 * real agents in their own right, so the hive treats them as consultants rather
 * than as gated workers (see CliProvider for why).
 */
export function buildRegistry(): Map<string, ModelProvider> {
  const providers: ModelProvider[] = [
    new AnthropicProvider(),
    new OpenAIProvider(),
    new GeminiProvider(),
    new MockProvider(),
    // The claude CLI gets a purpose-built adapter because it can do the work
    // itself; the others are text-only consultants.
    new ClaudeCliProvider(),
    new CliProvider({
      id: "codex",
      binary: "codex",
      args: ["exec", "--skip-git-repo-check", "-"],
      promptOnStdin: true,
    }),
    new CliProvider({
      id: "gemini-cli",
      binary: "gemini",
      args: ["-p", "{PROMPT}"],
    }),
  ];
  return new Map(providers.map((p) => [p.id, p]));
}

export class ProviderRegistry {
  private readonly providers: Map<string, ModelProvider>;

  constructor(providers?: Map<string, ModelProvider>) {
    this.providers = providers ?? buildRegistry();
  }

  get(id: string): ModelProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new Error(
        `unknown provider "${id}"; known: ${[...this.providers.keys()].join(", ")}`,
      );
    }
    return provider;
  }

  register(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
  }

  /** Providers with working credentials, in preference order. */
  availableIds(): string[] {
    return [...this.providers.values()].filter((p) => p.available()).map((p) => p.id);
  }

  all(): ModelProvider[] {
    return [...this.providers.values()];
  }

  /**
   * Pick a provider different from `avoid` where possible.
   *
   * Cross-vendor review is the main reason this system is multi-model at all:
   * model families share failure modes with themselves far more than with each
   * other, so a reviewer from a different family catches what a same-family
   * reviewer waves through. When no second vendor is configured, we fall back
   * to the same one and the run report says the review was same-family.
   */
  pickContrasting(avoid: string, candidates: string[] = ["anthropic", "openai", "gemini"]): string {
    const usable = candidates.filter((id) => {
      const provider = this.providers.get(id);
      return provider?.available() ?? false;
    });
    return usable.find((id) => id !== avoid) ?? usable[0] ?? avoid;
  }
}
