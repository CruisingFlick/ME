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
    const repo = await request<{ full_name: string; default_branch: string }>(
      "github",
      `${API}/repos/${ref.owner}/${ref.repo}`,
      { headers: this.headers(), retries: 1 },
    );

    const write = await this.canWrite(ref);
    if (!write.allowed) {
      throw new Error(
        `${me.login} can read ${repo.full_name} but the token cannot write to it (${write.detail}). ` +
          `Set the token's Contents permission to "Read and write".`,
      );
    }
    return `${me.login} -> ${repo.full_name} (default ${repo.default_branch}, write confirmed)`;
  }

  /**
   * Prove the token can write, by creating a blob.
   *
   * The repository's `permissions` field is the *account's* access, not the
   * token's, so a read-only fine-grained token on a repo you own still reports
   * `push: true`. Reading it produced a confident green from a token that could
   * not commit a single file - exactly the failure verification exists to catch.
   *
   * A blob nobody references is invisible in the UI and garbage-collected, so
   * this stays side-effect free while testing the permission that actually
   * matters.
   */
  private async canWrite(ref: RepoRef): Promise<{ allowed: boolean; detail: string }> {
    try {
      await request<{ sha: string }>(
        "github",
        `${API}/repos/${ref.owner}/${ref.repo}/git/blobs`,
        {
          method: "POST",
          headers: this.headers(),
          body: { content: "aGl2ZSB3cml0ZSBwcm9iZQ==", encoding: "base64" },
          retries: 0,
        },
      );
      return { allowed: true, detail: "blob write accepted" };
    } catch (err) {
      if (err instanceof IntegrationError) {
        return { allowed: false, detail: `HTTP ${err.status}` };
      }
      return { allowed: false, detail: String(err) };
    }
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

  /** The head of `branch`, or null when the branch does not exist yet. */
  private async branchSha(ref: RepoRef, branch: string): Promise<string | null> {
    try {
      const head = await request<{ object: { sha: string } }>(
        "github",
        `${API}/repos/${ref.owner}/${ref.repo}/git/ref/heads/${branch}`,
        { headers: this.headers(), retries: 1 },
      );
      return head.object.sha;
    } catch (err) {
      if (err instanceof IntegrationError && err.status === 404) return null;
      throw err;
    }
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

  /**
   * Push a whole tree as one commit, via the Git Data API.
   *
   * The contents endpoint commits one file at a time, which would turn a
   * thirteen-file project into thirteen commits and make the branch history
   * useless to whoever reviews it. This builds a tree and commits it once.
   */
  async pushTree(
    ref: RepoRef,
    branch: string,
    files: Array<{ path: string; content: string }>,
    message: string,
  ): Promise<{ commit: string; branch: string }> {
    const base = `${API}/repos/${ref.owner}/${ref.repo}`;
    // Parent on the branch when it is already there, so a second push adds to
    // it rather than replacing it with a commit built on the default branch -
    // which would silently drop every file the first push landed and this one
    // does not mention.
    const parent = (await this.branchSha(ref, branch)) ?? (await this.baseSha(ref));

    const blobs = await Promise.all(
      files.map(async (file) => {
        const blob = await request<{ sha: string }>("github", `${base}/git/blobs`, {
          method: "POST",
          headers: this.headers(),
          body: {
            content: Buffer.from(file.content, "utf8").toString("base64"),
            encoding: "base64",
          },
        });
        return { path: file.path, mode: "100644" as const, type: "blob" as const, sha: blob.sha };
      }),
    );

    const tree = await request<{ sha: string }>("github", `${base}/git/trees`, {
      method: "POST",
      headers: this.headers(),
      body: { base_tree: parent, tree: blobs },
    });

    const commit = await request<{ sha: string }>("github", `${base}/git/commits`, {
      method: "POST",
      headers: this.headers(),
      body: { message, tree: tree.sha, parents: [parent] },
    });

    // Create the branch, or move it if a previous attempt already made it.
    try {
      await request("github", `${base}/git/refs`, {
        method: "POST",
        headers: this.headers(),
        body: { ref: `refs/heads/${branch}`, sha: commit.sha },
        retries: 1,
      });
    } catch (err) {
      if (!(err instanceof IntegrationError) || err.status !== 422) throw err;
      await request("github", `${base}/git/refs/heads/${branch}`, {
        method: "PATCH",
        headers: this.headers(),
        body: { sha: commit.sha, force: true },
      });
    }

    return { commit: commit.sha, branch };
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
