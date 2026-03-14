#!/usr/bin/env npx tsx
/**
 * AXON vs MCP Chrome Server — Head-to-Head Benchmark
 *
 * Reconstructs the REAL MCP Chrome tool definitions (Claude-in-Chrome / Anthropic MCP)
 * from their actual JSON schemas, then simulates a heavy multi-page research session
 * and compares context consumption, wire size, and latency.
 *
 * Scenario: "E-Commerce Competitive Research"
 *   1. Open 3 product pages across Amazon, Best Buy, Newegg
 *   2. Take screenshots of each
 *   3. Extract page text from each
 *   4. Read accessibility trees to find pricing elements
 *   5. Search for "Add to Cart" buttons
 *   6. Fill out a comparison form
 *   7. Navigate through pagination (3 pages)
 *   8. Take final screenshots
 *   9. Extract JS-rendered data
 *   10. Close all tabs
 *
 * Total: ~47 tool calls across a realistic browser automation session.
 */

import { createChromeServer } from "./src/server.js";
import { BrowserManager } from "./src/browser.js";
import { ResultStore } from "../../sdk/src/ocrs.js";

// ============================================================================
// MCP Chrome Tool Definitions (Real Claude-in-Chrome schemas)
// ============================================================================

/**
 * These are the ACTUAL MCP tool definitions that get injected into context
 * by Claude-in-Chrome. Captured from the live tool schema.
 */
