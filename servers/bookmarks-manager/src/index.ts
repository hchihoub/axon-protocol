/**
 * AXON Bookmarks Manager Server — Entry Point
 *
 * Launches Chrome with user profile, creates the AXON server,
 * and exposes it via both native AXON and MCP-compatible protocols.
 *
 * IMPORTANT: Chrome must be fully closed before launching.
 * Puppeteer cannot share a profile directory with a running Chrome instance.
 */

import { BookmarksManager } from "./bookmarks-manager.js";
import { createBookmarksManagerServer } from "./server.js";

export { BookmarksManager } from "./bookmarks-manager.js";
export { createBookmarksManagerServer } from "./server.js";

export type {
  BookmarkEntry,
  BookmarkFolder,
  BookmarkTreeNode,
  BookmarksManagerConfig,
} from "./bookmarks-manager.js";

export interface BookmarksManagerServerOptions {
  /** Chrome user data directory (auto-detected if not set) */
  userDataDir?: string;
  /** Chrome profile name (default: "Default") */
  profileName?: string;
  /** Path to Chrome executable (auto-detected if not set) */
  executablePath?: string;
  /** Run Chrome headlessly (default: false) */
  headless?: boolean;
  /** Viewport dimensions */
  viewport?: { width: number; height: number };
  /** Restrict server to read-only operations */
  readOnly?: boolean;
}

/**
 * Launch the AXON Bookmarks Manager server.
 * Returns the bookmarks manager, AXON server, and cleanup function.
 *
 * @example
 * ```typescript
 * const { server, bm, shutdown } = await launchBookmarksManagerServer();
 * console.log(`${server.toolCount} tools ready`);
 *
 * const result = await server.execute({
 *   id: 1,
 *   tool: "list_bookmarks",
 *   params: {},
 *   capability: "",
 * }, { sessionId: "demo", streamId: 1, reportProgress: () => {}, isCancelled: () => false });
 *
 * await shutdown();
 * ```
 */
export async function launchBookmarksManagerServer(opts?: BookmarksManagerServerOptions) {
  const bm = new BookmarksManager({
    headless: opts?.headless ?? false,
    userDataDir: opts?.userDataDir,
    profileName: opts?.profileName ?? "Default",
    executablePath: opts?.executablePath,
    viewport: opts?.viewport ?? { width: 1280, height: 900 },
  });

  await bm.launch();

  const { server, store, capAuthority } = createBookmarksManagerServer(bm, {
    readOnly: opts?.readOnly,
  });

  const sessionId = "bookmarks-session";
  const readCap = capAuthority.issue(sessionId, "resource:read", "**", {
    ttl_seconds: 3600,
  });
  const writeCap = capAuthority.issue(sessionId, "resource:write", "**", {
    ttl_seconds: 3600,
  });

  return {
    bm,
    server,
    store,
    capAuthority,
    capabilities: { read: readCap, write: writeCap },
    async shutdown() {
      await bm.close();
    },
  };
}

// Direct execution: launch and log
if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  launchBookmarksManagerServer()
    .then(({ server }) => {
      console.log(`AXON Bookmarks Manager server started with ${server.toolCount} tools`);
      console.log(`Manifest tokens: ~${server.estimateManifestTokens()}`);
      console.log("Tools:", server.getManifest().map((t) => t.id).join(", "));
    })
    .catch((err) => {
      console.error("Failed to launch:", err.message);
      console.error("\nMake sure Chrome is fully closed before launching.");
      console.error("Puppeteer cannot share a profile directory with a running Chrome instance.");
      process.exit(1);
    });
}
