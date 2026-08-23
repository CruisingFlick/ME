import { readFileSync } from "node:fs";
import { getConfig } from "../config.js";
import { fail, ok, str, strArray, type HiveTool, type ToolContext } from "./types.js";

/**
 * Tools that reach outside the workspace.
 *
 * Each one names the capability it needs, so the difference between "ship to a
 * preview" and "ship to production" is a grant written down before the run
 * rather than a judgement an agent makes at 3am with nobody watching.
 */

function unavailable(service: { available(): boolean; unavailableReason(): string | null; name: string }) {
  return service.available()
    ? null
    : fail(
        `${service.name} is not configured: ${service.unavailableReason()}. ` +
          `Do not fabricate a result - record the gap on the blackboard and continue with what is available.`,
      );
}

async function audit(
  context: ToolContext,
  service: string,
  operation: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await context.ledger.record("integration.call", context.agent.id, {
    service,
    operation,
    taskId: context.taskId,
    ...detail,
  });
}

export const githubPushTool: HiveTool = {
  capability: "github:write",
  spec: {
    name: "github_push_files",
    description:
      "Commit workspace files to a branch on the configured GitHub repository, creating the branch if needed. Pass the workspace-relative paths to include.",
    inputSchema: {
      type: "object",
      properties: {
        branch: { type: "string", description: "Target branch name" },
        paths: { type: "array", items: { type: "string" }, description: "Workspace-relative files" },
        message: { type: "string", description: "Commit message" },
      },
      required: ["branch", "paths", "message"],
      additionalProperties: false,
    },
  },
  async run(input, context) {
    const gate = unavailable(context.integrations.github);
    if (gate) return gate;

    const github = context.integrations.github;
    const repo = github.defaultRepo();
    if (!repo) return fail("GITHUB_REPO is not set (expected owner/repo)");

    const branch = str(input, "branch");
    const paths = strArray(input, "paths");
    if (paths.length === 0) return fail("no paths given");

    try {
      await github.createBranch(repo, branch).catch(() => branch); // already exists is fine
      const commits: string[] = [];
      for (const path of paths) {
        const resolved = context.policy.resolveInWorkspace(path);
        if (!("path" in resolved)) return fail(resolved.reason);
        const content = readFileSync(resolved.path, "utf8");
        const result = await github.putFile(repo, path, content, str(input, "message"), branch);
        commits.push(result.commit);
      }
      await audit(context, "github", "push_files", { branch, files: paths.length });
      return ok(
        `pushed ${paths.length} file(s) to ${repo.owner}/${repo.repo}@${branch}; head ${commits.at(-1)?.slice(0, 8)}`,
      );
    } catch (err) {
      return fail(`github push failed: ${String(err)}`);
    }
  },
};

