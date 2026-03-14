/**
 * AXON Git Repository Manager — Core Implementation
 *
 * Manages Git repositories using child_process.execFile to run git commands.
 * Uses execFile (NOT exec) to prevent shell injection attacks.
 *
 * All operations are scoped to a configurable repository directory.
 * Uses only Node.js built-in APIs: child_process, path.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs";

const execFile = promisify(execFileCb);

// ============================================================================
// Types
// ============================================================================

export interface GitRepoManagerConfig {
  /** Repository directory — all git commands run in this directory */
  repoDir: string;
  /** Allow force push operations (default: false) */
  allowForcePush?: boolean;
}

export interface GitStatusResult {
  branch: string;
  ahead: number;
  behind: number;
  staged: GitFileChange[];
  modified: GitFileChange[];
  untracked: string[];
  conflicted: string[];
}

export interface GitFileChange {
  file: string;
  status: string;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
  remote?: string;
  lastCommit?: string;
}

export interface GitRemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface GitStashEntry {
  index: number;
  message: string;
  branch: string;
}

export interface GitBlameEntry {
  commit: string;
  author: string;
  date: string;
  line: number;
  content: string;
}

// ============================================================================
// GitRepoManager
// ============================================================================

export class GitRepoManager {
  private readonly repoDir: string;
  private readonly allowForcePush: boolean;

  constructor(config: GitRepoManagerConfig) {
    this.repoDir = path.resolve(config.repoDir);
    this.allowForcePush = config.allowForcePush ?? false;

    // Validate the directory exists
    if (!fs.existsSync(this.repoDir)) {
      throw new Error(`Repository directory does not exist: ${this.repoDir}`);
    }
  }

  /** Get the configured repository directory */
  get repo(): string {
    return this.repoDir;
  }

  // ==========================================================================
  // Git Command Execution
  // ==========================================================================

  /**
   * Execute a git command safely using execFile (no shell injection).
   * All commands run with cwd set to repoDir.
   */
  private async git(args: string[], options?: { maxBuffer?: number }): Promise<string> {
    try {
      const { stdout } = await execFile("git", args, {
        cwd: this.repoDir,
        maxBuffer: options?.maxBuffer ?? 10 * 1024 * 1024, // 10MB default
        env: {
          ...process.env,
          // Prevent git from asking for credentials interactively
          GIT_TERMINAL_PROMPT: "0",
        },
      });
      return stdout;
    } catch (err: any) {
      // execFile errors include stderr
      const message = err.stderr?.trim() || err.message;
      throw new Error(`git ${args[0]} failed: ${message}`);
    }
  }

  // ==========================================================================
  // Operations
  // ==========================================================================

  /**
   * Show working tree status.
   */
  async status(): Promise<GitStatusResult> {
    // Get branch info
    const branchOutput = await this.git(["branch", "--show-current"]);
    const branch = branchOutput.trim() || "HEAD (detached)";

    // Get ahead/behind counts
    let ahead = 0;
    let behind = 0;
    try {
      const abOutput = await this.git(["rev-list", "--left-right", "--count", `HEAD...@{upstream}`]);
      const parts = abOutput.trim().split(/\s+/);
      ahead = parseInt(parts[0], 10) || 0;
      behind = parseInt(parts[1], 10) || 0;
    } catch {
      // No upstream configured — that's fine
    }

    // Get porcelain status
    const statusOutput = await this.git(["status", "--porcelain=v1", "-uall"]);
    const lines = statusOutput.split("\n").filter((l) => l.length > 0);

    const staged: GitFileChange[] = [];
    const modified: GitFileChange[] = [];
    const untracked: string[] = [];
    const conflicted: string[] = [];

    for (const line of lines) {
      const index = line[0];
      const worktree = line[1];
      const file = line.substring(3);

      // Conflicted
      if (index === "U" || worktree === "U" || (index === "A" && worktree === "A") || (index === "D" && worktree === "D")) {
        conflicted.push(file);
        continue;
      }

      // Untracked
      if (index === "?" && worktree === "?") {
        untracked.push(file);
        continue;
      }

      // Staged changes
      if (index !== " " && index !== "?") {
        staged.push({ file, status: this.statusLabel(index) });
      }

      // Working tree changes
      if (worktree !== " " && worktree !== "?") {
        modified.push({ file, status: this.statusLabel(worktree) });
      }
    }

    return { branch, ahead, behind, staged, modified, untracked, conflicted };
  }

  /**
   * Show commit history.
   */
  async log(options?: { count?: number; branch?: string; author?: string; since?: string; until?: string; path?: string }): Promise<GitLogEntry[]> {
    const args = [
      "log",
      `--max-count=${options?.count ?? 20}`,
      "--format=%H%n%h%n%an%n%ae%n%aI%n%s%n%b%n---AXON-LOG-SEP---",
    ];

    if (options?.branch) args.push(options.branch);
    if (options?.author) args.push(`--author=${options.author}`);
    if (options?.since) args.push(`--since=${options.since}`);
    if (options?.until) args.push(`--until=${options.until}`);
    if (options?.path) {
      args.push("--");
      args.push(options.path);
    }

    const output = await this.git(args);
    const entries = output.split("---AXON-LOG-SEP---\n").filter((e) => e.trim());

    return entries.map((entry) => {
      const lines = entry.split("\n");
      return {
        hash: lines[0] || "",
        shortHash: lines[1] || "",
        author: lines[2] || "",
        email: lines[3] || "",
        date: lines[4] || "",
        subject: lines[5] || "",
        body: lines.slice(6).join("\n").trim(),
      };
    });
  }

