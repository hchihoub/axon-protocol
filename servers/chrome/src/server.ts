/**
 * AXON Chrome Server — Tool Definitions
 *
 * 15 browser automation tools registered with AXON's 3-tier discovery:
 *   Tier 1: Compact manifests (~20 tokens/tool) — always in context
 *   Tier 2: Full schemas — fetched on demand when model calls a tool
 *   Tier 3: Extended docs — rare, on explicit request
 *
 * Results go through OCRS:
 *   - Screenshots → base64 stored in OCRS, summary in context ("1280x800 PNG of google.com")
 *   - Page text → stored in OCRS, summary in context ("342 lines, title: ...")
 *   - Accessibility trees → stored in OCRS, interactive element count in context
 *
 * Capabilities enforce domain scoping:
 *   - "resource:read" scoped to allowed domains
 *   - "resource:write" required for click/type/navigate
 */

import { AxonServer } from "../../../sdk/src/server.js";
import { ResultStore } from "../../../sdk/src/ocrs.js";
import { CapabilityAuthority } from "../../../sdk/src/capability.js";
import { BrowserManager } from "./browser.js";

export interface ChromeServerConfig {
  /** Glob patterns for allowed domains (e.g. ["*.google.com", "github.com"]) */
  allowedDomains?: string[];
}

