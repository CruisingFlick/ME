import { getConfig } from "../config.js";
import { request } from "./http.js";

const API = "https://api.clerk.com/v1";

/**
 * Clerk, for the auth side of a generated app.
 *
 * The swarm uses this to provision the tenancy a new app needs (a JWT template,
 * a first admin user) rather than to manage real end users - hence auth:admin
 * being a separate capability from the rest.
 */
export class Clerk {
  readonly name = "clerk";

  private get key(): string | undefined {
    return getConfig().CLERK_SECRET_KEY;
  }

  available(): boolean {
    return Boolean(this.key);
  }

  unavailableReason(): string | null {
    return this.available() ? null : "CLERK_SECRET_KEY is not set";
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.key}` };
  }

  /** Read-only preflight: list a single user to prove the secret key works. */
  async verify(): Promise<string> {
    const users = await request<Array<unknown>>("clerk", `${API}/users?limit=1`, {
      headers: this.headers(),
      retries: 1,
    });
    const mode = this.key?.startsWith("sk_live") ? "live" : "test";
    return `${mode} instance reachable (${users.length} user sampled)`;
  }

  async listUsers(limit = 10): Promise<Array<{ id: string; email_addresses: unknown[] }>> {
    return request("clerk", `${API}/users?limit=${limit}`, { headers: this.headers() });
  }

  async createUser(email: string, password?: string): Promise<{ id: string }> {
    return request("clerk", `${API}/users`, {
      method: "POST",
      headers: this.headers(),
      body: {
        email_address: [email],
        ...(password ? { password } : { skip_password_requirement: true }),
      },
    });
  }

  async createJwtTemplate(name: string, claims: Record<string, unknown>): Promise<{ id: string }> {
    return request("clerk", `${API}/jwt_templates`, {
      method: "POST",
      headers: this.headers(),
      body: { name, claims, lifetime: 3600 },
    });
  }
}
