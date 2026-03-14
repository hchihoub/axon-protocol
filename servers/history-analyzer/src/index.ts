/**
 * AXON History Analyzer Server — Entry Point
 *
 * Launches Chrome with user profile, creates the AXON server,
 * and exposes it via both native AXON and MCP-compatible protocols.
 *
 * IMPORTANT: Chrome must be fully closed before launching.
 * Puppeteer cannot share a profile directory with a running Chrome instance.
 */

import { HistoryAnalyzer } from "./history-analyzer.js";
import { createHistoryAnalyzerServer } from "./server.js";

export { HistoryAnalyzer } from "./history-analyzer.js";
export { createHistoryAnalyzerServer } from "./server.js";

export type {
  HistoryEntry,
  MostVisitedSite,
  HistoryAnalyzerConfig,
} from "./history-analyzer.js";

export interface HistoryAnalyzerServerOptions {
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
 * Launch the AXON History Analyzer server.
 * Returns the history analyzer, AXON server, and cleanup function.
 *
 * @example
 * ```typescript
 * const { server, ha, shutdown } = await launchHistoryAnalyzerServer();
 * console.log(`${server.toolCount} tools ready`);
 *
 * const result = await server.execute({
 *   id: 1,
 *   tool: "search_history",
 *   params: { query: "github" },
 *   capability: "",
 * }, { sessionId: "demo", streamId: 1, reportProgress: () => {}, isCancelled: () => false });
 *
 * await shutdown();
 * ```
 */
export async function launchHistoryAnalyzerServer(opts?: HistoryAnalyzerServerOptions) {
  const ha = new HistoryAnalyzer({
    headless: opts?.headless ?? false,
    userDataDir: opts?.userDataDir,
    profileName: opts?.profileName ?? "Default",
    executablePath: opts?.executablePath,
    viewport: opts?.viewport ?? { width: 1280, height: 900 },
  });

  await ha.launch();

  const { server, store, capAuthority } = createHistoryAnalyzerServer(ha, {
    readOnly: opts?.readOnly,
  });

  const sessionId = "history-session";
  const readCap = capAuthority.issue(sessionId, "resource:read", "**", {
    ttl_seconds: 3600,
  });
  const writeCap = capAuthority.issue(sessionId, "resource:write", "**", {
    ttl_seconds: 3600,
  });

  return {
    ha,
    server,
    store,
    capAuthority,
    capabilities: { read: readCap, write: writeCap },
    async shutdown() {
      await ha.close();
    },
  };
}

// Direct execution: launch and log
if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  launchHistoryAnalyzerServer()
    .then(({ server }) => {
      console.log(`AXON History Analyzer server started with ${server.toolCount} tools`);
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