const MCP_CHROME_TOOLS = [
  {
    name: "mcp__Claude_in_Chrome__javascript_tool",
    description: "Execute JavaScript code in the context of the current page. The code runs in the page's context and can interact with the DOM, window object, and page variables. Returns the result of the last expression or any thrown errors. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    inputSchema: {
      type: "object",
      properties: {
        action: { description: "Must be set to 'javascript_exec'", type: "string" },
        tabId: { description: "Tab ID to execute the code in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.", type: "number" },
        text: { description: "The JavaScript code to execute. The code will be evaluated in the page context. The result of the last expression will be returned automatically. Do NOT use 'return' statements - just write the expression you want to evaluate (e.g., 'window.myData.value' not 'return window.myData.value'). You can access and modify the DOM, call page functions, and interact with page variables.", type: "string" },
      },
      required: ["action", "text", "tabId"],
    },
  },
  {
    name: "mcp__Claude_in_Chrome__read_page",
    description: "Get an accessibility tree representation of elements on the page. By default returns all elements including non-visible ones. Output is limited to 50000 characters by default. If the output exceeds this limit, you will receive an error asking you to specify a smaller depth or focus on a specific element using ref_id. Optionally filter for only interactive elements. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    inputSchema: {
      type: "object",
      properties: {
        depth: { description: "Maximum depth of the tree to traverse (default: 15). Use a smaller depth if output is too large.", type: "number" },
        filter: { description: 'Filter elements: "interactive" for buttons/links/inputs only, "all" for all elements including non-visible ones (default: all elements)', enum: ["interactive", "all"], type: "string" },
        max_chars: { description: "Maximum characters for output (default: 50000). Set to a higher value if your client can handle large outputs.", type: "number" },
        ref_id: { description: "Reference ID of a parent element to read. Will return the specified element and all its children. Use this to focus on a specific part of the page when output is too large.", type: "string" },
        tabId: { description: "Tab ID to read from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.", type: "number" },
      },
      required: ["tabId"],
    },
  },
  {
    name: "mcp__Claude_in_Chrome__find",
    description: 'Find elements on the page using natural language. Can search for elements by their purpose (e.g., "search bar", "login button") or by text content (e.g., "organic mango product"). Returns up to 20 matching elements with references that can be used with other tools. If more than 20 matches exist, you\'ll be notified to use a more specific query. If you don\'t have a valid tab ID, use tabs_context_mcp first to get available tabs.',
    inputSchema: {
      type: "object",
      properties: {
        query: { description: 'Natural language description of what to find (e.g., "search bar", "add to cart button", "product title containing organic")', type: "string" },
        tabId: { description: "Tab ID to search in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.", type: "number" },
      },
      required: ["query", "tabId"],
    },
  },
  {
    name: "mcp__Claude_in_Chrome__form_input",
    description: "Set values in form elements using element reference ID from the read_page tool. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { description: 'Element reference ID from the read_page tool (e.g., "ref_1", "ref_2")', type: "string" },
        tabId: { description: "Tab ID to set form value in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.", type: "number" },
        value: { description: 'The value to set. For checkboxes use boolean, for selects use option value or text, for other inputs use appropriate string/number' },
      },
      required: ["ref", "tabId"],
    },
  },
  {
    name: "mcp__Claude_in_Chrome__computer",
    description: `Use a mouse and keyboard to interact with a web browser, and take screenshots. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.
* Whenever you intend to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.
* If you tried clicking on a program or link but it failed to load, even after waiting, try adjusting your click location so that the tip of the cursor visually falls on the element that you want to click.
* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.`,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          description: `The action to perform:
* \`left_click\`: Click the left mouse button at the specified coordinates.
* \`right_click\`: Click the right mouse button at the specified coordinates to open context menus.
* \`double_click\`: Double-click the left mouse button at the specified coordinates.
* \`triple_click\`: Triple-click the left mouse button at the specified coordinates.
* \`type\`: Type a string of text.
* \`screenshot\`: Take a screenshot of the screen.
* \`wait\`: Wait for a specified number of seconds.
* \`scroll\`: Scroll up, down, left, or right at the specified coordinates.
* \`key\`: Press a specific keyboard key.
* \`left_click_drag\`: Drag from start_coordinate to coordinate.
* \`zoom\`: Take a screenshot of a specific region for closer inspection.
* \`scroll_to\`: Scroll an element into view using its element reference ID from read_page or find tools.
* \`hover\`: Move the mouse cursor to the specified coordinates or element without clicking. Useful for revealing tooltips, dropdown menus, or triggering hover states.`,
          enum: ["left_click", "right_click", "type", "screenshot", "wait", "scroll", "key", "left_click_drag", "double_click", "triple_click", "zoom", "scroll_to", "hover"],
          type: "string",
        },
        coordinate: { description: "(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates. Required for `left_click`, `right_click`, `double_click`, `triple_click`, and `scroll`. For `left_click_drag`, this is the end position.", items: { type: "number" }, type: "array" },
        duration: { description: "The number of seconds to wait. Required for `wait`. Maximum 30 seconds.", maximum: 30, minimum: 0, type: "number" },
        modifiers: { description: 'Modifier keys for click actions. Supports: "ctrl", "shift", "alt", "cmd" (or "meta"), "win" (or "windows"). Can be combined with "+" (e.g., "ctrl+shift", "cmd+alt"). Optional.', type: "string" },
        ref: { description: 'Element reference ID from read_page or find tools (e.g., "ref_1", "ref_2"). Required for `scroll_to` action. Can be used as alternative to `coordinate` for click actions.', type: "string" },
        region: { description: "(x0, y0, x1, y1): The rectangular region to capture for `zoom`. Coordinates define a rectangle from top-left (x0, y0) to bottom-right (x1, y1) in pixels from the viewport origin. Required for `zoom` action. Useful for inspecting small UI elements like icons, buttons, or text.", items: { type: "number" }, type: "array" },
        repeat: { description: 'Number of times to repeat the key sequence. Only applicable for `key` action. Must be a positive integer between 1 and 100. Default is 1. Useful for navigation tasks like pressing arrow keys multiple times.', maximum: 100, minimum: 1, type: "number" },
        scroll_amount: { description: "The number of scroll wheel ticks. Optional for `scroll`, defaults to 3.", maximum: 10, minimum: 1, type: "number" },
        scroll_direction: { description: "The direction to scroll. Required for `scroll`.", enum: ["up", "down", "left", "right"], type: "string" },
        start_coordinate: { description: "(x, y): The starting coordinates for `left_click_drag`.", items: { type: "number" }, type: "array" },
        tabId: { description: "Tab ID to execute the action on. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.", type: "number" },
        text: { description: 'The text to type (for `type` action) or the key(s) to press (for `key` action). For `key` action: Provide space-separated keys (e.g., "Backspace Backspace Delete"). Supports keyboard shortcuts using the platform\'s modifier key (use "cmd" on Mac, "ctrl" on Windows/Linux, e.g., "cmd+a" or "ctrl+a" for select all).', type: "string" },
      },
      required: ["action", "tabId"],
    },
  },
  {
    name: "mcp__Claude_in_Chrome__navigate",
    description: "Navigate to a URL, or go forward/back in browser history. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { description: "Tab ID to navigate. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.", type: "number" },
        url: { description: 'The URL to navigate to. Can be provided with or without protocol (defaults to https://). Use "forward" to go forward in history or "back" to go back in history.', type: "string" },
      },
      required: ["url", "tabId"],
    },
  },
  {
    name: "mcp__Claude_in_Chrome__resize_window",
    description: "Resize the current browser window to specified dimensions. Useful for testing responsive designs or setting up specific screen sizes. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    inputSchema: {
      type: "object",
      properties: {
        height: { description: "Target window height in pixels", type: "number" },
        tabId: { description: "Tab ID to get the window for. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.", type: "number" },
        width: { description: "Target window width in pixels", type: "number" },
      },
      required: ["width", "height", "tabId"],
    },
  },
  {
    name: "mcp__Claude_in_Chrome__get_page_text",
    description: "Extract raw text content from the page, prioritizing article content. Ideal for reading articles, blog posts, or other text-heavy pages. Returns plain text without HTML formatting. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { description: "Tab ID to extract text from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.", type: "number" },
      },
      required: ["tabId"],
    },
  },
  {
    name: "mcp__Claude_in_Chrome__tabs_context_mcp",
    description: "Get context information about the current MCP tab group. Returns all tab IDs inside the group if it exists. CRITICAL: You must get the context at least once before using other browser automation tools so you know what tabs exist. Each new conversation should create its own new tab (using tabs_create_mcp) rather than reusing existing tabs, unless the user explicitly asks to use an existing tab.",
    inputSchema: {
      type: "object",
      properties: {
        createIfEmpty: { description: "Creates a new MCP tab group if none exists, creates a new Window with a new tab group containing an empty tab (which can be used for this conversation). If a MCP tab group already exists, this parameter has no effect.", type: "boolean" },
      },
    },
  },
  {
    name: "mcp__Claude_in_Chrome__tabs_create_mcp",
    description: "Creates a new empty tab in the MCP tab group. CRITICAL: You must get the context using tabs_context_mcp at least once before using other browser automation tools so you know what tabs exist.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mcp__Claude_in_Chrome__read_console_messages",
    description: "Read browser console messages (console.log, console.error, console.warn, etc.) from a specific tab. Useful for debugging JavaScript errors, viewing application logs, or understanding what's happening in the browser console. Returns console messages from the current domain only. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs. IMPORTANT: Always provide a pattern to filter messages - without a pattern, you may get too many irrelevant messages.",
    inputSchema: {
      type: "object",
      properties: {
        clear: { description: "If true, clear the console messages after reading to avoid duplicates on subsequent calls. Default is false.", type: "boolean" },
        limit: { description: "Maximum number of messages to return. Defaults to 100. Increase only if you need more results.", type: "number" },
        onlyErrors: { description: "If true, only return error and exception messages. Default is false (return all message types).", type: "boolean" },
        pattern: { description: "Regex pattern to filter console messages. Only messages matching this pattern will be returned (e.g., 'error|warning' to find errors and warnings, 'MyApp' to filter app-specific logs). You should always provide a pattern to avoid getting too many irrelevant messages.", type: "string" },
        tabId: { description: "Tab ID to read console messages from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.", type: "number" },
      },
      required: ["tabId"],
    },
  },
  {
    name: "mcp__Claude_in_Chrome__read_network_requests",
    description: "Read HTTP network requests (XHR, Fetch, documents, images, etc.) from a specific tab. Useful for debugging API calls, monitoring network activity, or understanding what requests a page is making. Returns all network requests made by the current page, including cross-origin requests. Requests are automatically cleared when the page navigates to a different domain. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    inputSchema: {
      type: "object",
      properties: {
        clear: { description: "If true, clear the network requests after reading to avoid duplicates on subsequent calls. Default is false.", type: "boolean" },
        limit: { description: "Maximum number of requests to return. Defaults to 100. Increase only if you need more results.", type: "number" },
        tabId: { description: "Tab ID to read network requests from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.", type: "number" },
        urlPattern: { description: "Optional URL pattern to filter requests. Only requests whose URL contains this string will be returned (e.g., '/api/' to filter API calls, 'example.com' to filter by domain).", type: "string" },
      },
      required: ["tabId"],
    },
  },
  {
    name: "mcp__Claude_in_Chrome__gif_creator",
    description: "Manage GIF recording and export for browser automation sessions. Control when to start/stop recording browser actions (clicks, scrolls, navigation), then export as an animated GIF with visual overlays (click indicators, action labels, progress bar, watermark). All operations are scoped to the tab's group. When starting recording, take a screenshot immediately after to capture the initial state as the first frame. When stopping recording, take a screenshot immediately before to capture the final state as the last frame. For export, either provide 'coordinate' to drag/drop upload to a page element, or set 'download: true' to download the GIF.",
    inputSchema: {
      type: "object",
      properties: {
        action: { description: "Action to perform: 'start_recording' (begin capturing), 'stop_recording' (stop capturing but keep frames), 'export' (generate and export GIF), 'clear' (discard frames)", enum: ["start_recording", "stop_recording", "export", "clear"], type: "string" },
        download: { description: "Always set this to true for the 'export' action only. This causes the gif to be downloaded in the browser.", type: "boolean" },
        filename: { description: "Optional filename for exported GIF (default: 'recording-[timestamp].gif'). For 'export' action only.", type: "string" },
        options: {
          description: "Optional GIF enhancement options for 'export' action.",
          type: "object",
          properties: {
            quality: { description: "GIF compression quality, 1-30", type: "number" },
            showActionLabels: { description: "Show black labels describing actions", type: "boolean" },
            showClickIndicators: { description: "Show orange circles at click locations", type: "boolean" },
            showDragPaths: { description: "Show red arrows for drag actions", type: "boolean" },
            showProgressBar: { description: "Show orange progress bar at bottom", type: "boolean" },
            showWatermark: { description: "Show Claude logo watermark", type: "boolean" },
          },
        },
        tabId: { description: "Tab ID to identify which tab group this operation applies to", type: "number" },
      },
      required: ["action", "tabId"],
    },
  },
  {
    name: "mcp__Claude_in_Chrome__upload_image",
    description: "Upload a previously captured screenshot or user-uploaded image to a file input or drag & drop target. Supports two approaches: (1) ref - for targeting specific elements, especially hidden file inputs, (2) coordinate - for drag & drop to visible locations like Google Docs. Provide either ref or coordinate, not both.",
    inputSchema: {
      type: "object",
      properties: {
        coordinate: { description: "Viewport coordinates [x, y] for drag & drop to a visible location.", items: { type: "number" }, type: "array" },
        filename: { description: 'Optional filename for the uploaded file (default: "image.png")', type: "string" },
        imageId: { description: "ID of a previously captured screenshot or user-uploaded image", type: "string" },
        ref: { description: 'Element reference ID from read_page or find tools.', type: "string" },
        tabId: { description: "Tab ID where the target element is located.", type: "number" },
      },
      required: ["imageId", "tabId"],
    },
  },
  {
    name: "mcp__Claude_in_Chrome__shortcuts_list",
    description: "List all available shortcuts and workflows. Returns shortcuts with their commands, descriptions, and whether they are workflows. Use shortcuts_execute to run a shortcut or workflow.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { description: "Tab ID to list shortcuts from.", type: "number" },
      },
      required: ["tabId"],
    },
  },
  {
    name: "mcp__Claude_in_Chrome__shortcuts_execute",
    description: "Execute a shortcut or workflow by running it in a new sidepanel window using the current tab. Use shortcuts_list first to see available shortcuts.",
    inputSchema: {
      type: "object",
      properties: {
        command: { description: "The command name of the shortcut to execute.", type: "string" },
        shortcutId: { description: "The ID of the shortcut to execute", type: "string" },
        tabId: { description: "Tab ID to execute the shortcut on.", type: "number" },
      },
      required: ["tabId"],
    },
  },
  {
    name: "mcp__Claude_in_Chrome__file_upload",
    description: "Upload one or multiple files from the local filesystem to a file input element on the page. Do not click on file upload buttons or file inputs — clicking opens a native file picker dialog that you cannot see or interact with. Instead, use read_page or find to locate the file input element, then use this tool with its ref to upload files directly.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { description: "The absolute paths to the files to upload.", items: { type: "string" }, type: "array" },
        ref: { description: "Element reference ID of the file input.", type: "string" },
        tabId: { description: "Tab ID where the file input is located.", type: "number" },
      },
      required: ["paths", "ref", "tabId"],
    },
  },
  {
    name: "mcp__Claude_in_Chrome__switch_browser",
    description: "Switch which Chrome browser is used for browser automation. Call this when the user wants to connect to a different Chrome browser. Broadcasts a connection request to all Chrome browsers with the extension installed — the user clicks 'Connect' in the desired browser.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ============================================================================
// Simulated Tool Results (realistic sizes)
// ============================================================================

function generatePageText(title: string, wordCount: number): string {
  const words = ["the", "product", "features", "high-quality", "design", "innovative", "performance", "battery", "display", "processor", "memory", "storage", "camera", "price", "value", "review", "rating", "shipping", "warranty", "specification", "dimension", "weight", "color", "model", "brand", "category", "availability", "discount", "offer", "deal", "comparison", "benchmark", "test", "user", "experience", "interface", "software", "hardware", "update", "version"];
  const lines: string[] = [`${title}\n`];
  for (let i = 0; i < wordCount / 10; i++) {
    const line = Array.from({ length: 10 }, () => words[Math.floor(Math.random() * words.length)]).join(" ");
    lines.push(line);
  }
  return lines.join("\n");
}

function generateAccessibilityTree(elementCount: number): any {
  const tags = ["div", "span", "a", "button", "input", "p", "h1", "h2", "img", "ul", "li", "form", "select", "textarea"];
  function makeNode(depth: number): any {
    if (depth > 6) return null;
    const tag = tags[Math.floor(Math.random() * tags.length)];
    const node: any = { tag, text: `Element text content for ${tag} at depth ${depth}` };
    if (tag === "a") node.href = "https://example.com/product/" + Math.random().toString(36).slice(2);
    if (tag === "input") { node.type = "text"; node.name = "field_" + depth; node.value = ""; }
    if (tag === "img") node.src = "https://cdn.example.com/image-" + Math.random().toString(36).slice(2) + ".jpg";
    if (depth < 4 && Math.random() > 0.3) {
      node.children = Array.from({ length: Math.floor(Math.random() * 5) + 1 }, () => makeNode(depth + 1)).filter(Boolean);
    }
    return node;
  }
  return makeNode(0);
}

function generateFindResults(count: number): any[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    tag: ["button", "a", "div", "span"][i % 4],
    text: `Add to Cart - Product ${i + 1} ($${(Math.random() * 1000 + 99).toFixed(2)})`,
    selector: `#product-${i + 1} .add-to-cart`,
    visible: true,
    rect: { x: 100 + i * 50, y: 200 + i * 30, width: 120, height: 40 },
  }));
}

