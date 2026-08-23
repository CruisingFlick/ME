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

  async send(to: string, subject: string, text: string): Promise<{ id: string }> {
    return request("resend", `${API}/emails`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.key}` },
      body: { from: getConfig().RESEND_FROM, to: [to], subject, text },
    });
  }
}
