/**
 * AXON Extensions Manager Server — Entry Point
 *
 * Launches Chrome with user profile, creates the AXON server,
 * and exposes it via both native AXON and MCP-compatible protocols.
 *
 * IMPORTANT: Chrome must be fully closed before launching.
 * Puppeteer cannot share a profile directory with a running Chrome instance.
 */

import { ExtensionsManager } from "./extensions-manager.js";
import { createExtensionsManagerServer } from "./server.js";

export { ExtensionsManager } from "./extensions-manager.js";
export { createExtensionsManagerServer } from "./server.js";

export type {
  ExtensionEntry,
  ExtensionDetails,
  ExtensionsManagerConfig,
} from "./extensions-manager.js";

export interface ExtensionsManagerServerOptions {
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
 * Launch the AXON Extensions Manager server.
 * Returns the extensions manager, AXON server, and cleanup function.
 *
 * @example
 * ```typescript
 * const { server, em, shutdown } = await launchExtensionsManagerServer();
 * console.log(`${server.toolCount} tools ready`);
 *
 * const result = await server.execute({
 *   id: 1,
 *   tool: "list_extensions",
 *   params: {},
 *   capability: "",
 * }, { sessionId: "demo", streamId: 1, reportProgress: () => {}, isCancelled: () => false });
 *
 * await shutdown();
 * ```
 */
export async function launchExtensionsManagerServer(opts?: ExtensionsManagerServerOptions) {
  const em = new ExtensionsManager({
    headless: opts?.headless ?? false,
    userDataDir: opts?.userDataDir,
    profileName: opts?.profileName ?? "Default",
    executablePath: opts?.executablePath,
    viewport: opts?.viewport ?? { width: 1280, height: 900 },
  });

  await em.launch();

  const { server, store, capAuthority } = createExtensionsManagerServer(em, {
    readOnly: opts?.readOnly,
  });

  const sessionId = "extensions-session";
  const readCap = capAuthority.issue(sessionId, "resource:read", "**", {
    ttl_seconds: 3600,
  });
  const writeCap = capAuthority.issue(sessionId, "resource:write", "**", {
    ttl_seconds: 3600,
  });

  return {
    em,
    server,
    store,
    capAuthority,
    capabilities: { read: readCap, write: writeCap },
    async shutdown() {
      await em.close();
    },
  };
}

// Direct execution: launch and log
if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  launchExtensionsManagerServer()
    .then(({ server }) => {
      console.log(`AXON Extensions Manager server started with ${server.toolCount} tools`);
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
