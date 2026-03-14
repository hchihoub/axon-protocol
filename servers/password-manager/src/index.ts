/**
 * AXON Password Manager Server — Entry Point
 *
 * Launches Chrome with user profile, creates the AXON server,
 * and exposes it via both native AXON and MCP-compatible protocols.
 *
 * IMPORTANT: Chrome must be fully closed before launching.
 * Puppeteer cannot share a profile directory with a running Chrome instance.
 */

import { PasswordManager } from "./password-manager.js";
import { createPasswordManagerServer } from "./server.js";

export { PasswordManager } from "./password-manager.js";
export { createPasswordManagerServer } from "./server.js";

export type {
  PasswordEntry,
  PasswordManagerConfig,
  GeneratePasswordOptions,
  SecurityReport,
} from "./password-manager.js";

export interface PasswordManagerServerOptions {
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
 * Launch the AXON Password Manager server.
 * Returns the password manager, AXON server, and cleanup function.
 *
 * @example
 * ```typescript
 * const { server, pm, shutdown } = await launchPasswordManagerServer();
 * console.log(`${server.toolCount} tools ready`);
 *
 * const result = await server.execute({
 *   id: 1,
 *   tool: "list_passwords",
 *   params: {},
 *   capability: "",
 * }, { sessionId: "demo", streamId: 1, reportProgress: () => {}, isCancelled: () => false });
 *
 * await shutdown();
 * ```
 */
export async function launchPasswordManagerServer(opts?: PasswordManagerServerOptions) {
  const pm = new PasswordManager({
    headless: opts?.headless ?? false,
    userDataDir: opts?.userDataDir,
    profileName: opts?.profileName ?? "Default",
    executablePath: opts?.executablePath,
    viewport: opts?.viewport ?? { width: 1280, height: 900 },
  });

  await pm.launch();

  const { server, store, capAuthority } = createPasswordManagerServer(pm, {
    readOnly: opts?.readOnly,
  });

  // Issue default capabilities — 1h TTL (shorter than chrome server's 24h)
  const sessionId = "password-session";
  const readCap = capAuthority.issue(sessionId, "resource:read", "**", {
    ttl_seconds: 3600,
  });
  const writeCap = capAuthority.issue(sessionId, "resource:write", "**", {
    ttl_seconds: 3600,
  });

  return {
    pm,
    server,
    store,
    capAuthority,
    capabilities: { read: readCap, write: writeCap },
    async shutdown() {
      await pm.close();
    },
  };
}

// Direct execution: launch and log
if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  launchPasswordManagerServer()
    .then(({ server }) => {
      console.log(`AXON Password Manager server started with ${server.toolCount} tools`);
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