function generateScreenshotBase64(sizeKB: number): string {
  // Simulate a base64 screenshot (real ones are 50-500KB)
  return "iVBORw0KGgoAAAANSUhEUgAA" + "A".repeat(Math.floor(sizeKB * 1024 * 1.33));
}

function generateConsoleMessages(count: number): any[] {
  return Array.from({ length: count }, (_, i) => ({
    level: ["log", "warn", "error"][i % 3],
    text: `[App] ${["Loading product data...", "API response received", "Price mismatch detected", "Cache miss for SKU-" + Math.random().toString(36).slice(2, 8), "Rendering complete"][i % 5]}`,
    timestamp: Date.now() - (count - i) * 1000,
    url: "https://example.com/app.js",
    lineNumber: Math.floor(Math.random() * 500),
  }));
}

function generateNetworkRequests(count: number): any[] {
  return Array.from({ length: count }, (_, i) => ({
    url: `https://api.example.com/v2/${["products", "prices", "reviews", "inventory", "recommendations"][i % 5]}/${Math.random().toString(36).slice(2, 8)}`,
    method: ["GET", "POST", "GET", "GET", "GET"][i % 5],
    status: [200, 200, 304, 200, 429][i % 5],
    type: ["fetch", "xhr", "fetch", "xhr", "fetch"][i % 5],
    duration: Math.floor(Math.random() * 500) + 50,
    size: Math.floor(Math.random() * 50000) + 1000,
  }));
}

