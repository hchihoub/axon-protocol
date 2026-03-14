/**
 * AXON Chrome Server — Entry Point
 *
 * Launches Puppeteer browser, creates the AXON server,
 * and exposes it via both native AXON and MCP-compatible protocols.
 */

import { BrowserManager } from "./browser.js";
import { createChromeServer } from "./server.js";

export { BrowserManager } from "./browser.js";
export { createChromeServer } from "./server.js";

export interface ChromeServerOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
  executablePath?: string;
  allowedDomains?: string[];
}

/**
 * Launch the AXON Chrome server.
 * Returns the browser manager, AXON server, and cleanup function.
 */
export async function launchChromeServer(opts?: ChromeServerOptions) {
  const browser = new BrowserManager({
    headless: opts?.headless ?? false,
    defaultViewport: opts?.viewport ?? { width: 1280, height: 800 },
    executablePath: opts?.executablePath,
    args: [
      "--no-first-run",
      "--disable-default-apps",
      "--disable-popup-blocking",
    ],
  });

  await browser.launch();

  const { server, store, capAuthority } = createChromeServer(browser);

  // Issue default capabilities
  const sessionId = "chrome-session";
  const readCap = capAuthority.issue(sessionId, "resource:read", "**", {
    ttl_seconds: 86400,
  });
  const writeCap = capAuthority.issue(sessionId, "resource:write", "**", {
    ttl_seconds: 86400,
  });

  return {
    browser,
    server,
    store,
    capAuthority,
    capabilities: { read: readCap, write: writeCap },
    async shutdown() {
      await browser.close();
    },
  };
}

// Direct execution: launch and log
if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  launchChromeServer().then(({ server }) => {
    console.log(`AXON Chrome server started with ${server.toolCount} tools`);
    console.log(`Manifest tokens: ~${server.estimateManifestTokens()}`);
    console.log("Tools:", server.getManifest().map((t) => t.id).join(", "));
  });
}
