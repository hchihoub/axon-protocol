/**
 * AXON System Monitor Server — Entry Point
 *
 * Creates the system monitor and AXON server.
 * Exposes it via both native AXON and MCP-compatible protocols.
 */

import { SystemMonitor } from "./system-monitor.js";
import { createSystemMonitorServer } from "./server.js";

export { SystemMonitor } from "./system-monitor.js";
export { createSystemMonitorServer } from "./server.js";

export type {
  SystemInfo,
  CpuUsage,
  MemoryUsage,
  DiskUsage,
  ProcessInfo,
  ProcessList,
  NetworkInfo,
} from "./system-monitor.js";

export type { SystemMonitorServerConfig } from "./server.js";

export interface SystemMonitorServerOptions {
  /** Restrict server to read-only operations */
  readOnly?: boolean;
}

/**
 * Launch the AXON System Monitor server.
 * Returns the system monitor, AXON server, and cleanup function.
 *
 * @example
 * ```typescript
 * const { server, sm } = await launchSystemMonitorServer();
 * console.log(`${server.toolCount} tools ready`);
 *
 * const result = await server.execute({
 *   id: 1,
 *   tool: "get_system_info",
 *   params: {},
 *   capability: "",
 * }, { sessionId: "demo", streamId: 1, reportProgress: () => {}, isCancelled: () => false });
 * ```
 */
export async function launchSystemMonitorServer(opts?: SystemMonitorServerOptions) {
  const sm = new SystemMonitor();

  const { server, store, capAuthority } = createSystemMonitorServer(sm, {
    readOnly: opts?.readOnly,
  });

  // Issue default capabilities — 1h TTL
  const sessionId = "sysmon-session";
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
  launchSystemMonitorServer()
    .then(({ server }) => {
      console.log(`AXON System Monitor server started with ${server.toolCount} tools`);
      console.log(`Manifest tokens: ~${server.estimateManifestTokens()}`);
      console.log("Tools:", server.getManifest().map((t) => t.id).join(", "));
    })
    .catch((err) => {
      console.error("Failed to launch:", err.message);
      process.exit(1);
    });
}
