import { getConfig } from "../config.js";
import { request } from "./http.js";

const API = "https://console.neon.tech/api/v2";

export interface NeonBranch {
  id: string;
  name: string;
  connectionUri?: string;
}

/**
 * Neon Postgres.
 *
 * Branching is why Neon is worth wiring in for an autonomous swarm: every run
 * gets a database branch of its own, so a migration written by an agent that
 * turns out to be wrong is discarded by deleting the branch, not by restoring a
 * backup. Deleting a branch still requires the db:destructive capability.
 */
export class Neon {
  readonly name = "neon";

  private get key(): string | undefined {
    return getConfig().NEON_API_KEY;
  }

  private get projectId(): string | undefined {
    return getConfig().NEON_PROJECT_ID;
  }

  available(): boolean {
    return Boolean(this.key && this.projectId);
  }

  unavailableReason(): string | null {
    if (!this.key) return "NEON_API_KEY is not set";
    if (!this.projectId) return "NEON_PROJECT_ID is not set";
    return null;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.key}` };
  }

  /** Read-only preflight: does the key open the configured project? */
  async verify(): Promise<string> {
    const result = await request<{ project: { name: string; region_id: string } }>(
      "neon",
      `${API}/projects/${this.projectId}`,
      { headers: this.headers(), retries: 1 },
    );
    const branches = await this.listBranches();
    return `project ${result.project.name} in ${result.project.region_id}, ${branches.length} branch(es)`;
  }

  async createBranch(name: string, parentId?: string): Promise<NeonBranch> {
    const result = await request<{
      branch: { id: string; name: string };
      connection_uris?: Array<{ connection_uri: string }>;
    }>("neon", `${API}/projects/${this.projectId}/branches`, {
      method: "POST",
      headers: this.headers(),
      body: {
        branch: { name, ...(parentId ? { parent_id: parentId } : {}) },
        endpoints: [{ type: "read_write" }],
      },
    });
    return {
      id: result.branch.id,
      name: result.branch.name,
      connectionUri: result.connection_uris?.[0]?.connection_uri,
    };
  }

  async listBranches(): Promise<NeonBranch[]> {
    const result = await request<{ branches: Array<{ id: string; name: string }> }>(
      "neon",
      `${API}/projects/${this.projectId}/branches`,
      { headers: this.headers() },
    );
    return result.branches;
  }

  async connectionUri(branchId: string, database = "neondb", role = "neondb_owner"): Promise<string> {
    const result = await request<{ uri: string }>(
      "neon",
      `${API}/projects/${this.projectId}/connection_uri` +
        `?branch_id=${encodeURIComponent(branchId)}` +
        `&database_name=${encodeURIComponent(database)}` +
        `&role_name=${encodeURIComponent(role)}`,
      { headers: this.headers() },
    );
    return result.uri;
  }

  /** Destructive: gated behind db:destructive at the tool layer. */
  async deleteBranch(branchId: string): Promise<void> {
    await request("neon", `${API}/projects/${this.projectId}/branches/${branchId}`, {
      method: "DELETE",
      headers: this.headers(),
    });
  }
}
