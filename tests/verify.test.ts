import { describe, expect, it } from "vitest";
import { check, exerciseProvider } from "../src/verify.js";

describe("credential checks", () => {
  it("reports an unconfigured service without calling it", async () => {
    let called = false;
    const result = await check("neon", "service", false, "NEON_API_KEY is not set", async () => {
      called = true;
      return "unreachable";
    });

    expect(result.status).toBe("not_configured");
    expect(result.detail).toBe("NEON_API_KEY is not set");
    expect(called).toBe(false);
  });

  it("reports a working credential with the probe's own description", async () => {
    const result = await check("github", "service", true, null, async () => "you -> owner/repo");
    expect(result.status).toBe("ok");
    expect(result.detail).toBe("you -> owner/repo");
  });

  it("distinguishes a credential that is set but does not work", async () => {
    // The case that matters: `doctor` would call this "available", because the
    // variable is present. Only a real call finds out it is a dead token.
    const result = await check("github", "service", true, null, async () => {
      throw new Error("github 401: Bad credentials");
    });

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("401");
  });

  it("collapses a sprawling error into one readable line", async () => {
    const result = await check("railway", "service", true, null, async () => {
      throw new Error(`line one\n   line two\n\n${"x".repeat(400)}`);
    });

    expect(result.detail).not.toContain("\n");
    expect(result.detail.length).toBeLessThanOrEqual(183);
  });
});

describe("telling apart the reasons a check can fail", () => {
  it("classifies an overloaded service as busy, not broken", async () => {
    // A busy API and a bad key both arrive as an error. Calling the first one
    // "your credential does not work" sends someone to regenerate a good key.
    const result = await check("anthropic", "model", true, null, async () => {
      throw new Error(
        '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      );
    });

    expect(result.status).toBe("busy");
  });

  it.each([
    "rate_limit_error: too many requests",
    "HTTP 529 temporarily unavailable",
  ])("classifies %j as busy", async (message) => {
    const result = await check("anthropic", "model", true, null, async () => {
      throw new Error(message);
    });
    expect(result.status).toBe("busy");
  });

  it("still calls a genuine credential failure a failure", async () => {
    const result = await check("anthropic", "model", true, null, async () => {
      throw new Error("authentication_error: invalid x-api-key");
    });

    expect(result.status).toBe("failed");
  });

  it("does not confuse a blocked host with a busy one", async () => {
    const result = await check("neon", "service", true, null, async () => {
      throw new Error("Host not in allowlist: console.neon.tech");
    });

    expect(result.status).toBe("unreachable");
  });
});

describe("driving a model end to end", () => {
  const usage = { costUsd: 0.0017 };

  it("fails a model that is billed but answers nothing", async () => {
    // gpt-5 is a reasoning model, and the probe's 64-token ceiling went
    // entirely to reasoning: 2.4 seconds, $0.0017, no text - reported as ok.
    // The one thing --deep exists to prove is that the model can be driven, and
    // in a run an empty answer is worse than a loud failure: a reviewer that
    // returns no text renders no verdict, and no verdict is request_changes.
    const silent = {
      id: "quiet",
      defaultModel: "m",
      complete: async () => ({ text: "   ", usage }),
    };

    await expect(exerciseProvider(silent as never)).rejects.toThrow(/returned no text/);
  });

  it("gives a reasoning model room to think before it answers", async () => {
    let ceiling = 0;
    const reasoner = {
      id: "thinker",
      defaultModel: "m",
      complete: async (_model: string, request: { maxTokens: number }) => {
        ceiling = request.maxTokens;
        return { text: "READY", usage };
      },
    };

    const summary = await exerciseProvider(reasoner as never);
    expect(ceiling).toBeGreaterThanOrEqual(1024);
    expect(summary).toContain("READY");
    expect(summary).toContain("$0.0017");
  });
});
