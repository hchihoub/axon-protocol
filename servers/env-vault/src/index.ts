/**
 * AXON ENV/Secrets Vault Server — Entry Point
 *
 * Creates the ENV Vault Manager, registers AXON tools,
 * and exposes them via both native AXON and MCP-compatible protocols.
 *
 * No external dependencies — uses Node.js fs only.
 */

import { EnvVaultManager } from "./env-vault-manager.js";
import { createEnvVaultServer } from "./server.js";

export { EnvVaultManager } from "./env-vault-manager.js";
export { createEnvVaultServer } from "./server.js";

export type {
  EnvFile,
  EnvVariable,
  EnvReadResult,
  SecretMatch,
  EnvComparison,
  EnvVaultConfig,
} from "./env-vault-manager.js";

export interface EnvVaultServerOptions {
  /** Root directory for scanning (default: cwd or AXON_VAULT_ROOT) */
  rootDir?: string;
  /** Max directory depth for scanning (default: 5) */
  maxDepth?: number;
  /** Restrict server to read-only operations */
  readOnly?: boolean;
}

/**
 * Launch the AXON ENV/Secrets Vault server.
 * Returns the manager, AXON server, and related objects.
 *
 * @example
 * ```typescript
 * const { server, manager } = await launchEnvVaultServer({ rootDir: "/projects" });
 * console.log(`${server.toolCount} tools ready`);
 *
 * const result = await server.execute({
 *   id: 1,
 *   tool: "scan_env_files",
 *   params: {},
 *   capability: "",
 * }, { sessionId: "demo", streamId: 1, reportProgress: () => {}, isCancelled: () => false });
 * ```
 */
export async function launchEnvVaultServer(opts?: EnvVaultServerOptions) {
  const manager = new EnvVaultManager({
    rootDir: opts?.rootDir,
    maxDepth: opts?.maxDepth,
  });

  const { server, store, capAuthority } = createEnvVaultServer(manager, {
    readOnly: opts?.readOnly,
  });

  // Issue default capabilities — 1h TTL
  const sessionId = "env-vault-session";
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
  launchEnvVaultServer()
    .then(({ server }) => {
      console.log(`AXON ENV Vault server started with ${server.toolCount} tools`);
      console.log(`Manifest tokens: ~${server.estimateManifestTokens()}`);
      console.log("Tools:", server.getManifest().map((t) => t.id).join(", "));
    })
    .catch((err) => {
      console.error("Failed to launch:", err.message);
      process.exit(1);
    });
}