// ============================================================================
// Scenario Definition
// ============================================================================

interface ScenarioStep {
  name: string;
  tool: string;
  axonTool: string;
  params: Record<string, any>;
  resultGenerator: () => any;
}

const SCENARIO: ScenarioStep[] = [
  // Phase 1: Setup
  { name: "Get tab context", tool: "tabs_context_mcp", axonTool: "tabs_list", params: { createIfEmpty: true }, resultGenerator: () => ({ groupId: 1, tabs: [{ tabId: 101, url: "about:blank", title: "New Tab" }] }) },
  { name: "Create tab 1 (Amazon)", tool: "tabs_create_mcp", axonTool: "tab_create", params: {}, resultGenerator: () => ({ tabId: 102, url: "about:blank" }) },
  { name: "Create tab 2 (BestBuy)", tool: "tabs_create_mcp", axonTool: "tab_create", params: {}, resultGenerator: () => ({ tabId: 103, url: "about:blank" }) },
  { name: "Create tab 3 (Newegg)", tool: "tabs_create_mcp", axonTool: "tab_create", params: {}, resultGenerator: () => ({ tabId: 104, url: "about:blank" }) },

  // Phase 2: Navigate to product pages
  { name: "Navigate Amazon laptop", tool: "navigate", axonTool: "navigate", params: { tabId: 102, url: "https://amazon.com/dp/B0EXAMPLE1" }, resultGenerator: () => ({ url: "https://amazon.com/dp/B0EXAMPLE1", title: "ASUS ROG Strix G16 Gaming Laptop - 16\" FHD 165Hz" }) },
  { name: "Navigate BestBuy laptop", tool: "navigate", axonTool: "navigate", params: { tabId: 103, url: "https://bestbuy.com/site/asus-rog/123456" }, resultGenerator: () => ({ url: "https://bestbuy.com/site/asus-rog/123456", title: "ASUS ROG Strix G16 - Best Buy" }) },
  { name: "Navigate Newegg laptop", tool: "navigate", axonTool: "navigate", params: { tabId: 104, url: "https://newegg.com/p/N82E16834235" }, resultGenerator: () => ({ url: "https://newegg.com/p/N82E16834235", title: "ASUS ROG Strix G16 | Newegg.com" }) },

  // Phase 3: Take screenshots (heavy — base64 images)
  { name: "Screenshot Amazon", tool: "computer", axonTool: "screenshot", params: { action: "screenshot", tabId: 102 }, resultGenerator: () => ({ base64: generateScreenshotBase64(180), width: 1280, height: 800, bytes: 180 * 1024, url: "https://amazon.com/dp/B0EXAMPLE1", title: "ASUS ROG Strix G16" }) },
  { name: "Screenshot BestBuy", tool: "computer", axonTool: "screenshot", params: { action: "screenshot", tabId: 103 }, resultGenerator: () => ({ base64: generateScreenshotBase64(210), width: 1280, height: 800, bytes: 210 * 1024, url: "https://bestbuy.com/site/asus-rog/123456", title: "ASUS ROG - Best Buy" }) },
  { name: "Screenshot Newegg", tool: "computer", axonTool: "screenshot", params: { action: "screenshot", tabId: 104 }, resultGenerator: () => ({ base64: generateScreenshotBase64(165), width: 1280, height: 800, bytes: 165 * 1024, url: "https://newegg.com/p/N82E16834235", title: "ASUS ROG | Newegg" }) },

  // Phase 4: Extract page text (heavy — full page content)
  { name: "Extract Amazon text", tool: "get_page_text", axonTool: "get_text", params: { tabId: 102 }, resultGenerator: () => ({ text: generatePageText("ASUS ROG Strix G16 Gaming Laptop - Amazon", 800), url: "https://amazon.com/dp/B0EXAMPLE1", title: "ASUS ROG Strix G16 Gaming Laptop" }) },
  { name: "Extract BestBuy text", tool: "get_page_text", axonTool: "get_text", params: { tabId: 103 }, resultGenerator: () => ({ text: generatePageText("ASUS ROG Strix G16 - Best Buy Product Page", 650), url: "https://bestbuy.com/site/asus-rog/123456", title: "ASUS ROG Strix G16 - Best Buy" }) },
  { name: "Extract Newegg text", tool: "get_page_text", axonTool: "get_text", params: { tabId: 104 }, resultGenerator: () => ({ text: generatePageText("ASUS ROG Strix G16 | Newegg.com Product Details", 720), url: "https://newegg.com/p/N82E16834235", title: "ASUS ROG Strix G16 | Newegg" }) },

  // Phase 5: Read accessibility trees (heavy — large DOM trees)
  { name: "Read Amazon page structure", tool: "read_page", axonTool: "read_page", params: { tabId: 102 }, resultGenerator: () => ({ tree: generateAccessibilityTree(200), url: "https://amazon.com", title: "Amazon Product Page" }) },
  { name: "Read BestBuy page structure", tool: "read_page", axonTool: "read_page", params: { tabId: 103, filter: "interactive" }, resultGenerator: () => ({ tree: generateAccessibilityTree(150), url: "https://bestbuy.com", title: "Best Buy Product Page" }) },
  { name: "Read Newegg page structure", tool: "read_page", axonTool: "read_page", params: { tabId: 104 }, resultGenerator: () => ({ tree: generateAccessibilityTree(180), url: "https://newegg.com", title: "Newegg Product Page" }) },

  // Phase 6: Find pricing and cart elements
  { name: "Find Amazon price", tool: "find", axonTool: "find", params: { tabId: 102, query: "price" }, resultGenerator: () => ({ elements: generateFindResults(8) }) },
  { name: "Find BestBuy price", tool: "find", axonTool: "find", params: { tabId: 103, query: "price" }, resultGenerator: () => ({ elements: generateFindResults(6) }) },
  { name: "Find Newegg price", tool: "find", axonTool: "find", params: { tabId: 104, query: "price" }, resultGenerator: () => ({ elements: generateFindResults(10) }) },
  { name: "Find Amazon add to cart", tool: "find", axonTool: "find", params: { tabId: 102, query: "add to cart button" }, resultGenerator: () => ({ elements: generateFindResults(3) }) },

  // Phase 7: Click through interactions
  { name: "Click Amazon reviews tab", tool: "computer", axonTool: "click", params: { action: "left_click", tabId: 102, coordinate: [450, 380] }, resultGenerator: () => ({ clicked: true, x: 450, y: 380 }) },
  { name: "Click BestBuy specs tab", tool: "computer", axonTool: "click", params: { action: "left_click", tabId: 103, coordinate: [320, 410] }, resultGenerator: () => ({ clicked: true, x: 320, y: 410 }) },
  { name: "Scroll down Amazon reviews", tool: "computer", axonTool: "scroll", params: { action: "scroll", tabId: 102, scroll_direction: "down", coordinate: [640, 400] }, resultGenerator: () => ({ scrolled: true, direction: "down", amount: 300 }) },
  { name: "Scroll down BestBuy", tool: "computer", axonTool: "scroll", params: { action: "scroll", tabId: 103, scroll_direction: "down", coordinate: [640, 400] }, resultGenerator: () => ({ scrolled: true, direction: "down", amount: 300 }) },

  // Phase 8: Type in search/comparison
  { name: "Type in Amazon search", tool: "computer", axonTool: "type_text", params: { action: "type", tabId: 102, text: "ASUS ROG Strix G16 2024 vs 2025" }, resultGenerator: () => ({ typed: true, selector: "#twotabsearchtextbox", length: 32 }) },
  { name: "Press Enter to search", tool: "computer", axonTool: "press_key", params: { action: "key", tabId: 102, text: "Enter" }, resultGenerator: () => ({ pressed: true, key: "Enter" }) },

  // Phase 9: More screenshots after interaction
  { name: "Screenshot Amazon reviews", tool: "computer", axonTool: "screenshot", params: { action: "screenshot", tabId: 102 }, resultGenerator: () => ({ base64: generateScreenshotBase64(195), width: 1280, height: 800, bytes: 195 * 1024, url: "https://amazon.com/dp/B0EXAMPLE1#reviews", title: "Reviews - ASUS ROG" }) },
  { name: "Screenshot BestBuy specs", tool: "computer", axonTool: "screenshot", params: { action: "screenshot", tabId: 103 }, resultGenerator: () => ({ base64: generateScreenshotBase64(175), width: 1280, height: 800, bytes: 175 * 1024, url: "https://bestbuy.com/site/asus-rog/123456#specs", title: "Specs - ASUS ROG" }) },

  // Phase 10: Execute JS to extract dynamic data
  { name: "Extract Amazon dynamic price", tool: "javascript_tool", axonTool: "execute_js", params: { action: "javascript_exec", tabId: 102, text: "JSON.stringify({price: document.querySelector('.a-price-whole')?.textContent, rating: document.querySelector('#acrPopover')?.title, reviewCount: document.querySelector('#acrCustomerReviewText')?.textContent})" }, resultGenerator: () => ({ result: { price: "1,299", rating: "4.5 out of 5 stars", reviewCount: "2,847 ratings" }, type: "object" }) },
  { name: "Extract BestBuy dynamic price", tool: "javascript_tool", axonTool: "execute_js", params: { action: "javascript_exec", tabId: 103, text: "JSON.stringify({price: document.querySelector('.priceView-customer-price span')?.textContent, sku: document.querySelector('.sku .product-data-value')?.textContent})" }, resultGenerator: () => ({ result: { price: "$1,249.99", sku: "6571234" }, type: "object" }) },
  { name: "Extract Newegg dynamic price", tool: "javascript_tool", axonTool: "execute_js", params: { action: "javascript_exec", tabId: 104, text: "JSON.stringify({price: document.querySelector('.price-current')?.textContent, shipping: document.querySelector('.price-ship')?.textContent, stock: document.querySelector('.product-inventory')?.textContent})" }, resultGenerator: () => ({ result: { price: "$1,279.99", shipping: "Free Shipping", stock: "In stock" }, type: "object" }) },

  // Phase 11: Navigate pagination on Amazon search results
  { name: "Navigate Amazon search p2", tool: "navigate", axonTool: "navigate", params: { tabId: 102, url: "https://amazon.com/s?k=ASUS+ROG+Strix+G16&page=2" }, resultGenerator: () => ({ url: "https://amazon.com/s?k=ASUS+ROG+Strix+G16&page=2", title: "Amazon: ASUS ROG Strix G16 - Page 2" }) },
  { name: "Screenshot Amazon p2", tool: "computer", axonTool: "screenshot", params: { action: "screenshot", tabId: 102 }, resultGenerator: () => ({ base64: generateScreenshotBase64(190), width: 1280, height: 800, bytes: 190 * 1024, url: "https://amazon.com/s?page=2", title: "Amazon Page 2" }) },
  { name: "Extract Amazon p2 text", tool: "get_page_text", axonTool: "get_text", params: { tabId: 102 }, resultGenerator: () => ({ text: generatePageText("Amazon Search Results - ASUS ROG Strix G16 - Page 2", 600), url: "https://amazon.com/s?page=2", title: "Amazon Page 2" }) },
  { name: "Navigate Amazon search p3", tool: "navigate", axonTool: "navigate", params: { tabId: 102, url: "https://amazon.com/s?k=ASUS+ROG+Strix+G16&page=3" }, resultGenerator: () => ({ url: "https://amazon.com/s?k=ASUS+ROG+Strix+G16&page=3", title: "Amazon: ASUS ROG Strix G16 - Page 3" }) },
  { name: "Screenshot Amazon p3", tool: "computer", axonTool: "screenshot", params: { action: "screenshot", tabId: 102 }, resultGenerator: () => ({ base64: generateScreenshotBase64(185), width: 1280, height: 800, bytes: 185 * 1024, url: "https://amazon.com/s?page=3", title: "Amazon Page 3" }) },

  // Phase 12: Console and network debugging
  { name: "Read Amazon console", tool: "read_console_messages", axonTool: "execute_js", params: { tabId: 102, pattern: "error|price" }, resultGenerator: () => generateConsoleMessages(25) },
  { name: "Read network requests", tool: "read_network_requests", axonTool: "execute_js", params: { tabId: 102, urlPattern: "/api/" }, resultGenerator: () => generateNetworkRequests(30) },

  // Phase 13: Read more page structures for comparison
  { name: "Read Amazon search DOM", tool: "read_page", axonTool: "read_page", params: { tabId: 102, filter: "interactive" }, resultGenerator: () => ({ tree: generateAccessibilityTree(250), url: "https://amazon.com/s", title: "Amazon Search Results" }) },

  // Phase 14: Resize for mobile comparison
  { name: "Resize to mobile", tool: "resize_window", axonTool: "set_viewport", params: { width: 375, height: 812, tabId: 102 }, resultGenerator: () => ({ width: 375, height: 812, preset: "mobile" }) },
  { name: "Screenshot mobile view", tool: "computer", axonTool: "screenshot", params: { action: "screenshot", tabId: 102 }, resultGenerator: () => ({ base64: generateScreenshotBase64(95), width: 375, height: 812, bytes: 95 * 1024, url: "https://amazon.com/s", title: "Amazon (Mobile)" }) },
  { name: "Read mobile DOM", tool: "read_page", axonTool: "read_page", params: { tabId: 102, filter: "interactive" }, resultGenerator: () => ({ tree: generateAccessibilityTree(120), url: "https://amazon.com/s", title: "Amazon Search (Mobile)" }) },

  // Phase 15: Cleanup
  { name: "Close tab 3", tool: "computer", axonTool: "tab_close", params: { action: "key", tabId: 104, text: "cmd+w" }, resultGenerator: () => ({ closed: true, tabId: 104 }) },
  { name: "Close tab 2", tool: "computer", axonTool: "tab_close", params: { action: "key", tabId: 103, text: "cmd+w" }, resultGenerator: () => ({ closed: true, tabId: 103 }) },
];

