import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { truncate } from "../util/json.js";
import { fail, ok, str, type HiveTool } from "./types.js";

const MAX_READ = 120_000;

/**
 * Filesystem access, confined to the run workspace by the policy engine.
 *
 * Paths are always workspace-relative in the model's view. Absolute host paths
 * are never shown to an agent, both to keep prompts stable across machines and
 * because a path an agent cannot name is a path it cannot try to reach.
 */

export const readFileTool: HiveTool = {
  capability: "fs:read",
  spec: {
    name: "read_file",
    description:
      "Read a UTF-8 file from the project workspace. Paths are relative to the workspace root.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path, e.g. src/server.ts" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  async run(input, context) {
    const resolved = context.policy.resolveInWorkspace(str(input, "path"));
    if (!("path" in resolved)) return fail(resolved.reason);
    try {
      const text = readFileSync(resolved.path, "utf8");
      return ok(truncate(text, MAX_READ));
    } catch (err) {
      return fail(`could not read ${str(input, "path")}: ${String(err)}`);
    }
  },
};

export const writeFileTool: HiveTool = {
  capability: "fs:write",
  spec: {
    name: "write_file",
    description:
      "Create or overwrite a file in the project workspace, creating parent directories as needed. Write the complete file contents; this is not a patch.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path" },
        content: { type: "string", description: "Complete file contents" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  async run(input, context) {
    const path = str(input, "path");
    const content = str(input, "content");
    const resolved = context.policy.resolveInWorkspace(path);
    if (!("path" in resolved)) return fail(resolved.reason);
    try {
      mkdirSync(join(resolved.path, ".."), { recursive: true });
      writeFileSync(resolved.path, content, "utf8");
      await context.ledger.record("tool.call", context.agent.id, {
        tool: "write_file",
        path,
        bytes: Buffer.byteLength(content),
        taskId: context.taskId,
      });
      return ok(`wrote ${path} (${Buffer.byteLength(content)} bytes)`);
    } catch (err) {
      return fail(`could not write ${path}: ${String(err)}`);
    }
  },
};

export const listFilesTool: HiveTool = {
  capability: "fs:read",
  spec: {
    name: "list_files",
    description:
      "List files under a workspace directory, recursively, skipping node_modules and .git.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative directory; defaults to the root" },
      },
      additionalProperties: false,
    },
  },
  async run(input, context) {
    const target = str(input, "path", ".");
    const resolved = context.policy.resolveInWorkspace(target);
    if (!("path" in resolved)) return fail(resolved.reason);
    try {
      const files = walk(resolved.path, context.workspace);
      if (files.length === 0) return ok("(empty)");
      return ok(files.slice(0, 500).join("\n"));
    } catch (err) {
      return fail(`could not list ${target}: ${String(err)}`);
    }
  },
};

const SKIP = new Set(["node_modules", ".git", "dist", ".next", ".hive", "coverage"]);

function walk(dir: string, workspace: string, depth = 0): string[] {
  if (depth > 12) return [];
  let entries: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      entries = entries.concat(walk(full, workspace, depth + 1));
    } else {
      entries.push(`${relative(workspace, full)} (${stats.size}b)`);
    }
  }
  return entries;
}
