import { getConfig } from "../config.js";
import { request } from "./http.js";

const API = "https://api.github.com";

export interface RepoRef {
  owner: string;
  repo: string;
}

/** Source of truth for the code the swarm produces. */
export class GitHub {
  readonly name = "github";

  private get token(): string | undefined {
    return getConfig().GITHUB_TOKEN;
  }

  available(): boolean {
    return Boolean(this.token);
  }

  unavailableReason(): string | null {
    return this.available() ? null : "GITHUB_TOKEN is not set";
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      "x-github-api-version": "2022-11-28",
      accept: "application/vnd.github+json",
    };
  }

  defaultRepo(): RepoRef | null {
    const slug = getConfig().GITHUB_REPO;
    if (!slug) return null;
    const [owner, repo] = slug.split("/");
    return owner && repo ? { owner, repo } : null;
  }

  /** Read-only preflight: who are we, and can we see the configured repo? */
  async verify(): Promise<string> {
    const me = await request<{ login: string }>("github", `${API}/user`, {
      headers: this.headers(),
      retries: 1,
    });
    const ref = this.defaultRepo();
    if (!ref) return `authenticated as ${me.login}; GITHUB_REPO not set`;
    const repo = await request<{ full_name: string; default_branch: string; permissions?: { push?: boolean } }>(
      "github",
      `${API}/repos/${ref.owner}/${ref.repo}`,
      { headers: this.headers(), retries: 1 },
    );
    const push = repo.permissions?.push ? "push" : "read-only";
    return `${me.login} -> ${repo.full_name} (default ${repo.default_branch}, ${push})`;
  }

  async getRepo(ref: RepoRef): Promise<{ default_branch: string; html_url: string }> {
    return request("github", `${API}/repos/${ref.owner}/${ref.repo}`, {
      headers: this.headers(),
    });
  }

  async createBranch(ref: RepoRef, branch: string, fromSha?: string): Promise<string> {
    let sha = fromSha;
    if (!sha) {
      const repo = await this.getRepo(ref);
      const head = await request<{ object: { sha: string } }>(
        "github",
        `${API}/repos/${ref.owner}/${ref.repo}/git/ref/heads/${repo.default_branch}`,
        { headers: this.headers() },
      );
      sha = head.object.sha;
    }
    await request("github", `${API}/repos/${ref.owner}/${ref.repo}/git/refs`, {
      method: "POST",
      headers: this.headers(),
      body: { ref: `refs/heads/${branch}`, sha },
    });
    return branch;
  }

  /** Create or update a single file on a branch. */
  async putFile(
    ref: RepoRef,
    path: string,
    content: string,
    message: string,
    branch: string,
  ): Promise<{ commit: string }> {
    const url = `${API}/repos/${ref.owner}/${ref.repo}/contents/${encodeURI(path)}`;
    let sha: string | undefined;
    try {
      const existing = await request<{ sha: string }>(
        "github",
        `${url}?ref=${encodeURIComponent(branch)}`,
        { headers: this.headers(), retries: 0 },
      );
      sha = existing.sha;
    } catch {
      // absent: this is a create, not an update
    }
    const result = await request<{ commit: { sha: string } }>("github", url, {
      method: "PUT",
      headers: this.headers(),
      body: {
        message,
        content: Buffer.from(content, "utf8").toString("base64"),
        branch,
        ...(sha ? { sha } : {}),
      },
    });
    return { commit: result.commit.sha };
  }

  async openPullRequest(
    ref: RepoRef,
    head: string,
    base: string,
    title: string,
    body: string,
  ): Promise<{ number: number; html_url: string }> {
    return request("github", `${API}/repos/${ref.owner}/${ref.repo}/pulls`, {
      method: "POST",
      headers: this.headers(),
      body: { title, head, base, body },
    });
  }

  /** Latest check-run conclusions for a ref, so the swarm can wait on CI. */
  async checks(ref: RepoRef, sha: string): Promise<Array<{ name: string; conclusion: string | null }>> {
    const result = await request<{ check_runs: Array<{ name: string; conclusion: string | null }> }>(
      "github",
      `${API}/repos/${ref.owner}/${ref.repo}/commits/${sha}/check-runs`,
      { headers: this.headers() },
    );
    return result.check_runs;
  }
}