export const githubPullRequestTool: HiveTool = {
  capability: "github:write",
  spec: {
    name: "github_open_pull_request",
    description: "Open a pull request from a branch into the repository's default branch.",
    inputSchema: {
      type: "object",
      properties: {
        branch: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["branch", "title", "body"],
      additionalProperties: false,
    },
  },
  async run(input, context) {
    const gate = unavailable(context.integrations.github);
    if (gate) return gate;
    const github = context.integrations.github;
    const repo = github.defaultRepo();
    if (!repo) return fail("GITHUB_REPO is not set (expected owner/repo)");
    try {
      const info = await github.getRepo(repo);
      const pr = await github.openPullRequest(
        repo,
        str(input, "branch"),
        info.default_branch,
        str(input, "title"),
        str(input, "body"),
      );
      await audit(context, "github", "open_pull_request", { number: pr.number });
      return ok(`opened PR #${pr.number}: ${pr.html_url}`);
    } catch (err) {
      return fail(`could not open pull request: ${String(err)}`);
    }
  },
};

export const neonBranchTool: HiveTool = {
  capability: "db:write",
  spec: {
    name: "neon_create_branch",
    description:
      "Create a Neon Postgres branch for this run and return its connection URI. Use a branch rather than the primary database so a bad migration can be thrown away.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Branch name" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  async run(input, context) {
    const gate = unavailable(context.integrations.neon);
    if (gate) return gate;
    try {
      const branch = await context.integrations.neon.createBranch(str(input, "name"));
      const uri = branch.connectionUri ?? (await context.integrations.neon.connectionUri(branch.id));
      // The URI carries a password: it goes on the blackboard for other agents,
      // but the ledger records only that it was created.
      await context.board.put(
        "infra.database",
        { provider: "neon", branchId: branch.id, branchName: branch.name, connectionUri: uri },
        context.agent.id,
      );
      await audit(context, "neon", "create_branch", { branchId: branch.id });
      return ok(
        `created Neon branch ${branch.name} (${branch.id}); connection URI published to blackboard key infra.database`,
      );
    } catch (err) {
      return fail(`neon branch failed: ${String(err)}`);
    }
  },
};

export const railwayVariablesTool: HiveTool = {
  capability: "deploy:preview",
  spec: {
    name: "railway_set_variables",
    description:
      "Set environment variables on a Railway service. Pass values as a JSON object of name to value.",
    inputSchema: {
      type: "object",
      properties: {
        service_id: { type: "string" },
        variables: { type: "string", description: "JSON object of NAME to value" },
      },
      required: ["service_id", "variables"],
      additionalProperties: false,
    },
  },
  async run(input, context) {
    const gate = unavailable(context.integrations.railway);
    if (gate) return gate;
    let variables: Record<string, string>;
    try {
      variables = JSON.parse(str(input, "variables")) as Record<string, string>;
    } catch {
      return fail("variables must be a JSON object of NAME to value");
    }
    try {
      const count = await context.integrations.railway.setVariables(
        str(input, "service_id"),
        variables,
      );
      // Names only: values are secrets and the ledger is written to disk.
      await audit(context, "railway", "set_variables", { names: Object.keys(variables) });
      return ok(`set ${count} variable(s) on ${str(input, "service_id")}`);
    } catch (err) {
      return fail(`railway variables failed: ${String(err)}`);
    }
  },
};

export const railwayDeployTool: HiveTool = {
  capability: "deploy:production",
  spec: {
    name: "railway_deploy",
    description:
      "Trigger a Railway deployment of a service. This affects a running environment; only call it once the integrator has reported a green build.",
    inputSchema: {
      type: "object",
      properties: {
        service_id: { type: "string" },
        commit_sha: { type: "string" },
      },
      required: ["service_id"],
      additionalProperties: false,
    },
  },
  async run(input, context) {
    const gate = unavailable(context.integrations.railway);
    if (gate) return gate;
    try {
      await context.integrations.railway.deploy(
        str(input, "service_id"),
        str(input, "commit_sha", ""),
      );
      const latest = await context.integrations.railway.latestDeployment(str(input, "service_id"));
      await audit(context, "railway", "deploy", { status: latest?.status ?? "unknown" });
      return ok(`deploy triggered; latest deployment status: ${latest?.status ?? "unknown"}`);
    } catch (err) {
      return fail(`railway deploy failed: ${String(err)}`);
    }
  },
};

export const clerkProvisionTool: HiveTool = {
  capability: "auth:admin",
  spec: {
    name: "clerk_create_jwt_template",
    description:
      "Create a Clerk JWT template so the generated app can authenticate requests against its own claims.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        claims: { type: "string", description: "JSON object of claims" },
      },
      required: ["name", "claims"],
      additionalProperties: false,
    },
  },
  async run(input, context) {
    const gate = unavailable(context.integrations.clerk);
    if (gate) return gate;
    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(str(input, "claims")) as Record<string, unknown>;
    } catch {
      return fail("claims must be a JSON object");
    }
    try {
      const template = await context.integrations.clerk.createJwtTemplate(str(input, "name"), claims);
      await audit(context, "clerk", "create_jwt_template", { id: template.id });
      return ok(`created Clerk JWT template ${template.id}`);
    } catch (err) {
      return fail(`clerk provisioning failed: ${String(err)}`);
    }
  },
};

export const resendNotifyTool: HiveTool = {
  capability: "email:send",
  spec: {
    name: "resend_send_email",
    description:
      "Send an email through Resend. This is the only tool that reaches a person; use it for run outcomes and nothing else.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        text: { type: "string" },
      },
      required: ["to", "subject", "text"],
      additionalProperties: false,
    },
  },
  async run(input, context) {
    const gate = unavailable(context.integrations.resend);
    if (gate) return gate;
    const to = str(input, "to", getConfig().NOTIFY_EMAIL ?? "");
    if (!to) return fail("no recipient given and NOTIFY_EMAIL is not set");
    try {
      const result = await context.integrations.resend.send(
        to,
        str(input, "subject"),
        str(input, "text"),
      );
      await audit(context, "resend", "send_email", { id: result.id, to });
      return ok(`sent email ${result.id} to ${to}`);
    } catch (err) {
      return fail(`resend failed: ${String(err)}`);
    }
  },
};
