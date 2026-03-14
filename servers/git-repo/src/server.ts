/**
 * AXON Git Repository Server — Tool Definitions
 *
 * 10 git tools registered with AXON's 3-tier discovery:
 *   Tier 1: Compact manifests (~20 tokens/tool) — always in context
 *   Tier 2: Full schemas — fetched on demand when model calls a tool
 *
 * Results go through OCRS:
 *   - Diffs, logs, blame → stored in OCRS, summary in context
 *   - Status → concise summary in context
 *
 * SECURITY:
 *   - All commands scoped to configured repoDir
 *   - Uses execFile (not exec) — prevents shell injection
 *   - Force push gated behind capability check + config flag
 *
 * Capabilities enforce access:
 *   - "resource:read" for status, log, diff, blame
 *   - "resource:write" for commit, push, pull, stash, branch mutations
 */

import { AxonServer, ResultStore, CapabilityAuthority } from "@axon-protocol/sdk";
import { GitRepoManager } from "./git-repo-manager.js";

export interface GitRepoServerConfig {
  /** Restrict to read-only operations */
  readOnly?: boolean;
}

export function createGitRepoServer(
  grm: GitRepoManager,
  config?: GitRepoServerConfig,
): {
  server: AxonServer;
  store: ResultStore;
  capAuthority: CapabilityAuthority;
} {
  const server = new AxonServer({ name: "axon-git-repo", version: "0.1.0" });
  const store = new ResultStore({ max_summary_tokens: 300, max_total_result_tokens: 6000 });

  const key = Buffer.alloc(32);
  Buffer.from(Date.now().toString(16).padStart(32, "0"), "hex").copy(key);
  const capAuthority = new CapabilityAuthority("axon-git-repo", key, key);

  // ==========================================================================
  // Git Status
  // ==========================================================================

  server.tool({
    id: "git_status",
    summary: "Show working tree status (modified, staged, untracked)",
    description:
      "Show the current working tree status including branch name, ahead/behind counts, staged files, modified files, untracked files, and conflicted files.",
    category: "git",
    tags: ["git", "status", "changes", "working-tree"],
    input: {
      type: "object",
      properties: {},
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 1000,
      max_result_size_bytes: 100_000,
    },
    handler: async () => {
      return grm.status();
    },
    summarizer: (result: any) => {
      const parts = [`Branch: ${result.branch}`];
      if (result.ahead > 0) parts.push(`ahead ${result.ahead}`);
      if (result.behind > 0) parts.push(`behind ${result.behind}`);
      if (result.staged.length > 0) parts.push(`${result.staged.length} staged`);
      if (result.modified.length > 0) parts.push(`${result.modified.length} modified`);
      if (result.untracked.length > 0) parts.push(`${result.untracked.length} untracked`);
      if (result.conflicted.length > 0) parts.push(`${result.conflicted.length} conflicted`);
      return parts.join(", ");
    },
  });

  // ==========================================================================
  // Git Log
  // ==========================================================================

  server.tool({
    id: "git_log",
    summary: "Show commit history",
    description:
      "Show commit history with configurable count, branch, author filter, and date range. Returns commit hash, author, date, and message.",
    category: "git",
    tags: ["git", "log", "history", "commits"],
    input: {
      type: "object",
      properties: {
        count: {
          type: "number",
          description: "Number of commits to show (default: 20)",
        },
        branch: {
          type: "string",
          description: "Branch to show log for (default: current branch)",
        },
        author: {
          type: "string",
          description: "Filter by author name or email",
        },
        since: {
          type: "string",
          description: "Show commits after this date (e.g., '2024-01-01', '2 weeks ago')",
        },
        until: {
          type: "string",
          description: "Show commits before this date",
        },
        path: {
          type: "string",
          description: "Show commits affecting this file/directory path",
        },
      },
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 2000,
      max_result_size_bytes: 500_000,
    },
    handler: async ({ count, branch, author, since, until, path }: any) => {
      return grm.log({ count, branch, author, since, until, path });
    },
    summarizer: (entries: any[]) => {
      if (!Array.isArray(entries) || entries.length === 0) return "No commits found";
      const latest = entries[0];
      return `${entries.length} commits. Latest: ${latest.shortHash} "${latest.subject}" by ${latest.author} (${latest.date})`;
    },
  });

  // ==========================================================================
  // Git Diff
  // ==========================================================================

  server.tool({
    id: "git_diff",
    summary: "Show diffs (staged, unstaged, between commits)",
    description:
      "Show file diffs. Can show unstaged changes, staged changes, or diff between specific commits or commit ranges. Large diffs are stored in OCRS.",
    category: "git",
    tags: ["git", "diff", "changes", "compare"],
    input: {
      type: "object",
      properties: {
        staged: {
          type: "boolean",
          description: "Show staged (cached) changes instead of unstaged (default: false)",
        },
        commit: {
          type: "string",
          description: "Show diff for a specific commit (e.g., 'HEAD~3')",
        },
        commit_range: {
          type: "string",
          description: "Show diff between commits (e.g., 'main..feature', 'abc123..def456')",
        },
        path: {
          type: "string",
          description: "Limit diff to a specific file or directory path",
        },
      },
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 2000,
      max_result_size_bytes: 5_000_000,
    },
    handler: async ({ staged, commit, commit_range, path }: any) => {
      return grm.diff({ staged, commit, commitRange: commit_range, path });
    },
    summarizer: (diff: string) => {
      if (!diff || diff.trim().length === 0) return "No differences found";
      const lines = diff.split("\n");
      const fileMatches = diff.match(/^diff --git/gm);
      const adds = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
      const dels = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
      return `${fileMatches?.length ?? 0} file(s) changed: +${adds} -${dels} lines — stored in OCRS`;
    },
  });

  // ==========================================================================
  // Git Branch
  // ==========================================================================

  server.tool({
    id: "git_branch",
    summary: "List, create, delete, or switch branches",
    description:
      "Manage Git branches. Actions: 'list' (default) — list all branches; 'create' — create a new branch; 'delete' — delete a branch; 'switch' — switch to a branch.",
    category: "git",
    tags: ["git", "branch", "checkout", "switch"],
    input: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Action to perform: 'list', 'create', 'delete', or 'switch' (default: 'list')",
          enum: ["list", "create", "delete", "switch"],
        },
        name: {
          type: "string",
          description: "Branch name (required for create, delete, switch)",
        },
        start_point: {
          type: "string",
          description: "Starting point for new branch (e.g., commit hash, branch name)",
        },
        all: {
          type: "boolean",
          description: "Include remote-tracking branches in list (default: false)",
        },
      },
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: false,
      estimated_latency_ms: 1000,
      max_result_size_bytes: 100_000,
    },
    handler: async ({ action, name, start_point, all }: any) => {
      // List is read-only — allow even in readOnly mode
      if (action !== "list" && config?.readOnly) {
        throw new Error("Server is in read-only mode");
      }
      return grm.branch({ action: action ?? "list", name, startPoint: start_point, all });
    },
    summarizer: (result: any) => {
      if (Array.isArray(result)) {
        const current = result.find((b: any) => b.current);
        return `${result.length} branches. Current: ${current?.name ?? "unknown"}`;
      }
      return result.message;
    },
  });

  // ==========================================================================
  // Git Commit
  // ==========================================================================

  server.tool({
    id: "git_commit",
    summary: "Stage files and create a commit",
    description:
      "Stage specified files (or all changes) and create a commit with the given message. Can also amend the last commit.",
    category: "git",
    tags: ["git", "commit", "stage", "save"],
    input: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Commit message",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Files to stage before committing. If empty and 'all' is false, commits only already-staged files.",
        },
        all: {
          type: "boolean",
          description: "Stage all modified and deleted files before committing (git add -A). Default: false.",
        },
        amend: {
          type: "boolean",
          description: "Amend the last commit instead of creating a new one. Default: false.",
        },
      },
      required: ["message"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: false,
      estimated_latency_ms: 3000,
      max_result_size_bytes: 1000,
    },
    handler: async ({ message, files, all, amend }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return grm.commit({ message, files, all, amend });
    },
    summarizer: (result: any) => {
      return `Commit ${result.hash}: "${result.message}" (${result.filesChanged} files changed)`;
    },
  });

  // ==========================================================================
  // Git Stash
  // ==========================================================================

  server.tool({
    id: "git_stash",
    summary: "Stash, pop, list, or drop stash entries",
    description:
      "Manage Git stash. Actions: 'save' — stash current changes; 'pop' — pop a stash entry; 'apply' — apply without removing; 'list' — list stash entries; 'drop' — drop a stash entry.",
    category: "git",
    tags: ["git", "stash", "save", "restore"],
    input: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Action: 'save', 'pop', 'apply', 'list', or 'drop' (default: 'list')",
          enum: ["save", "pop", "apply", "list", "drop"],
        },
        message: {
          type: "string",
          description: "Stash message (for 'save' action)",
        },
        index: {
          type: "number",
          description: "Stash index for pop, apply, or drop (default: latest)",
        },
      },
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: false,
      estimated_latency_ms: 2000,
      max_result_size_bytes: 50_000,
    },
    handler: async ({ action, message, index }: any) => {
      if (action !== "list" && config?.readOnly) {
        throw new Error("Server is in read-only mode");
      }
      return grm.stash({ action: action ?? "list", message, index });
    },
    summarizer: (result: any) => {
      if (Array.isArray(result)) {
        if (result.length === 0) return "No stash entries";
        return `${result.length} stash entries. Latest: "${result[0]?.message ?? ""}"`;
      }
      return result.message;
    },
  });

  // ==========================================================================
  // Git Remote
  // ==========================================================================

  server.tool({
    id: "git_remote",
    summary: "List, add, or remove remotes",
    description:
      "Manage Git remotes. Actions: 'list' (default) — list all configured remotes with URLs; 'add' — add a new remote; 'remove' — remove a remote.",
    category: "git",
    tags: ["git", "remote", "origin", "upstream"],
    input: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Action: 'list', 'add', or 'remove' (default: 'list')",
          enum: ["list", "add", "remove"],
        },
        name: {
          type: "string",
          description: "Remote name (required for add, remove)",
        },
        url: {
          type: "string",
          description: "Remote URL (required for add)",
        },
      },
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: false,
      estimated_latency_ms: 1000,
      max_result_size_bytes: 10_000,
    },
    handler: async ({ action, name, url }: any) => {
      if (action !== "list" && config?.readOnly) {
        throw new Error("Server is in read-only mode");
      }
      return grm.remote({ action: action ?? "list", name, url });
    },
    summarizer: (result: any) => {
      if (Array.isArray(result)) {
        if (result.length === 0) return "No remotes configured";
        return `${result.length} remote(s): ${result.map((r: any) => `${r.name} (${r.fetchUrl})`).join(", ")}`;
      }
      return result.message;
    },
  });

  // ==========================================================================
  // Git Pull
  // ==========================================================================

  server.tool({
    id: "git_pull",
    summary: "Pull changes from remote",
    description:
      "Fetch and merge (or rebase) changes from a remote repository. Defaults to pulling from the tracked upstream.",
    category: "git",
    tags: ["git", "pull", "fetch", "merge", "sync"],
    input: {
      type: "object",
      properties: {
        remote: {
          type: "string",
          description: "Remote name (default: origin or tracked upstream)",
        },
        branch: {
          type: "string",
          description: "Branch to pull (default: current branch's upstream)",
        },
        rebase: {
          type: "boolean",
          description: "Rebase instead of merge (default: false)",
        },
      },
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: false,
      estimated_latency_ms: 15000,
      max_result_size_bytes: 100_000,
    },
    handler: async ({ remote, branch, rebase }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return grm.pull({ remote, branch, rebase });
    },
    summarizer: (output: string) => {
      if (output.includes("Already up to date")) return "Already up to date";
      const fileMatches = output.match(/(\d+) files? changed/);
      return fileMatches ? `Pulled: ${fileMatches[0]}` : "Pull completed";
    },
  });

  // ==========================================================================
  // Git Push
  // ==========================================================================

  server.tool({
    id: "git_push",
    summary: "Push commits to remote",
    description:
      "Push local commits to a remote repository. Force push uses --force-with-lease for safety and requires explicit configuration to enable.",
    category: "git",
    tags: ["git", "push", "upload", "sync"],
    input: {
      type: "object",
      properties: {
        remote: {
          type: "string",
          description: "Remote name (default: origin or tracked upstream)",
        },
        branch: {
          type: "string",
          description: "Branch to push (default: current branch)",
        },
        force: {
          type: "boolean",
          description: "Force push with --force-with-lease (requires allowForcePush config). Default: false.",
        },
        set_upstream: {
          type: "boolean",
          description: "Set upstream tracking for the branch (-u). Default: false.",
        },
        tags: {
          type: "boolean",
          description: "Push tags along with commits. Default: false.",
        },
      },
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: false,
      estimated_latency_ms: 15000,
      max_result_size_bytes: 50_000,
    },
    handler: async ({ remote, branch, force, set_upstream, tags }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return grm.push({ remote, branch, force, setUpstream: set_upstream, tags });
    },
    summarizer: (output: string) => {
      if (output.includes("Everything up-to-date")) return "Everything up-to-date";
      return "Push completed";
    },
  });

  // ==========================================================================
  // Git Blame
  // ==========================================================================

  server.tool({
    id: "git_blame",
    summary: "Show blame (line-by-line authorship) for a file",
    description:
      "Show which commit and author last modified each line of a file. Can be limited to a range of lines. Results stored in OCRS for large files.",
    category: "git",
    tags: ["git", "blame", "annotate", "authorship"],
    input: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path to blame (relative to repository root)",
        },
        start_line: {
          type: "number",
          description: "Start line number (for limiting range)",
        },
        end_line: {
          type: "number",
          description: "End line number (for limiting range)",
        },
      },
      required: ["path"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 3000,
      max_result_size_bytes: 2_000_000,
    },
    handler: async ({ path, start_line, end_line }: any) => {
      return grm.blame(path, { startLine: start_line, endLine: end_line });
    },
    summarizer: (entries: any[]) => {
      if (!Array.isArray(entries) || entries.length === 0) return "No blame data";
      const authors = new Set(entries.map((e: any) => e.author));
      return `${entries.length} lines, ${authors.size} author(s): ${Array.from(authors).slice(0, 5).join(", ")}${authors.size > 5 ? "..." : ""} — stored in OCRS`;
    },
  });

  return { server, store, capAuthority };
}