  /**
   * Show diffs.
   */
  async diff(options?: { staged?: boolean; commit?: string; commitRange?: string; path?: string }): Promise<string> {
    const args = ["diff"];

    if (options?.staged) {
      args.push("--cached");
    }

    if (options?.commitRange) {
      args.push(options.commitRange);
    } else if (options?.commit) {
      args.push(options.commit);
    }

    if (options?.path) {
      args.push("--");
      args.push(options.path);
    }

    return this.git(args, { maxBuffer: 50 * 1024 * 1024 }); // 50MB for large diffs
  }

  /**
   * Branch operations: list, create, delete, switch.
   */
  async branch(options?: {
    action?: "list" | "create" | "delete" | "switch";
    name?: string;
    startPoint?: string;
    all?: boolean;
  }): Promise<GitBranchInfo[] | { success: boolean; message: string }> {
    const action = options?.action ?? "list";

    switch (action) {
      case "list": {
        const args = ["branch", "-v", "--no-color"];
        if (options?.all) args.push("-a");
        const output = await this.git(args);
        const lines = output.split("\n").filter((l) => l.trim());

        return lines.map((line) => {
          const current = line.startsWith("*");
          const trimmed = line.replace(/^\*?\s+/, "");
          const parts = trimmed.split(/\s+/);
          const name = parts[0] || "";
          const lastCommit = parts.slice(1).join(" ");
          return { name, current, lastCommit };
        });
      }

      case "create": {
        if (!options?.name) throw new Error("Branch name is required");
        const args = ["branch", options.name];
        if (options.startPoint) args.push(options.startPoint);
        await this.git(args);
        return { success: true, message: `Created branch: ${options.name}` };
      }

      case "delete": {
        if (!options?.name) throw new Error("Branch name is required");
        await this.git(["branch", "-d", options.name]);
        return { success: true, message: `Deleted branch: ${options.name}` };
      }

      case "switch": {
        if (!options?.name) throw new Error("Branch name is required");
        await this.git(["checkout", options.name]);
        return { success: true, message: `Switched to branch: ${options.name}` };
      }

      default:
        throw new Error(`Unknown branch action: ${action}`);
    }
  }

  /**
   * Stage files and create a commit.
   */
  async commit(options: {
    message: string;
    files?: string[];
    all?: boolean;
    amend?: boolean;
  }): Promise<{ hash: string; message: string; filesChanged: number }> {
    // Stage files
    if (options.all) {
      await this.git(["add", "-A"]);
    } else if (options.files && options.files.length > 0) {
      await this.git(["add", ...options.files]);
    }

    // Create commit
    const args = ["commit", "-m", options.message];
    if (options.amend) args.push("--amend");

    const output = await this.git(args);

    // Parse commit output to get hash
    const hashMatch = output.match(/\[[\w/]+ ([a-f0-9]+)\]/);
    const hash = hashMatch?.[1] ?? "";

    // Count changed files
    const filesMatch = output.match(/(\d+) files? changed/);
    const filesChanged = parseInt(filesMatch?.[1] ?? "0", 10);

    return { hash, message: options.message, filesChanged };
  }

  /**
   * Stash operations: save, pop, list, drop.
   */
  async stash(options?: {
    action?: "save" | "pop" | "list" | "drop" | "apply";
    message?: string;
    index?: number;
  }): Promise<GitStashEntry[] | { success: boolean; message: string }> {
    const action = options?.action ?? "list";

    switch (action) {
      case "save": {
        const args = ["stash", "push"];
        if (options?.message) {
          args.push("-m", options.message);
        }
        await this.git(args);
        return { success: true, message: `Changes stashed${options?.message ? `: ${options.message}` : ""}` };
      }

      case "pop": {
        const args = ["stash", "pop"];
        if (options?.index !== undefined) args.push(`stash@{${options.index}}`);
        await this.git(args);
        return { success: true, message: `Stash popped${options?.index !== undefined ? ` (index ${options.index})` : ""}` };
      }

      case "apply": {
        const args = ["stash", "apply"];
        if (options?.index !== undefined) args.push(`stash@{${options.index}}`);
        await this.git(args);
        return { success: true, message: `Stash applied${options?.index !== undefined ? ` (index ${options.index})` : ""}` };
      }

      case "drop": {
        const args = ["stash", "drop"];
        if (options?.index !== undefined) args.push(`stash@{${options.index}}`);
        await this.git(args);
        return { success: true, message: `Stash dropped${options?.index !== undefined ? ` (index ${options.index})` : ""}` };
      }

      case "list": {
        const output = await this.git(["stash", "list", "--format=%gd%n%gs%n%gD%n---AXON-STASH-SEP---"]);
        if (!output.trim()) return [];

        const entries = output.split("---AXON-STASH-SEP---\n").filter((e) => e.trim());
        return entries.map((entry) => {
          const lines = entry.split("\n");
          const indexMatch = lines[0]?.match(/stash@\{(\d+)\}/);
          return {
            index: parseInt(indexMatch?.[1] ?? "0", 10),
            message: lines[1] || "",
            branch: lines[2] || "",
          };
        });
      }

      default:
        throw new Error(`Unknown stash action: ${action}`);
    }
  }