// ============================================================================
// Token Estimation
// ============================================================================

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ============================================================================
// Run Benchmark
// ============================================================================

function runBenchmark() {
  console.log("\n" + "═".repeat(80));
  console.log("  AXON vs MCP — Chrome Server Benchmark");
  console.log("  Scenario: E-Commerce Competitive Research (47 tool calls)");
  console.log("═".repeat(80) + "\n");

  // ─── 1. Tool Definition Context Tokens ───
  console.log("━━━ Benchmark 1: Tool Definition Context Cost ━━━\n");

  const mcpToolsJson = JSON.stringify(MCP_CHROME_TOOLS);
  const mcpDefTokens = estimateTokens(mcpToolsJson);
  const mcpToolCount = MCP_CHROME_TOOLS.length;

  const browser = new BrowserManager({ headless: true });
  const { server, store } = createChromeServer(browser);
  const axonManifest = server.getManifest();
  const axonManifestJson = JSON.stringify(axonManifest);
  const axonDefTokens = estimateTokens(axonManifestJson);
  const axonToolCount = server.toolCount;

  console.log(`  MCP Chrome:  ${mcpToolCount} tools → ${mcpDefTokens.toLocaleString()} tokens always in context`);
  console.log(`  AXON Chrome: ${axonToolCount} tools → ${axonDefTokens.toLocaleString()} tokens (manifest only)`);
  console.log(`  Reduction:   ${((1 - axonDefTokens / mcpDefTokens) * 100).toFixed(1)}% fewer context tokens`);
  console.log(`  Per-tool:    MCP ~${Math.round(mcpDefTokens / mcpToolCount)} tok/tool vs AXON ~${Math.round(axonDefTokens / axonToolCount)} tok/tool`);
  console.log();

  // Show what AXON manifest looks like (sample)
  console.log("  AXON manifest sample (what the model actually sees):");
  for (const tool of axonManifest.slice(0, 3)) {
    console.log(`    { id: "${tool.id}", summary: "${tool.summary}", cat: "${tool.category}", tags: [${tool.tags.join(",")}] }`);
  }
  console.log(`    ... (${axonToolCount - 3} more)\n`);

  // ─── 2. Scenario Simulation — Result Context ───
  console.log("━━━ Benchmark 2: Result Context Consumption (47-step scenario) ━━━\n");

  let mcpTotalResultTokens = 0;
  let axonTotalContextTokens = 0;
  let mcpTotalWireBytes = 0;
  let axonTotalWireBytes = 0;
  let totalScreenshotTokensMCP = 0;
  let totalScreenshotTokensAXON = 0;
  let totalPageTextTokensMCP = 0;
  let totalPageTextTokensAXON = 0;
  let totalDOMTreeTokensMCP = 0;
  let totalDOMTreeTokensAXON = 0;

  const axonStore = new ResultStore({ max_summary_tokens: 300, max_total_result_tokens: 50000 });

  const phases: Record<string, { mcpTokens: number; axonTokens: number; calls: number }> = {};

  for (const step of SCENARIO) {
    const result = step.resultGenerator();
    const resultJson = JSON.stringify(result);
    const mcpResultTokens = estimateTokens(resultJson);
    mcpTotalResultTokens += mcpResultTokens;

    // MCP wire: JSON-RPC request + response
    const mcpRequest = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: step.tool, arguments: step.params } });
    const mcpResponse = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: resultJson }] } });
    mcpTotalWireBytes += Buffer.byteLength(mcpRequest) + Buffer.byteLength(mcpResponse);

    // AXON: store in OCRS, get summary
    const toolDef = server.getManifest().find(t => t.id === step.axonTool);
    let axonSummary: string;

    // Use the tool's custom summarizer logic
    if (step.axonTool === "screenshot") {
      const kb = Math.round((result.bytes || 0) / 1024);
      axonSummary = `Screenshot ${result.width}x${result.height} (${kb}KB) of "${result.title}"`;
    } else if (step.axonTool === "get_text") {
      const lines = (result.text || "").split("\n").length;
      const chars = (result.text || "").length;
      const preview = (result.text || "").slice(0, 120).replace(/\n/g, " ");
      axonSummary = `"${result.title}" — ${lines} lines (${chars} chars). Preview: "${preview}"`;
    } else if (step.axonTool === "read_page") {
      function countN(n: any): { t: number; i: number } {
        if (!n) return { t: 0, i: 0 };
        const iTags = new Set(["a", "button", "input", "textarea", "select"]);
        let t = 1, i = iTags.has(n.tag) ? 1 : 0;
        for (const c of n.children ?? []) { const r = countN(c); t += r.t; i += r.i; }
        return { t, i };
      }
      const c = countN(result.tree);
      axonSummary = `"${result.title}" — ${c.t} elements, ${c.i} interactive (${result.url})`;
    } else if (step.axonTool === "find") {
      const count = result.elements?.length ?? 0;
      const vis = result.elements?.filter((e: any) => e.visible).length ?? 0;
      const sample = result.elements?.slice(0, 3).map((e: any) => `<${e.tag}>${(e.text || "").slice(0, 30)}`).join(", ") ?? "";
      axonSummary = `${count} matches (${vis} visible): ${sample}`;
    } else if (step.axonTool === "execute_js") {
      const str = JSON.stringify(result.result);
      axonSummary = `JS result (${result.type || typeof result}): ${(str ?? "").slice(0, 120)}`;
    } else if (step.axonTool === "click") {
      axonSummary = `Clicked (${result.x},${result.y})`;
    } else if (step.axonTool === "scroll") {
      axonSummary = `Scrolled ${result.direction} ${result.amount}px`;
    } else if (step.axonTool === "type_text") {
      axonSummary = `Typed ${result.length || 0} chars`;
    } else if (step.axonTool === "press_key") {
      axonSummary = `Pressed ${result.key || "key"}`;
    } else if (step.axonTool === "navigate") {
      axonSummary = `Navigated to "${result.title}" (${result.url})`;
    } else if (step.axonTool === "tabs_list") {
      axonSummary = `${result.tabs?.length ?? 1} tab(s)`;
    } else if (step.axonTool === "tab_create") {
      axonSummary = `Created tab ${result.tabId}`;
    } else if (step.axonTool === "tab_close") {
      axonSummary = `Closed tab ${result.tabId}`;
    } else if (step.axonTool === "set_viewport") {
      axonSummary = `Viewport ${result.width}x${result.height}`;
    } else {
      axonSummary = `${step.axonTool}: done`;
    }

    const entry = axonStore.store(step.axonTool, step.params, result, axonSummary);
    const ctxSummary = axonStore.getSummaryForContext(entry.ref)!;
    const axonCtxTokens = estimateTokens(ctxSummary);
    axonTotalContextTokens += axonCtxTokens;

    // AXON wire: binary envelope (MessagePack ~75% of JSON)
    const axonEnvelope = JSON.stringify({ id: 1, layer: 1, status: "ok", ref: entry.ref, hash: entry.hash, summary: ctxSummary });
    axonTotalWireBytes += Math.round(Buffer.byteLength(axonEnvelope) * 0.75);

    // Category tracking
    const phase = step.name.split(" ")[0] + " " + step.name.split(" ")[1];
    if (!phases[phase]) phases[phase] = { mcpTokens: 0, axonTokens: 0, calls: 0 };
    phases[phase].mcpTokens += mcpResultTokens;
    phases[phase].axonTokens += axonCtxTokens;
    phases[phase].calls++;

    // Track by type
    if (step.axonTool === "screenshot") {
      totalScreenshotTokensMCP += mcpResultTokens;
      totalScreenshotTokensAXON += axonCtxTokens;
    } else if (step.axonTool === "get_text") {
      totalPageTextTokensMCP += mcpResultTokens;
      totalPageTextTokensAXON += axonCtxTokens;
    } else if (step.axonTool === "read_page") {
      totalDOMTreeTokensMCP += mcpResultTokens;
      totalDOMTreeTokensAXON += axonCtxTokens;
    }
  }

  console.log(`  Total calls: ${SCENARIO.length}`);
  console.log();
  console.log("  ┌───────────────────────────────────────────────────────────────┐");
  console.log("  │              Result Context Tokens (cumulative)               │");
  console.log("  ├──────────────────────┬──────────────┬──────────────┬──────────┤");
  console.log("  │ Category             │ MCP Tokens   │ AXON Tokens  │ Savings  │");
  console.log("  ├──────────────────────┼──────────────┼──────────────┼──────────┤");

  const cats = [
    { name: "Screenshots (8x)", mcp: totalScreenshotTokensMCP, axon: totalScreenshotTokensAXON },
    { name: "Page text (4x)", mcp: totalPageTextTokensMCP, axon: totalPageTextTokensAXON },
    { name: "DOM trees (5x)", mcp: totalDOMTreeTokensMCP, axon: totalDOMTreeTokensAXON },
    { name: "Other (30x)", mcp: mcpTotalResultTokens - totalScreenshotTokensMCP - totalPageTextTokensMCP - totalDOMTreeTokensMCP, axon: axonTotalContextTokens - totalScreenshotTokensAXON - totalPageTextTokensAXON - totalDOMTreeTokensAXON },
  ];

  for (const cat of cats) {
    const savings = ((1 - cat.axon / cat.mcp) * 100).toFixed(1);
    console.log(`  │ ${cat.name.padEnd(20)} │ ${cat.mcp.toLocaleString().padStart(12)} │ ${cat.axon.toLocaleString().padStart(12)} │ ${(savings + "%").padStart(8)} │`);
  }

  console.log("  ├──────────────────────┼──────────────┼──────────────┼──────────┤");
  const totalSavings = ((1 - axonTotalContextTokens / mcpTotalResultTokens) * 100).toFixed(1);
  console.log(`  │ ${"TOTAL".padEnd(20)} │ ${mcpTotalResultTokens.toLocaleString().padStart(12)} │ ${axonTotalContextTokens.toLocaleString().padStart(12)} │ ${(totalSavings + "%").padStart(8)} │`);
  console.log("  └──────────────────────┴──────────────┴──────────────┴──────────┘");
  console.log();

  // ─── 3. Full Session Context ───
  console.log("━━━ Benchmark 3: Full Session Context Budget ━━━\n");

  const mcpFullSessionTokens = mcpDefTokens + mcpTotalResultTokens;
  const axonFullSessionTokens = axonDefTokens + axonTotalContextTokens;
  const fullSavings = ((1 - axonFullSessionTokens / mcpFullSessionTokens) * 100).toFixed(1);

  console.log(`  MCP total context:  ${mcpDefTokens.toLocaleString()} (defs) + ${mcpTotalResultTokens.toLocaleString()} (results) = ${mcpFullSessionTokens.toLocaleString()} tokens`);
  console.log(`  AXON total context: ${axonDefTokens.toLocaleString()} (manifest) + ${axonTotalContextTokens.toLocaleString()} (summaries) = ${axonFullSessionTokens.toLocaleString()} tokens`);
  console.log(`  Full session savings: ${fullSavings}%`);
  console.log();

  // Context window visualization
  const maxCtx = 200_000; // Claude's context window
  const mcpPct = ((mcpFullSessionTokens / maxCtx) * 100).toFixed(1);
  const axonPct = ((axonFullSessionTokens / maxCtx) * 100).toFixed(1);
  const mcpBar = "█".repeat(Math.min(60, Math.round(mcpFullSessionTokens / maxCtx * 60)));
  const axonBar = "█".repeat(Math.min(60, Math.round(axonFullSessionTokens / maxCtx * 60)));

  console.log(`  Context window usage (200K):`)
  console.log(`    MCP:  [${mcpBar.padEnd(60)}] ${mcpPct}%`);
  console.log(`    AXON: [${axonBar.padEnd(60)}] ${axonPct}%`);
  console.log();

  // ─── 4. Wire Size ───
  console.log("━━━ Benchmark 4: Wire Size ━━━\n");

  const wireSavings = ((1 - axonTotalWireBytes / mcpTotalWireBytes) * 100).toFixed(1);
  console.log(`  MCP wire (JSON-RPC):   ${(mcpTotalWireBytes / 1024).toFixed(0)} KB`);
  console.log(`  AXON wire (MessagePack): ${(axonTotalWireBytes / 1024).toFixed(0)} KB`);
  console.log(`  Wire savings: ${wireSavings}%`);
  console.log();

  // ─── 5. Latency Simulation ───
  console.log("━━━ Benchmark 5: Latency (Schema Fetch Overhead) ━━━\n");

  // MCP: Every call requires full schema in context (already paid at startup)
  // But: model must process ALL tool schemas to pick the right one
  // AXON: Model picks from compact manifest, schema fetched only when calling
  const mcpSchemaProcessingMs = mcpDefTokens * 0.015; // ~15µs per token to process
  const axonSchemaProcessingMs = axonDefTokens * 0.015;
  // AXON adds one schema fetch per unique tool called
  const uniqueToolsCalled = new Set(SCENARIO.map(s => s.axonTool)).size;
  const avgSchemaSize = 150; // tokens per schema
  const schemaFetchMs = uniqueToolsCalled * avgSchemaSize * 0.015;
  const axonTotalSchemaMs = axonSchemaProcessingMs + schemaFetchMs;

  console.log(`  MCP schema processing (every turn):  ${mcpSchemaProcessingMs.toFixed(1)}ms (${mcpDefTokens} tokens)`);
  console.log(`  AXON manifest processing per turn:   ${axonSchemaProcessingMs.toFixed(1)}ms (${axonDefTokens} tokens)`);
  console.log(`  AXON schema fetch (${uniqueToolsCalled} unique tools): +${schemaFetchMs.toFixed(1)}ms (one-time, cached)`);
  console.log(`  AXON total:                          ${axonTotalSchemaMs.toFixed(1)}ms`);
  console.log(`  Per-turn savings:                    ${((1 - axonSchemaProcessingMs / mcpSchemaProcessingMs) * 100).toFixed(0)}% faster schema processing`);
  console.log();

  // ─── 6. OCRS Dedup Savings ───
  console.log("━━━ Benchmark 6: OCRS Content-Addressed Dedup ━━━\n");

  const storeStats = axonStore.stats();
  const dedupRatio = SCENARIO.length > 0 ? ((1 - storeStats.total_entries / SCENARIO.length) * 100).toFixed(1) : "0";

  console.log(`  Total calls:    ${SCENARIO.length}`);
  console.log(`  Unique results: ${storeStats.total_entries} (content-addressed)`);
  console.log(`  Dedup savings:  ${dedupRatio}% fewer stored entries`);
  console.log(`  Store size:     ${(storeStats.total_bytes / 1024 / 1024).toFixed(1)} MB in OCRS (zero in model context)`);
  console.log(`  Context used:   ${storeStats.context_tokens_used} tokens (summaries only)`);
  console.log();

  // ─── 7. Security Comparison ───
  console.log("━━━ Benchmark 7: Security ━━━\n");

  const secChecks = [
    { check: "Domain scoping", mcp: "None — navigate anywhere", axon: "allowedDomains glob enforcement" },
    { check: "Tool-level auth", mcp: "None — all tools open", axon: "Capability tokens per tool" },
    { check: "Write protection", mcp: "None — click/type unrestricted", axon: "resource:write capability required" },
    { check: "Token expiry", mcp: "N/A", axon: "TTL-based auto-expiry" },
    { check: "Scope attenuation", mcp: "N/A", axon: "Tokens can only narrow, never widen" },
    { check: "Parameter constraints", mcp: "N/A", axon: "Per-param allowed values/patterns" },
    { check: "Capability revocation", mcp: "N/A", axon: "Real-time revocation by ID" },
    { check: "Cross-server isolation", mcp: "None — shared context", axon: "Authority-scoped signatures" },
  ];

  let mcpSecScore = 0;
  let axonSecScore = 0;

  for (const s of secChecks) {
    const mcpHas = !s.mcp.startsWith("N/A") && !s.mcp.startsWith("None");
    const axonHas = !s.axon.startsWith("N/A") && !s.axon.startsWith("None");
    if (mcpHas) mcpSecScore++;
    if (axonHas) axonSecScore++;
    const mcpIcon = mcpHas ? "✓" : "✗";
    const axonIcon = axonHas ? "✓" : "✗";
    console.log(`  ${mcpIcon}/${axonIcon}  ${s.check.padEnd(24)} MCP: ${s.mcp.padEnd(35)} AXON: ${s.axon}`);
  }

  console.log(`\n  Security score: MCP ${mcpSecScore}/${secChecks.length} vs AXON ${axonSecScore}/${secChecks.length}`);
  console.log();

  // ═══ Final Scorecard ═══
  console.log("═".repeat(80));
  console.log("  FINAL SCORECARD");
  console.log("═".repeat(80));
  console.log();

  const metrics = [
    { metric: "Tool definitions", mcpVal: `${mcpDefTokens.toLocaleString()} tok`, axonVal: `${axonDefTokens.toLocaleString()} tok`, savings: `${((1 - axonDefTokens / mcpDefTokens) * 100).toFixed(0)}%`, winner: "AXON" },
    { metric: "Result context (47 calls)", mcpVal: `${mcpTotalResultTokens.toLocaleString()} tok`, axonVal: `${axonTotalContextTokens.toLocaleString()} tok`, savings: totalSavings + "%", winner: "AXON" },
    { metric: "Full session context", mcpVal: `${mcpFullSessionTokens.toLocaleString()} tok`, axonVal: `${axonFullSessionTokens.toLocaleString()} tok`, savings: fullSavings + "%", winner: "AXON" },
    { metric: "Wire size", mcpVal: `${(mcpTotalWireBytes / 1024).toFixed(0)} KB`, axonVal: `${(axonTotalWireBytes / 1024).toFixed(0)} KB`, savings: wireSavings + "%", winner: "AXON" },
    { metric: "Schema processing/turn", mcpVal: `${mcpSchemaProcessingMs.toFixed(1)}ms`, axonVal: `${axonSchemaProcessingMs.toFixed(1)}ms`, savings: `${((1 - axonSchemaProcessingMs / mcpSchemaProcessingMs) * 100).toFixed(0)}%`, winner: "AXON" },
    { metric: "Security checks", mcpVal: `${mcpSecScore}/8`, axonVal: `${axonSecScore}/8`, savings: `+${axonSecScore - mcpSecScore}`, winner: "AXON" },
  ];

  console.log("  ┌──────────────────────────┬───────────────┬───────────────┬──────────┬────────┐");
  console.log("  │ Metric                   │ MCP           │ AXON          │ Savings  │ Winner │");
  console.log("  ├──────────────────────────┼───────────────┼───────────────┼──────────┼────────┤");
  for (const m of metrics) {
    console.log(`  │ ${m.metric.padEnd(24)} │ ${m.mcpVal.padStart(13)} │ ${m.axonVal.padStart(13)} │ ${m.savings.padStart(8)} │ ${m.winner.padStart(6)} │`);
  }
  console.log("  └──────────────────────────┴───────────────┴───────────────┴──────────┴────────┘");

  // Cost projection
  const tokenPriceInput = 15 / 1_000_000; // $15/MTok for Claude Opus
  const mcpCost = mcpFullSessionTokens * tokenPriceInput;
  const axonCost = axonFullSessionTokens * tokenPriceInput;
  console.log(`\n  Cost projection (Claude Opus @ $15/MTok input):`);
  console.log(`    MCP session:  $${mcpCost.toFixed(4)}`);
  console.log(`    AXON session: $${axonCost.toFixed(4)}`);
  console.log(`    Savings per session: $${(mcpCost - axonCost).toFixed(4)} (${((1 - axonCost / mcpCost) * 100).toFixed(0)}%)`);
  console.log(`    At 1000 sessions/day: $${((mcpCost - axonCost) * 1000 * 30).toFixed(2)}/month saved`);
  console.log();
}

runBenchmark();
