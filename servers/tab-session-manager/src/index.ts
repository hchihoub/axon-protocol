/**
 * AXON Tab Session Manager Server — Entry Point
 *
 * Launches Chrome with user profile, creates the AXON server,
 * and exposes it via both native AXON and MCP-compatible protocols.
 *
 * IMPORTANT: Chrome must be fully closed before launching.
 * Puppeteer cannot share a profile directory with a running Chrome instance.
 */

import { TabSessionManager } from "./tab-session-manager.js";
import { createTabSessionManagerServer } from "./server.js";

export { TabSessionManager } from "./tab-session-manager.js";
export { createTabSessionManagerServer } from "./server.js";

export type {
  TabInfo,
  SavedSession,
  SessionsFile,
  TabSessionManagerConfig,
} from "./tab-session-manager.js";

export interface TabSessionManagerServerOptions {
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
  /** Path to sessions JSON file (default: ~/.axon/tab-sessions.json) */
  sessionsFile?: string;
}

/**
 * Launch the AXON Tab Session Manager server.
 * Returns the tab session manager, AXON server, and cleanup function.
 *
 * @example
 * ```typescript
 * const { server, tsm, shutdown } = await launchTabSessionManagerServer();
 * console.log(`${server.toolCount} tools ready`);
 *
 * const result = await server.execute({
 *   id: 1,
 *   tool: "list_tabs",
 *   params: {},
 *   capability: "",
 * }, { sessionId: "demo", streamId: 1, reportProgress: () => {}, isCancelled: () => false });
 *
 * await shutdown();
 * ```
 */
export async function launchTabSessionManagerServer(opts?: TabSessionManagerServerOptions) {
  const tsm = new TabSessionManager({
    headless: opts?.headless ?? false,
    userDataDir: opts?.userDataDir,
    profileName: opts?.profileName ?? "Default",
    executablePath: opts?.executablePath,
    viewport: opts?.viewport ?? { width: 1280, height: 900 },
    sessionsFile: opts?.sessionsFile,
  });

  await tsm.launch();

  const { server, store, capAuthority } = createTabSessionManagerServer(tsm, {
    readOnly: opts?.readOnly,
  });

  // Issue default capabilities — 1h TTL
  const sessionId = "tab-session";
  const readCap = capAuthority.issue(sessionId, "resource:read", "**", {
    ttl_seconds: 3600,
  });
  const writeCap = capAuthority.issue(sessionId, "resource:write", "**", {
    ttl_seconds: 3600,
  });

  return {
    tsm,
    server,
    store,
    capAuthority,
    capabilities: { read: readCap, write: writeCap },
    async shutdown() {
      await tsm.close();
    },
  };
}

// Direct execution: launch and log
if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  launchTabSessionManagerServer()
    .then(({ server }) => {
      console.log(`AXON Tab Session Manager server started with ${server.toolCount} tools`);
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
