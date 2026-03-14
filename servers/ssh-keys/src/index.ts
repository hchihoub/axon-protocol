/**
 * AXON SSH Key Manager Server — Entry Point
 *
 * Creates the SSH Key Manager, registers AXON tools,
 * and exposes them via both native AXON and MCP-compatible protocols.
 *
 * No external dependencies — uses Node.js fs and child_process only.
 */

import { SSHKeyManager } from "./ssh-key-manager.js";
import { createSSHKeyServer } from "./server.js";

export { SSHKeyManager } from "./ssh-key-manager.js";
export { createSSHKeyServer } from "./server.js";

export type {
  SSHKeyInfo,
  SSHHostEntry,
  GenerateKeyOptions,
  SSHKeyManagerConfig,
} from "./ssh-key-manager.js";

export interface SSHKeyServerOptions {
  /** Override SSH directory (default: ~/.ssh) */
  sshDir?: string;
  /** Restrict server to read-only operations */
  readOnly?: boolean;
}

/**
 * Launch the AXON SSH Key Manager server.
 * Returns the manager, AXON server, and related objects.
 *
 * @example
 * ```typescript
 * const { server, manager } = await launchSSHKeyServer();
 * console.log(`${server.toolCount} tools ready`);
 *
 * const result = await server.execute({
 *   id: 1,
 *   tool: "list_keys",
 *   params: {},
 *   capability: "",
 * }, { sessionId: "demo", streamId: 1, reportProgress: () => {}, isCancelled: () => false });
 * ```
 */
export async function launchSSHKeyServer(opts?: SSHKeyServerOptions) {
  const manager = new SSHKeyManager({
    sshDir: opts?.sshDir,
  });

  const { server, store, capAuthority } = createSSHKeyServer(manager, {
    readOnly: opts?.readOnly,
  });

  // Issue default capabilities — 1h TTL
  const sessionId = "ssh-key-session";
  const readCap = capAuthority.issue(sessionId, "resource:read", "**", {
    ttl_seconds: 3600,
  });
  const writeCap = capAuthority.issue(sessionId, "resource:write", "**", {
    ttl_seconds: 3600,
  });

  return {
    manager,
    server,
    store,
    capAuthority,
    capabilities: { read: readCap, write: writeCap },
  };
}

// Direct execution: launch and log
if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  launchSSHKeyServer()
    .then(({ server }) => {
      console.log(`AXON SSH Key Manager server started with ${server.toolCount} tools`);
      console.log(`Manifest tokens: ~${server.estimateManifestTokens()}`);
      console.log("Tools:", server.getManifest().map((t) => t.id).join(", "));
    })
    .catch((err) => {
      console.error("Failed to launch:", err.message);
      process.exit(1);
    });
}
