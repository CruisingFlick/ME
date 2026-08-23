import { describe, expect, it } from "vitest";
import { check } from "../src/verify.js";

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
