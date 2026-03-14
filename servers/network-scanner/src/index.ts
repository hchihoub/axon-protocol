/**
 * AXON Network Scanner Server — Entry Point
 *
 * Creates the Network Scanner, registers AXON tools,
 * and exposes them via both native AXON and MCP-compatible protocols.
 *
 * No external dependencies — uses Node.js net, dns, http/https,
 * and child_process.execFile for system commands.
 */

import { NetworkScanner } from "./network-scanner.js";
import { createNetworkScannerServer } from "./server.js";

export { NetworkScanner } from "./network-scanner.js";
export { createNetworkScannerServer } from "./server.js";

export type {
  PortScanResult,
  PortScanSummary,
  LocalDevice,
  DNSRecord,
  DNSLookupResult,
  PingResult,
  NetworkInterface,
  URLCheckResult,
  TracerouteHop,
  TracerouteResult,
  NetworkScannerConfig,
} from "./network-scanner.js";

export interface NetworkScannerServerOptions {
  /** Default timeout for port scans in ms (default: 2000) */
  portTimeout?: number;
  /** Default timeout for ping in seconds (default: 5) */
  pingTimeout?: number;
  /** Max concurrent port scans (default: 100) */
  maxConcurrentScans?: number;
}

/**
 * Launch the AXON Network Scanner server.
 * Returns the scanner, AXON server, and related objects.
 *
 * @example
 * ```typescript
 * const { server, scanner } = await launchNetworkScannerServer();
 * console.log(`${server.toolCount} tools ready`);
 *
 * const result = await server.execute({
 *   id: 1,
 *   tool: "scan_ports",
 *   params: { host: "localhost", startPort: 80, endPort: 443 },
 *   capability: "",
 * }, { sessionId: "demo", streamId: 1, reportProgress: () => {}, isCancelled: () => false });
 * ```
 */
export async function launchNetworkScannerServer(opts?: NetworkScannerServerOptions) {
  const scanner = new NetworkScanner({
    portTimeout: opts?.portTimeout,
    pingTimeout: opts?.pingTimeout,
    maxConcurrentScans: opts?.maxConcurrentScans,
  });

  const { server, store, capAuthority } = createNetworkScannerServer(scanner);

  // Issue default capabilities — 1h TTL (all tools are read-only)
  const sessionId = "network-scanner-session";
  const readCap = capAuthority.issue(sessionId, "resource:read", "**", {
    ttl_seconds: 3600,
  });

  return {
    scanner,
    server,
    store,
    capAuthority,
    capabilities: { read: readCap },
  };
}

// Direct execution: launch and log
if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  launchNetworkScannerServer()
    .then(({ server }) => {
      console.log(`AXON Network Scanner server started with ${server.toolCount} tools`);
      console.log(`Manifest tokens: ~${server.estimateManifestTokens()}`);
      console.log("Tools:", server.getManifest().map((t) => t.id).join(", "));
    })
    .catch((err) => {
      console.error("Failed to launch:", err.message);
      process.exit(1);
    });
}