  /**
   * Remote operations: list, add, remove.
   */
  async remote(options?: {
    action?: "list" | "add" | "remove";
    name?: string;
    url?: string;
  }): Promise<GitRemoteInfo[] | { success: boolean; message: string }> {
    const action = options?.action ?? "list";

    switch (action) {
      case "list": {
        const output = await this.git(["remote", "-v"]);
        if (!output.trim()) return [];

        const lines = output.split("\n").filter((l) => l.trim());
        const remotes = new Map<string, GitRemoteInfo>();

        for (const line of lines) {
          const parts = line.split(/\s+/);
          const name = parts[0];
          const url = parts[1];
          const type = parts[2]; // (fetch) or (push)

          if (!remotes.has(name)) {
            remotes.set(name, { name, fetchUrl: "", pushUrl: "" });
          }

          const remote = remotes.get(name)!;
          if (type === "(fetch)") remote.fetchUrl = url;
          if (type === "(push)") remote.pushUrl = url;
        }

        return Array.from(remotes.values());
      }

      case "add": {
        if (!options?.name || !options?.url) throw new Error("Remote name and URL are required");
        await this.git(["remote", "add", options.name, options.url]);
        return { success: true, message: `Added remote: ${options.name} -> ${options.url}` };
      }

      case "remove": {
        if (!options?.name) throw new Error("Remote name is required");
        await this.git(["remote", "remove", options.name]);
        return { success: true, message: `Removed remote: ${options.name}` };
      }

      default:
        throw new Error(`Unknown remote action: ${action}`);
    }
  }

  /**
   * Pull from remote.
   */
  async pull(options?: { remote?: string; branch?: string; rebase?: boolean }): Promise<string> {
    const args = ["pull"];
    if (options?.rebase) args.push("--rebase");
    if (options?.remote) args.push(options.remote);
    if (options?.branch) args.push(options.branch);

    return this.git(args);
  }

  /**
   * Push to remote.
   */
  async push(options?: {
    remote?: string;
    branch?: string;
    force?: boolean;
    setUpstream?: boolean;
    tags?: boolean;
  }): Promise<string> {
    if (options?.force && !this.allowForcePush) {
      throw new Error(
        "Force push is disabled. Set allowForcePush: true in config or use the AXON_GIT_ALLOW_FORCE_PUSH=true env var."
      );
    }

    const args = ["push"];
    if (options?.force) args.push("--force-with-lease"); // Safer than --force
    if (options?.setUpstream) args.push("--set-upstream");
    if (options?.tags) args.push("--tags");
    if (options?.remote) args.push(options.remote);
    if (options?.branch) args.push(options.branch);

    return this.git(args);
  }

  /**
   * Show blame for a file.
   */
  async blame(filePath: string, options?: { startLine?: number; endLine?: number }): Promise<GitBlameEntry[]> {
    const args = ["blame", "--porcelain"];

    if (options?.startLine && options?.endLine) {
      args.push(`-L${options.startLine},${options.endLine}`);
    }

    args.push("--", filePath);

    const output = await this.git(args, { maxBuffer: 50 * 1024 * 1024 });
    return this.parseBlame(output);
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private statusLabel(code: string): string {
    const map: Record<string, string> = {
      M: "modified",
      A: "added",
      D: "deleted",
      R: "renamed",
      C: "copied",
      U: "unmerged",
      "?": "untracked",
      "!": "ignored",
    };
    return map[code] || code;
  }

  private parseBlame(output: string): GitBlameEntry[] {
    const entries: GitBlameEntry[] = [];
    const lines = output.split("\n");
    let i = 0;

    while (i < lines.length) {
      const headerMatch = lines[i]?.match(/^([a-f0-9]{40})\s+(\d+)\s+(\d+)/);
      if (!headerMatch) {
        i++;
        continue;
      }

      const commit = headerMatch[1];
      const lineNum = parseInt(headerMatch[3], 10);
      let author = "";
      let date = "";
      let content = "";
      i++;

      // Read header fields until we find the content line (starts with \t)
      while (i < lines.length) {
        if (lines[i].startsWith("\t")) {
          content = lines[i].substring(1);
          i++;
          break;
        }
        if (lines[i].startsWith("author ")) {
          author = lines[i].substring(7);
        }
        if (lines[i].startsWith("author-time ")) {
          const timestamp = parseInt(lines[i].substring(12), 10);
          date = new Date(timestamp * 1000).toISOString();
        }
        i++;
      }

      entries.push({ commit: commit.substring(0, 8), author, date, line: lineNum, content });
    }

    return entries;
  }
}
