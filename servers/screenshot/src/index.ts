/**
 * AXON Screenshot Server — Entry Point
 *
 * Creates the screenshot manager and AXON server.
 * Exposes it via both native AXON and MCP-compatible protocols.
 */

import { ScreenshotManager } from "./screenshot-manager.js";
import { createScreenshotServer } from "./server.js";

export { ScreenshotManager } from "./screenshot-manager.js";
export { createScreenshotServer } from "./server.js";

export type {
  ScreenshotInfo,
  ScreenshotManagerConfig,
  CaptureRegion,
} from "./screenshot-manager.js";

export type { ScreenshotServerConfig } from "./server.js";

export interface ScreenshotServerOptions {
  /** Directory to store screenshots (default: ~/.axon/screenshots/) */
  screenshotDir?: string;
  /** Restrict server to read-only operations */
  readOnly?: boolean;
}

/**
 * Launch the AXON Screenshot server.
 * Returns the screenshot manager, AXON server, and cleanup function.
 *
 * @example
 * ```typescript
 * const { server, sm } = await launchScreenshotServer();
 * console.log(`${server.toolCount} tools ready`);
 *
 * const result = await server.execute({
 *   id: 1,
 *   tool: "take_screenshot",
 *   params: {},
 *   capability: "",
 * }, { sessionId: "demo", streamId: 1, reportProgress: () => {}, isCancelled: () => false });
 * ```
 */
export async function launchScreenshotServer(opts?: ScreenshotServerOptions) {
  const sm = new ScreenshotManager({
    screenshotDir: opts?.screenshotDir,
  });

  const { server, store, capAuthority } = createScreenshotServer(sm, {
    readOnly: opts?.readOnly,
  });

  // Issue default capabilities — 1h TTL
  const sessionId = "screenshot-session";
  const readCap = capAuthority.issue(sessionId, "resource:read", "**", {
    ttl_seconds: 3600,
  });
  const writeCap = capAuthority.issue(sessionId, "resource:write", "**", {
    ttl_seconds: 3600,
  });

  return {
    sm,
    server,
    store,
    capAuthority,
    capabilities: { read: readCap, write: writeCap },
  };
}

// Direct execution: launch and log
if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  launchScreenshotServer()
    .then(({ server }) => {
      console.log(`AXON Screenshot server started with ${server.toolCount} tools`);
      console.log(`Manifest tokens: ~${server.estimateManifestTokens()}`);
      console.log("Tools:", server.getManifest().map((t) => t.id).join(", "));
    })
    .catch((err) => {
      console.error("Failed to launch:", err.message);
      process.exit(1);
    });
}
