import { getConfig } from "../config.js";
import { request } from "./http.js";

const API = "https://api.resend.com";

/**
 * Resend, for transactional email.
 *
 * This is the one integration that reaches a human, which makes it the one
 * worth being conservative about: email:send is a distinct capability, and the
 * operator agent uses it for run outcomes, not for anything the built app does.
 */
export class Resend {
  readonly name = "resend";

  private get key(): string | undefined {
    return getConfig().RESEND_API_KEY;
  }

  available(): boolean {
    return Boolean(this.key && getConfig().RESEND_FROM);
  }

  unavailableReason(): string | null {
    if (!this.key) return "RESEND_API_KEY is not set";
    if (!getConfig().RESEND_FROM) return "RESEND_FROM is not set";
    return null;
  }

  /**
   * Read-only preflight. Deliberately lists domains rather than sending a test
   * message: a verification step must never itself reach a person's inbox.
   */
  async verify(): Promise<string> {
    const result = await request<{ data?: Array<{ name: string; status: string }> }>(
      "resend",
      `${API}/domains`,
      { headers: { authorization: `Bearer ${this.key}` }, retries: 1 },
    );
    const domains = result.data ?? [];
    const from = getConfig().RESEND_FROM ?? "";
    const sender = from.split("@")[1];
    const match = domains.find((d) => d.name === sender);
    if (!sender) return `key valid, ${domains.length} domain(s); RESEND_FROM has no domain`;
    return match
      ? `key valid; sending domain ${sender} is ${match.status}`
      : `key valid, but ${sender} is not a verified domain on this account`;
  }

  async send(to: string, subject: string, text: string): Promise<{ id: string }> {
    return request("resend", `${API}/emails`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.key}` },
      body: { from: getConfig().RESEND_FROM, to: [to], subject, text },
    });
  }
}