export function createChromeServer(browser: BrowserManager, config?: ChromeServerConfig): {
  server: AxonServer;
  store: ResultStore;
  capAuthority: CapabilityAuthority;
} {
  const server = new AxonServer({ name: "axon-chrome", version: "0.1.0" });
  const store = new ResultStore({ max_summary_tokens: 300, max_total_result_tokens: 6000 });

  const key = Buffer.alloc(32);
  Buffer.from(Date.now().toString(16).padStart(32, "0"), "hex").copy(key);
  const capAuthority = new CapabilityAuthority("axon-chrome", key, key);

  // Domain scoping — if allowedDomains is set, check URLs before navigation
  const allowedDomains = config?.allowedDomains;

  function checkDomain(url: string): void {
    if (!allowedDomains || allowedDomains.length === 0) return;
    try {
      const hostname = new URL(url.startsWith("http") ? url : `https://${url}`).hostname;
      const allowed = allowedDomains.some((pattern) => {
        if (pattern.startsWith("*.")) {
          const suffix = pattern.slice(2);
          return hostname === suffix || hostname.endsWith(`.${suffix}`);
        }
        return hostname === pattern;
      });
      if (!allowed) {
        throw new Error(`Domain '${hostname}' not in allowed list: ${allowedDomains.join(", ")}`);
      }
    } catch (err: any) {
      if (err.message.startsWith("Domain")) throw err;
      // URL parsing failed — let it through, Puppeteer will handle it
    }
  }

  // ==========================================================================
  // Tab Management
  // ==========================================================================

  server.tool({
    id: "tabs_list",
    summary: "List all open browser tabs",
    description: "List all open tabs with their IDs, URLs, and titles. Use this to discover available tabs before interacting with them.",
    category: "tabs",
    tags: ["tabs", "list", "browse"],
    input: {
      type: "object",
      properties: {},
    },
    annotations: { read_only: true, idempotent: true, estimated_latency_ms: 50, max_result_size_bytes: 5000 },
    handler: async () => {
      return browser.listTabsDetailed();
    },
    summarizer: (tabs: any[]) => `${tabs.length} tab(s): ${tabs.map((t: any) => `[${t.tabId}] ${t.title || t.url}`).join(", ")}`,
  });

  server.tool({
    id: "tab_create",
    summary: "Open a new browser tab",
    description: "Create a new browser tab, optionally navigating to a URL. Returns the new tab ID.",
    category: "tabs",
    tags: ["tabs", "create", "new"],
    input: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open (optional, defaults to blank page)" },
      },
    },
    annotations: { read_only: false, idempotent: false, estimated_latency_ms: 2000, max_result_size_bytes: 200 },
    handler: async ({ url }: any) => {
      if (url) checkDomain(url);
      return browser.createTab(url);
    },
    summarizer: (r: any) => `Created tab ${r.tabId}${r.url !== "about:blank" ? ` → ${r.url}` : ""}`,
  });

  server.tool({
    id: "tab_close",
    summary: "Close a browser tab",
    description: "Close the specified browser tab by its ID.",
    category: "tabs",
    tags: ["tabs", "close"],
    input: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Tab ID to close" },
      },
      required: ["tabId"],
    },
    annotations: { read_only: false, idempotent: true, estimated_latency_ms: 100, max_result_size_bytes: 100 },
    handler: async ({ tabId }: any) => {
      await browser.closeTab(tabId);
      return { closed: true, tabId };
    },
    summarizer: (r: any) => `Closed tab ${r.tabId}`,
  });

  // ==========================================================================
  // Navigation
  // ==========================================================================

  server.tool({
    id: "navigate",
    summary: "Navigate tab to a URL",
    description: "Navigate a browser tab to the specified URL. Waits for the page to load. Supports 'back' and 'forward' as special URLs for history navigation.",
    category: "navigation",
    tags: ["navigate", "url", "browse"],
    input: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Tab ID to navigate" },
        url: { type: "string", description: "URL to navigate to, or 'back'/'forward' for history" },
      },
      required: ["tabId", "url"],
    },
    capabilities_required: ["resource:write"],
    annotations: { read_only: false, idempotent: false, estimated_latency_ms: 3000, max_result_size_bytes: 500 },
    handler: async ({ tabId, url }: any) => {
      if (url === "back") return browser.goBack(tabId);
      if (url === "forward") return browser.goForward(tabId);
      checkDomain(url);
      return browser.navigate(tabId, url);
    },
    summarizer: (r: any) => `Navigated to "${r.title}" (${r.url})${r.status ? ` [${r.status}]` : ""}`,
  });

  // ==========================================================================
  // Screenshots (OCRS: store full base64, inject summary)
  // ==========================================================================

  server.tool({
    id: "screenshot",
    summary: "Take a screenshot of the page",
    description: "Capture a PNG screenshot of the current page or a specific element. Full image is stored in OCRS; context gets a compact summary.",
    category: "capture",
    tags: ["screenshot", "capture", "visual"],
    input: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Tab ID to screenshot" },
        fullPage: { type: "boolean", description: "Capture the full scrollable page (default: false)" },
        selector: { type: "string", description: "CSS selector to screenshot a specific element" },
      },
      required: ["tabId"],
    },
    annotations: { read_only: true, idempotent: true, estimated_latency_ms: 500, max_result_size_bytes: 5_000_000 },
    handler: async ({ tabId, fullPage, selector }: any) => {
      const info = await browser.getPageInfo(tabId);
      const shot = await browser.screenshot(tabId, { fullPage, selector });
      return {
        ...shot,
        url: info.url,
        title: info.title,
        selector: selector ?? null,
      };
    },
    summarizer: (r: any) => {
      const kb = Math.round(r.bytes / 1024);
      return `Screenshot ${r.width}x${r.height} (${kb}KB) of "${r.title}"${r.selector ? ` [${r.selector}]` : ""}`;
    },
  });

  // ==========================================================================
  // DOM Interaction
  // ==========================================================================

  server.tool({
    id: "click",
    summary: "Click an element on the page",
    description: "Click a page element by CSS selector or coordinates. Supports left/right/middle click and double-click.",
    category: "interaction",
    tags: ["click", "interact", "dom"],
    input: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Tab ID" },
        selector: { type: "string", description: "CSS selector of element to click" },
        x: { type: "number", description: "X coordinate (alternative to selector)" },
        y: { type: "number", description: "Y coordinate (alternative to selector)" },
        button: { type: "string", description: "Mouse button: left, right, middle", enum: ["left", "right", "middle"] },
        clickCount: { type: "number", description: "Number of clicks (2 for double-click)" },
      },
      required: ["tabId"],
    },
    capabilities_required: ["resource:write"],
    annotations: { read_only: false, idempotent: false, estimated_latency_ms: 200, max_result_size_bytes: 200 },
    handler: async ({ tabId, selector, x, y, button, clickCount }: any) => {
      if (typeof x === "number" && typeof y === "number") {
        return browser.clickAtCoords(tabId, x, y);
      }
      if (!selector) throw new Error("Provide either 'selector' or 'x'+'y' coordinates");
      return browser.click(tabId, selector, { button, clickCount });
    },
    summarizer: (r: any) => `Clicked ${r.selector ?? `(${r.x},${r.y})`}`,
  });

  server.tool({
    id: "type_text",
    summary: "Type text into an input element",
    description: "Type text into a focused element or a specific input by CSS selector. Can optionally clear the field first.",
    category: "interaction",
    tags: ["type", "input", "form"],
    input: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Tab ID" },
        selector: { type: "string", description: "CSS selector of the input element" },
        text: { type: "string", description: "Text to type" },
        clear: { type: "boolean", description: "Clear the field before typing (default: false)" },
        delay: { type: "number", description: "Delay between keystrokes in ms (default: 0)" },
      },
      required: ["tabId", "selector", "text"],
    },
    capabilities_required: ["resource:write"],
    annotations: { read_only: false, idempotent: false, estimated_latency_ms: 300, max_result_size_bytes: 200 },
    handler: async ({ tabId, selector, text, clear, delay }: any) => {
      return browser.type(tabId, selector, text, { clear, delay });
    },
    summarizer: (r: any) => `Typed ${r.length} chars into ${r.selector}`,
  });

  server.tool({
    id: "press_key",
    summary: "Press a keyboard key",
    description: "Press a keyboard key like Enter, Tab, Escape, ArrowDown, etc.",
    category: "interaction",
    tags: ["key", "keyboard", "press"],
    input: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Tab ID" },
        key: { type: "string", description: "Key to press (e.g., 'Enter', 'Tab', 'Escape', 'ArrowDown')" },
      },
      required: ["tabId", "key"],
    },
    capabilities_required: ["resource:write"],
    annotations: { read_only: false, idempotent: false, estimated_latency_ms: 50, max_result_size_bytes: 100 },
    handler: async ({ tabId, key }: any) => {
      return browser.pressKey(tabId, key);
    },
    summarizer: (r: any) => `Pressed ${r.key}`,
  });

  server.tool({
    id: "scroll",
    summary: "Scroll the page",
    description: "Scroll the page in a given direction by a pixel amount.",
    category: "interaction",
    tags: ["scroll", "navigate"],
    input: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Tab ID" },
        direction: { type: "string", description: "Scroll direction", enum: ["up", "down", "left", "right"] },
        amount: { type: "number", description: "Pixels to scroll (default: 300)" },
      },
      required: ["tabId", "direction"],
    },
    annotations: { read_only: false, idempotent: false, estimated_latency_ms: 50, max_result_size_bytes: 100 },
    handler: async ({ tabId, direction, amount }: any) => {
      await browser.scroll(tabId, direction, amount);
      return { scrolled: true, direction, amount: amount ?? 300 };
    },
    summarizer: (r: any) => `Scrolled ${r.direction} ${r.amount}px`,
  });

  // ==========================================================================
  // Content Extraction (OCRS: store full content, inject summary)
  // ==========================================================================

  server.tool({
    id: "get_text",
    summary: "Extract text content from page",
    description: "Extract the main text content from the page, prioritizing article/main content. Full text stored in OCRS; context gets a compact summary.",
    category: "content",
    tags: ["text", "extract", "read"],
    input: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Tab ID" },
      },
      required: ["tabId"],
    },
    annotations: { read_only: true, idempotent: true, estimated_latency_ms: 200, max_result_size_bytes: 1_000_000 },
    handler: async ({ tabId }: any) => {
      return browser.getPageText(tabId);
    },
    summarizer: (r: any) => {
      const lines = r.text.split("\n").length;
      const chars = r.text.length;
      const preview = r.text.slice(0, 120).replace(/\n/g, " ");
      return `"${r.title}" — ${lines} lines (${chars} chars). Preview: "${preview}"`;
    },
  });

  server.tool({
    id: "read_page",
    summary: "Get page accessibility tree",
    description: "Get a structured accessibility tree of the page showing elements, roles, labels, and interactive controls. Useful for understanding page structure without a screenshot.",
    category: "content",
    tags: ["accessibility", "tree", "structure", "read"],
    input: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Tab ID" },
        selector: { type: "string", description: "CSS selector to scope the tree (default: full page)" },
        interactiveOnly: { type: "boolean", description: "Only return interactive elements (buttons, links, inputs)" },
        maxDepth: { type: "number", description: "Max tree depth (default: 10)" },
      },
      required: ["tabId"],
    },
    annotations: { read_only: true, idempotent: true, estimated_latency_ms: 300, max_result_size_bytes: 500_000 },
    handler: async ({ tabId, selector, interactiveOnly, maxDepth }: any) => {
      const tree = await browser.getAccessibilityTree(tabId, { selector, interactiveOnly, maxDepth });
      const info = await browser.getPageInfo(tabId);
      return { tree, url: info.url, title: info.title };
    },
    summarizer: (r: any) => {
      function countNodes(node: any): { total: number; interactive: number } {
        if (!node) return { total: 0, interactive: 0 };
        const interactiveTags = new Set(["a", "button", "input", "textarea", "select"]);
        let total = 1;
        let interactive = interactiveTags.has(node.tag) ? 1 : 0;
        for (const child of node.children ?? []) {
          const c = countNodes(child);
          total += c.total;
          interactive += c.interactive;
        }
        return { total, interactive };
      }
      const counts = countNodes(r.tree);
      return `"${r.title}" — ${counts.total} elements, ${counts.interactive} interactive (${r.url})`;
    },
  });

  server.tool({
    id: "find",
    summary: "Find elements by selector or text",
    description: "Find elements on the page by CSS selector or text content. Returns up to 20 matches with selectors you can use for click/type.",
    category: "content",
    tags: ["find", "search", "element", "query"],
    input: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Tab ID" },
        query: { type: "string", description: "CSS selector or text to search for" },
      },
      required: ["tabId", "query"],
    },
    annotations: { read_only: true, idempotent: true, estimated_latency_ms: 200, max_result_size_bytes: 50_000 },
    handler: async ({ tabId, query }: any) => {
      return browser.findElements(tabId, query);
    },
    summarizer: (r: any) => {
      const count = r.elements.length;
      const visible = r.elements.filter((e: any) => e.visible).length;
      const sample = r.elements.slice(0, 3).map((e: any) => `<${e.tag}>${e.text.slice(0, 30)}`).join(", ");
      return `${count} matches (${visible} visible): ${sample}`;
    },
  });

  // ==========================================================================
  // JavaScript Execution
  // ==========================================================================

  server.tool({
    id: "execute_js",
    summary: "Execute JavaScript on the page",
    description: "Execute a JavaScript expression in the context of the current page. Returns the result of the last expression. Use for reading page state, DOM queries, or debugging.",
    category: "execution",
    tags: ["javascript", "eval", "execute"],
    input: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Tab ID" },
        expression: { type: "string", description: "JavaScript expression to evaluate" },
      },
      required: ["tabId", "expression"],
    },
    capabilities_required: ["resource:write"],
    annotations: { read_only: false, idempotent: false, estimated_latency_ms: 100, max_result_size_bytes: 1_000_000 },
    handler: async ({ tabId, expression }: any) => {
      const result = await browser.evaluate(tabId, expression);
      return { result, type: typeof result };
    },
    summarizer: (r: any) => {
      const str = JSON.stringify(r.result);
      return `JS result (${r.type}): ${str?.slice(0, 120) ?? "undefined"}`;
    },
  });

  // ==========================================================================
  // Viewport
  // ==========================================================================

  server.tool({
    id: "set_viewport",
    summary: "Resize browser viewport",
    description: "Set the browser viewport dimensions. Use presets like 'mobile' (375x812), 'tablet' (768x1024), or custom width/height.",
    category: "viewport",
    tags: ["viewport", "resize", "responsive"],
    input: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Tab ID" },
        preset: { type: "string", description: "Device preset", enum: ["mobile", "tablet", "desktop"] },
        width: { type: "number", description: "Custom width in pixels" },
        height: { type: "number", description: "Custom height in pixels" },
      },
      required: ["tabId"],
    },
    annotations: { read_only: false, idempotent: true, estimated_latency_ms: 100, max_result_size_bytes: 200 },
    handler: async ({ tabId, preset, width, height }: any) => {
      const presets: Record<string, [number, number]> = {
        mobile: [375, 812],
        tablet: [768, 1024],
        desktop: [1280, 800],
      };
      const [w, h] = preset ? presets[preset] ?? [1280, 800] : [width ?? 1280, height ?? 800];
      await browser.setViewport(tabId, w, h);
      return { width: w, height: h, preset: preset ?? "custom" };
    },
    summarizer: (r: any) => `Viewport set to ${r.width}x${r.height} (${r.preset})`,
  });

  return { server, store, capAuthority };
}
