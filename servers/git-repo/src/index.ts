/**
 * AXON Git Repository Server — Entry Point
 *
 * Creates the AXON server for Git repository operations
 * and exposes it via both native AXON and MCP-compatible protocols.
 *
 * All git commands are scoped to a configurable repository directory
 * and use execFile for shell injection protection.
 */

import { GitRepoManager } from "./git-repo-manager.js";
import { createGitRepoServer } from "./server.js";

export { GitRepoManager } from "./git-repo-manager.js";
export { createGitRepoServer } from "./server.js";

export type {
  GitRepoManagerConfig,
  GitStatusResult,
  GitFileChange,
  GitLogEntry,
  GitBranchInfo,
  GitRemoteInfo,
  GitStashEntry,
  GitBlameEntry,
} from "./git-repo-manager.js";

export interface GitRepoServerOptions {
  /** Repository directory (defaults to current directory) */
  repoDir?: string;
  /** Allow force push operations (default: false) */
  allowForcePush?: boolean;
  /** Restrict server to read-only operations */
  readOnly?: boolean;
}

/**
 * Launch the AXON Git Repository server.
 * Returns the git repo manager, AXON server, and associated objects.
 *
 * @example
 * ```typescript
 * const { server, grm } = await launchGitRepoServer({ repoDir: "/home/user/my-project" });
 * console.log(`${server.toolCount} tools ready`);
 *
 * const result = await server.execute({
 *   id: 1,
 *   tool: "git_status",
 *   params: {},
 *   capability: "",
 * }, { sessionId: "demo", streamId: 1, reportProgress: () => {}, isCancelled: () => false });
 * ```
 */
export async function launchGitRepoServer(opts?: GitRepoServerOptions) {
  const repoDir = opts?.repoDir ?? process.cwd();

  const grm = new GitRepoManager({
    repoDir,
    allowForcePush: opts?.allowForcePush ?? false,
  });

  const { server, store, capAuthority } = createGitRepoServer(grm, {
    readOnly: opts?.readOnly,
  });

  // Issue default capabilities — 1h TTL
  const sessionId = "git-repo-session";
  const readCap = capAuthority.issue(sessionId, "resource:read", "**", {
    ttl_seconds: 3600,
  });
  const writeCap = capAuthority.issue(sessionId, "resource:write", "**", {
    ttl_seconds: 3600,
  });

  return {
    grm,
    server,
    store,
    capAuthority,
    capabilities: { read: readCap, write: writeCap },
  };
}

// Direct execution: launch and log
if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  launchGitRepoServer()
    .then(({ server }) => {
      console.log(`AXON Git Repository server started with ${server.toolCount} tools`);
      console.log(`Manifest tokens: ~${server.estimateManifestTokens()}`);
      console.log("Tools:", server.getManifest().map((t) => t.id).join(", "));
    })
    .catch((err) => {
      console.error("Failed to launch:", err.message);
      process.exit(1);
    });
}
