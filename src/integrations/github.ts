import { getConfig } from "../config.js";
import { IntegrationError, request } from "./http.js";

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

  /**
   * A token without a repository is not a usable integration - every operation
   * needs both. Reporting it available would send agents down a failure path
   * that has no guidance attached, where inventing a repo name looks plausible.
   */
  available(): boolean {
    return Boolean(this.token && this.defaultRepo());
  }

  unavailableReason(): string | null {
    if (!this.token) return "GITHUB_TOKEN is not set";
    if (!this.defaultRepo()) return "GITHUB_REPO is not set (expected owner/repo)";
    return null;
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
    if (!ref) throw new Error("GITHUB_REPO is not set (expected owner/repo)");
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
    const sha = fromSha ?? (await this.baseSha(ref));
    await request("github", `${API}/repos/${ref.owner}/${ref.repo}/git/refs`, {
      method: "POST",
      headers: this.headers(),
      body: { ref: `refs/heads/${branch}`, sha },
    });
    return branch;
  }

  /**
   * The commit a new branch should start from.
   *
   * A repository created without a README has no commits at all, so its default
   * branch is a name with nothing behind it and every ref lookup 404s. That is
   * the state a fresh destination repo is usually in, so rather than requiring
   * whoever set it up to have remembered a README, give it an initial commit.
   */
  private async baseSha(ref: RepoRef): Promise<string> {
    const repo = await this.getRepo(ref);
    const refUrl = `${API}/repos/${ref.owner}/${ref.repo}/git/ref/heads/${repo.default_branch}`;
    try {
      const head = await request<{ object: { sha: string } }>("github", refUrl, {
        headers: this.headers(),
        retries: 1,
      });
      return head.object.sha;
    } catch (err) {
      if (!(err instanceof IntegrationError) || err.status !== 404) throw err;
    }

    const created = await request<{ commit: { sha: string } }>(
      "github",
      `${API}/repos/${ref.owner}/${ref.repo}/contents/README.md`,
      {
        method: "PUT",
        headers: this.headers(),
        body: {
          message: "hive: initialise repository",
          content: Buffer.from(
            `# ${ref.repo}\n\nProjects built by the hive land here.\n`,
            "utf8",
          ).toString("base64"),
          branch: repo.default_branch,
        },
      },
    );
    return created.commit.sha;
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
