/**
 * AXON File System Server — Entry Point
 *
 * Creates the AXON server for file system operations
 * and exposes it via both native AXON and MCP-compatible protocols.
 *
 * All operations are scoped to a configurable root directory
 * with path traversal protection.
 */

import { homedir } from "node:os";
import { FileSystemManager } from "./filesystem-manager.js";
import { createFileSystemServer } from "./server.js";

export { FileSystemManager } from "./filesystem-manager.js";
export { createFileSystemServer } from "./server.js";

export type {
  FileSystemManagerConfig,
  DirectoryEntry,
  FileInfo,
  SearchResult,
  TextSearchMatch,
  TextSearchResult,
} from "./filesystem-manager.js";

export interface FileSystemServerOptions {
  /** Root directory for all file operations (defaults to home directory) */
  rootDir?: string;
  /** Restrict server to read-only operations */
  readOnly?: boolean;
}

/**
 * Launch the AXON File System server.
 * Returns the file system manager, AXON server, and cleanup function.
 *
 * @example
 * ```typescript
 * const { server, fsm } = await launchFileSystemServer({ rootDir: "/home/user/projects" });
 * console.log(`${server.toolCount} tools ready`);
 *
 * const result = await server.execute({
 *   id: 1,
 *   tool: "list_directory",
 *   params: { path: "." },
 *   capability: "",
 * }, { sessionId: "demo", streamId: 1, reportProgress: () => {}, isCancelled: () => false });
 * ```
 */
export async function launchFileSystemServer(opts?: FileSystemServerOptions) {
  const rootDir = opts?.rootDir ?? homedir();

  const fsm = new FileSystemManager({ rootDir });

  const { server, store, capAuthority } = createFileSystemServer(fsm, {
    readOnly: opts?.readOnly,
  });

  // Issue default capabilities — 1h TTL
  const sessionId = "filesystem-session";
  const readCap = capAuthority.issue(sessionId, "resource:read", "**", {
    ttl_seconds: 3600,
  });
  const writeCap = capAuthority.issue(sessionId, "resource:write", "**", {
    ttl_seconds: 3600,
  });

  return {
    fsm,
    server,
    store,
    capAuthority,
    capabilities: { read: readCap, write: writeCap },
  };
}

// Direct execution: launch and log
if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  launchFileSystemServer()
    .then(({ server }) => {
      console.log(`AXON File System server started with ${server.toolCount} tools`);
      console.log(`Manifest tokens: ~${server.estimateManifestTokens()}`);
      console.log("Tools:", server.getManifest().map((t) => t.id).join(", "));
    })
    .catch((err) => {
      console.error("Failed to launch:", err.message);
      process.exit(1);
    });
}
