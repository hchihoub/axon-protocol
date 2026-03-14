/**
 * AXON Clipboard Server — Entry Point
 *
 * Creates the clipboard manager and AXON server.
 * Exposes it via both native AXON and MCP-compatible protocols.
 */

import { ClipboardManager } from "./clipboard-manager.js";
import { createClipboardServer } from "./server.js";

export { ClipboardManager } from "./clipboard-manager.js";
export { createClipboardServer } from "./server.js";

export type {
  ClipboardEntry,
  ClipboardManagerConfig,
} from "./clipboard-manager.js";

export type { ClipboardServerConfig } from "./server.js";

export interface ClipboardServerOptions {
  /** Maximum number of history entries (default: 100) */
  maxHistory?: number;
  /** Custom path for history persistence file */
  historyPath?: string;
  /** Restrict server to read-only operations */
  readOnly?: boolean;
}

/**
 * Launch the AXON Clipboard server.
 * Returns the clipboard manager, AXON server, and cleanup function.
 *
 * @example
 * ```typescript
 * const { server, cm } = await launchClipboardServer();
 * console.log(`${server.toolCount} tools ready`);
 *
 * const result = await server.execute({
 *   id: 1,
 *   tool: "get_clipboard",
 *   params: {},
 *   capability: "",
 * }, { sessionId: "demo", streamId: 1, reportProgress: () => {}, isCancelled: () => false });
 * ```
 */
export async function launchClipboardServer(opts?: ClipboardServerOptions) {
  const cm = new ClipboardManager({
    maxHistory: opts?.maxHistory ?? 100,
    historyPath: opts?.historyPath,
  });

  const { server, store, capAuthority } = createClipboardServer(cm, {
    readOnly: opts?.readOnly,
  });

  // Issue default capabilities — 1h TTL
  const sessionId = "clipboard-session";
  const readCap = capAuthority.issue(sessionId, "resource:read", "**", {
    ttl_seconds: 3600,
  });
  const writeCap = capAuthority.issue(sessionId, "resource:write", "**", {
    ttl_seconds: 3600,
  });

  return {
    cm,
    server,
    store,
    capAuthority,
    capabilities: { read: readCap, write: writeCap },
  };
}

// Direct execution: launch and log
if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  launchClipboardServer()
    .then(({ server }) => {
      console.log(`AXON Clipboard server started with ${server.toolCount} tools`);
      console.log(`Manifest tokens: ~${server.estimateManifestTokens()}`);
      console.log("Tools:", server.getManifest().map((t) => t.id).join(", "));
    })
    .catch((err) => {
      console.error("Failed to launch:", err.message);
      process.exit(1);
    });
}
