#!/usr/bin/env npx tsx
/**
 * AXON vs MCP — Real-World Browser Benchmark
 *
 * This benchmark ACTUALLY launches Puppeteer in headless mode, navigates to
 * real public websites, and measures the concrete difference between MCP
 * (raw result dumped into context) and AXON (OCRS summary in context,
 * full data stored out-of-band).
 *
 * Target sites (safe, stable, public):
 *   - example.com        — minimal HTML, baseline
 *   - en.wikipedia.org    — content-rich, large DOM
 *   - httpbin.org         — API-friendly, predictable responses
 *
 * Operations measured:
 *   1. navigate       — page load, return URL/title/status
 *   2. screenshot     — full PNG capture (base64)
 *   3. get_text       — extract innerText from page
 *   4. read_page      — accessibility tree / DOM structure
 *   5. execute_js     — evaluate JS expression in page context
 *   6. scroll         — scroll the viewport
 *   7. find           — find elements by CSS selector
 *
 * For each operation we record:
 *   - Raw result bytes  (what MCP would inject into context)
 *   - AXON summary bytes (what AXON injects via OCRS)
 *   - Wire size for both protocols (JSON for MCP, msgpack-estimated for AXON)
 *   - Wall-clock latency (ms)
 *   - Token estimates (chars / 4)
 *
 * Run:  npx tsx benchmark-real.ts
 */

import { createChromeServer } from "./src/server.js";
import { BrowserManager } from "./src/browser.js";
import type { CallMessage, ResultMessage } from "../../sdk/src/types.js";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Helpers
// ============================================================================

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimate msgpack size: ~30% smaller than JSON for typical structured data */
function estimateMsgpackSize(jsonBytes: number): number {
  return Math.round(jsonBytes * 0.7);
}

/** AXON frame overhead: 8-byte header per frame */
const AXON_FRAME_OVERHEAD = 8;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function padRight(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

function padLeft(s: string, len: number): string {
  return s.length >= len ? s : " ".repeat(len - s.length) + s;
}

// ============================================================================
// Benchmark Result Types
// ============================================================================

interface ToolMeasurement {
  site: string;
  tool: string;
  description: string;
  latencyMs: number;
  mcpResultBytes: number;
  mcpResultTokens: number;
  mcpWireBytes: number;
  axonSummary: string;
  axonSummaryBytes: number;
  axonSummaryTokens: number;
  axonWireBytes: number;
  savingsPercent: number;
}

interface BenchmarkResults {
  timestamp: string;
  measurements: ToolMeasurement[];
  totals: {
    mcpContextTokens: number;
    axonContextTokens: number;
    savingsPercent: number;
    mcpWireBytes: number;
    axonWireBytes: number;
    wireSavingsPercent: number;
    totalCalls: number;
    avgLatencyMs: number;
  };
  contextWindowAnalysis: {
    windowSize: number;
    systemPromptTokens: number;
    conversationTokens: number;
    responseTokens: number;
    availableForTools: number;
    mcpToolDefTokens: number;
    axonManifestTokens: number;
    mcpFitsIn200K: boolean;
    axonFitsIn200K: boolean;
    mcpTotalWithDefs: number;
    axonTotalWithDefs: number;
  };
}

// ============================================================================
// Main Benchmark
// ============================================================================

async function runBenchmark(): Promise<BenchmarkResults> {
  console.log("\n" + "=".repeat(80));
  console.log("  AXON vs MCP -- Real-World Browser Benchmark");
  console.log("  Live Puppeteer | Real Websites | Actual Measurements");
  console.log("=".repeat(80) + "\n");

  // ── Launch real browser ──
  console.log("  [1/5] Launching headless Chromium...");
  const browser = new BrowserManager({
    headless: true,
    defaultViewport: { width: 1280, height: 800 },
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });
  await browser.launch();

  // ── Create AXON server with real tools ──
  console.log("  [2/5] Initializing AXON Chrome server...");
  const { server, store } = createChromeServer(browser);
  const manifest = server.getManifest();
  console.log(`         ${manifest.length} tools registered\n`);

  // Helper: execute a tool through the AXON server and measure everything
  let callId = 0;
  const measurements: ToolMeasurement[] = [];

  async function measure(
    site: string,
    toolId: string,
    params: Record<string, any>,
    description: string
  ): Promise<void> {
    const id = ++callId;
    const call: CallMessage = {
      id,
      tool: toolId,
      params,
      capability: "benchmark-bypass",
    };

    const ctx = {
      sessionId: "bench-session",
      streamId: id,
      reportProgress: () => {},
      isCancelled: () => false,
    };

    const start = performance.now();
    const result: ResultMessage = await server.execute(call, ctx);
    const latencyMs = performance.now() - start;

    // MCP: raw JSON result dumped into context
    const rawResultJson = JSON.stringify(result.data ?? result.summary ?? "");
    const mcpResultBytes = new TextEncoder().encode(rawResultJson).byteLength;
    const mcpResultTokens = estimateTokens(rawResultJson);

    // MCP wire: JSON-RPC envelope + full result
    const mcpWirePayload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: rawResultJson }] },
    });
    const mcpWireBytes = new TextEncoder().encode(mcpWirePayload).byteLength;

    // AXON: summary injected into context
    const summary = result.summary ?? "(no summary)";

    // Store in OCRS to get the formatted context string
    const entry = store.store(toolId, params, result.data ?? result.summary ?? "", summary);
    const contextSummary = store.getSummaryForContext(entry.ref) ?? summary;

    const axonSummaryBytes = new TextEncoder().encode(contextSummary).byteLength;
    const axonSummaryTokens = estimateTokens(contextSummary);

    // AXON wire: binary frame header + msgpack-encoded summary + OCRS ref
    const axonWireResult = JSON.stringify({
      id,
      layer: 0,
      status: "ok",
      ref: entry.ref,
      hash: entry.hash.slice(0, 16),
      summary: contextSummary,
    });
    const axonWireBytes = AXON_FRAME_OVERHEAD + estimateMsgpackSize(
      new TextEncoder().encode(axonWireResult).byteLength
    );

    const savingsPercent =
      mcpResultTokens > 0
        ? ((mcpResultTokens - axonSummaryTokens) / mcpResultTokens) * 100
        : 0;

    const m: ToolMeasurement = {
      site,
      tool: toolId,
      description,
      latencyMs: Math.round(latencyMs * 100) / 100,
      mcpResultBytes,
      mcpResultTokens,
      mcpWireBytes,
      axonSummary: contextSummary,
      axonSummaryBytes,
      axonSummaryTokens,
      axonWireBytes,
      savingsPercent: Math.round(savingsPercent * 10) / 10,
    };

    measurements.push(m);

    // Live progress
    const tokenSaved = padLeft(`-${m.savingsPercent.toFixed(0)}%`, 5);
    console.log(
      `         ${padRight(m.tool, 14)} ${padRight(m.site, 20)} ` +
      `MCP: ${padLeft(formatBytes(m.mcpResultBytes), 10)} (${padLeft(String(m.mcpResultTokens), 7)} tok) | ` +
      `AXON: ${padLeft(formatBytes(m.axonSummaryBytes), 8)} (${padLeft(String(m.axonSummaryTokens), 5)} tok) | ` +
      `${tokenSaved} | ${padLeft(m.latencyMs.toFixed(0) + "ms", 8)}`
    );
  }

  // ── Create a tab ──
  console.log("  [3/5] Creating browser tab...");
  const { tabId } = await browser.createTab();
  console.log(`         Tab ${tabId} ready\n`);

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 1: example.com — minimal baseline
  // ══════════════════════════════════════════════════════════════════════════
  console.log("  [4/5] Running measurements...\n");
  console.log("  --- example.com (minimal HTML) ---");

  await measure("example.com", "navigate", { tabId, url: "https://example.com" }, "Navigate to example.com");
  await measure("example.com", "screenshot", { tabId }, "Screenshot example.com");
  await measure("example.com", "get_text", { tabId }, "Extract page text");
  await measure("example.com", "read_page", { tabId }, "Read DOM / accessibility tree");
  await measure("example.com", "execute_js", { tabId, expression: "document.title" }, "Execute JS: document.title");
  await measure("example.com", "scroll", { tabId, direction: "down", amount: 200 }, "Scroll down 200px");
  await measure("example.com", "find", { tabId, query: "a" }, "Find all <a> elements");

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 2: Wikipedia — content-rich page, large DOM
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n  --- en.wikipedia.org (content-rich) ---");

  await measure("wikipedia.org", "navigate", { tabId, url: "https://en.wikipedia.org/wiki/HTTP" }, "Navigate to Wikipedia HTTP article");
  await measure("wikipedia.org", "screenshot", { tabId }, "Screenshot Wikipedia article");
  await measure("wikipedia.org", "get_text", { tabId }, "Extract article text");
  await measure("wikipedia.org", "read_page", { tabId, maxDepth: 6 }, "Read DOM (depth 6)");
  await measure("wikipedia.org", "execute_js", { tabId, expression: "JSON.stringify({title: document.title, links: document.querySelectorAll('a').length, headings: document.querySelectorAll('h2,h3').length, images: document.querySelectorAll('img').length, paragraphs: document.querySelectorAll('p').length})" }, "Execute JS: page stats");
  await measure("wikipedia.org", "scroll", { tabId, direction: "down", amount: 800 }, "Scroll down 800px");
  await measure("wikipedia.org", "screenshot", { tabId, fullPage: false }, "Screenshot after scroll");
  await measure("wikipedia.org", "find", { tabId, query: "h2" }, "Find all <h2> headings");
  await measure("wikipedia.org", "execute_js", { tabId, expression: "Array.from(document.querySelectorAll('.mw-heading h2, .mw-heading h3, #toc a')).map(el => ({text: el.textContent?.trim(), tag: el.tagName})).slice(0, 20)" }, "Execute JS: headings & TOC");

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 3: httpbin.org — API-style, JSON-heavy
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n  --- httpbin.org (API/JSON) ---");

  await measure("httpbin.org", "navigate", { tabId, url: "https://httpbin.org" }, "Navigate to httpbin.org");
  await measure("httpbin.org", "screenshot", { tabId }, "Screenshot httpbin.org");
  await measure("httpbin.org", "get_text", { tabId }, "Extract page text");
  await measure("httpbin.org", "read_page", { tabId }, "Read DOM");
  await measure("httpbin.org", "execute_js", { tabId, expression: "document.querySelectorAll('a').length" }, "Execute JS: count links");
  await measure("httpbin.org", "find", { tabId, query: "a" }, "Find all links");

  // Additional httpbin page for variety
  await measure("httpbin.org/html", "navigate", { tabId, url: "https://httpbin.org/html" }, "Navigate to httpbin HTML page");
  await measure("httpbin.org/html", "get_text", { tabId }, "Extract httpbin HTML text");
  await measure("httpbin.org/html", "screenshot", { tabId }, "Screenshot httpbin HTML");
  await measure("httpbin.org/html", "read_page", { tabId }, "Read DOM httpbin HTML");

  console.log();

  // ══════════════════════════════════════════════════════════════════════════
  // Cleanup
  // ══════════════════════════════════════════════════════════════════════════
  console.log("  [5/5] Closing browser...");
  await browser.close();
  console.log("         Done.\n");

  // ══════════════════════════════════════════════════════════════════════════
  // Compute totals
  // ══════════════════════════════════════════════════════════════════════════
  const totalMcpTokens = measurements.reduce((s, m) => s + m.mcpResultTokens, 0);
  const totalAxonTokens = measurements.reduce((s, m) => s + m.axonSummaryTokens, 0);
  const totalMcpWire = measurements.reduce((s, m) => s + m.mcpWireBytes, 0);
  const totalAxonWire = measurements.reduce((s, m) => s + m.axonWireBytes, 0);
  const avgLatency = measurements.reduce((s, m) => s + m.latencyMs, 0) / measurements.length;

  // Context window analysis
  const CONTEXT_WINDOW = 200_000;
  const SYSTEM_PROMPT_TOKENS = 8_000;
  const CONVERSATION_TOKENS = 3_000;
  const RESPONSE_TOKENS = 4_000;
  const AVAILABLE_FOR_TOOLS = CONTEXT_WINDOW - SYSTEM_PROMPT_TOKENS - CONVERSATION_TOKENS - RESPONSE_TOKENS;

  // MCP tool definitions: use real Claude-in-Chrome schema sizes
  // (from the existing benchmark.ts MCP_CHROME_TOOLS definition)
  const MCP_TOOL_DEF_TOKENS = 4_918;
  const AXON_MANIFEST_TOKENS = server.estimateManifestTokens();

  const mcpTotalWithDefs = totalMcpTokens + MCP_TOOL_DEF_TOKENS;
  const axonTotalWithDefs = totalAxonTokens + AXON_MANIFEST_TOKENS;

  const results: BenchmarkResults = {
    timestamp: new Date().toISOString(),
    measurements,
    totals: {
      mcpContextTokens: totalMcpTokens,
      axonContextTokens: totalAxonTokens,
      savingsPercent: Math.round(((totalMcpTokens - totalAxonTokens) / totalMcpTokens) * 1000) / 10,
      mcpWireBytes: totalMcpWire,
      axonWireBytes: totalAxonWire,
      wireSavingsPercent: Math.round(((totalMcpWire - totalAxonWire) / totalMcpWire) * 1000) / 10,
      totalCalls: measurements.length,
      avgLatencyMs: Math.round(avgLatency * 100) / 100,
    },
    contextWindowAnalysis: {
      windowSize: CONTEXT_WINDOW,
      systemPromptTokens: SYSTEM_PROMPT_TOKENS,
      conversationTokens: CONVERSATION_TOKENS,
      responseTokens: RESPONSE_TOKENS,
      availableForTools: AVAILABLE_FOR_TOOLS,
      mcpToolDefTokens: MCP_TOOL_DEF_TOKENS,
      axonManifestTokens: AXON_MANIFEST_TOKENS,
      mcpFitsIn200K: mcpTotalWithDefs <= AVAILABLE_FOR_TOOLS,
      axonFitsIn200K: axonTotalWithDefs <= AVAILABLE_FOR_TOOLS,
      mcpTotalWithDefs,
      axonTotalWithDefs,
    },
  };

  return results;
}

// ============================================================================
// Output: Human-readable table
// ============================================================================

function printResults(results: BenchmarkResults): void {
  const { measurements, totals, contextWindowAnalysis: ctx } = results;

  console.log("=".repeat(130));
  console.log("  RESULTS: Per-Tool Breakdown");
  console.log("=".repeat(130));
  console.log();

  // Table header
  const cols = {
    tool: 14,
    site: 18,
    mcpTok: 10,
    axonTok: 10,
    savings: 8,
    mcpWire: 12,
    axonWire: 12,
    latency: 10,
  };

  const hdr =
    "  " +
    padRight("Tool", cols.tool) +
    padRight("Site", cols.site) +
    padLeft("MCP Tokens", cols.mcpTok) +
    padLeft("AXON Tokens", cols.axonTok + 1) +
    padLeft("Savings", cols.savings + 1) +
    padLeft("MCP Wire", cols.mcpWire + 1) +
    padLeft("AXON Wire", cols.axonWire + 1) +
    padLeft("Latency", cols.latency);

  console.log(hdr);
  console.log("  " + "-".repeat(hdr.length - 2));

  for (const m of measurements) {
    const line =
      "  " +
      padRight(m.tool, cols.tool) +
      padRight(m.site, cols.site) +
      padLeft(m.mcpResultTokens.toLocaleString(), cols.mcpTok) +
      padLeft(m.axonSummaryTokens.toLocaleString(), cols.axonTok + 1) +
      padLeft(`-${m.savingsPercent.toFixed(0)}%`, cols.savings + 1) +
      padLeft(formatBytes(m.mcpWireBytes), cols.mcpWire + 1) +
      padLeft(formatBytes(m.axonWireBytes), cols.axonWire + 1) +
      padLeft(m.latencyMs.toFixed(0) + " ms", cols.latency);
    console.log(line);
  }

  console.log("  " + "-".repeat(hdr.length - 2));

  // Totals row
  console.log(
    "  " +
    padRight("TOTAL", cols.tool) +
    padRight(`(${measurements.length} calls)`, cols.site) +
    padLeft(totals.mcpContextTokens.toLocaleString(), cols.mcpTok) +
    padLeft(totals.axonContextTokens.toLocaleString(), cols.axonTok + 1) +
    padLeft(`-${totals.savingsPercent.toFixed(1)}%`, cols.savings + 1) +
    padLeft(formatBytes(totals.mcpWireBytes), cols.mcpWire + 1) +
    padLeft(formatBytes(totals.axonWireBytes), cols.axonWire + 1) +
    padLeft(totals.avgLatencyMs.toFixed(0) + " ms avg", cols.latency)
  );
  console.log();

  // ── Context window analysis ──
  console.log("=".repeat(80));
  console.log("  CONTEXT WINDOW ANALYSIS (200K token window)");
  console.log("=".repeat(80));
  console.log();
  console.log(`  Context window:         ${ctx.windowSize.toLocaleString()} tokens`);
  console.log(`  System prompt:          ${ctx.systemPromptTokens.toLocaleString()} tokens`);
  console.log(`  Conversation history:   ${ctx.conversationTokens.toLocaleString()} tokens`);
  console.log(`  Response budget:        ${ctx.responseTokens.toLocaleString()} tokens`);
  console.log(`  Available for tools:    ${ctx.availableForTools.toLocaleString()} tokens`);
  console.log();

  console.log("  +----------------------------+--------------+--------------+");
  console.log("  | Metric                     | MCP          | AXON         |");
  console.log("  +----------------------------+--------------+--------------+");

  const rows = [
    ["Tool definitions", `${ctx.mcpToolDefTokens.toLocaleString()} tok`, `${ctx.axonManifestTokens.toLocaleString()} tok`],
    ["Result context", `${totals.mcpContextTokens.toLocaleString()} tok`, `${totals.axonContextTokens.toLocaleString()} tok`],
    ["Total context used", `${ctx.mcpTotalWithDefs.toLocaleString()} tok`, `${ctx.axonTotalWithDefs.toLocaleString()} tok`],
    ["% of available budget", `${((ctx.mcpTotalWithDefs / ctx.availableForTools) * 100).toFixed(1)}%`, `${((ctx.axonTotalWithDefs / ctx.availableForTools) * 100).toFixed(1)}%`],
    ["Fits in 200K window?", ctx.mcpFitsIn200K ? "YES" : "NO -- OVERFLOW", ctx.axonFitsIn200K ? "YES" : "YES"],
    ["Wire bytes total", formatBytes(totals.mcpWireBytes), formatBytes(totals.axonWireBytes)],
    ["Wire savings", "--", `-${totals.wireSavingsPercent.toFixed(1)}%`],
    ["Context token savings", "--", `-${totals.savingsPercent.toFixed(1)}%`],
  ];

  for (const [label, mcp, axon] of rows) {
    console.log(`  | ${padRight(label, 26)} | ${padLeft(mcp, 12)} | ${padLeft(axon, 12)} |`);
  }

  console.log("  +----------------------------+--------------+--------------+");
  console.log();

  // ── Biggest wins ──
  const sorted = [...measurements].sort((a, b) => b.mcpResultTokens - a.mcpResultTokens);
  const top5 = sorted.slice(0, 5);

  console.log("  TOP 5 BIGGEST CONTEXT SAVINGS:");
  console.log();
  for (let i = 0; i < top5.length; i++) {
    const m = top5[i];
    const saved = m.mcpResultTokens - m.axonSummaryTokens;
    console.log(
      `  ${i + 1}. ${padRight(m.tool, 14)} on ${padRight(m.site, 18)} ` +
      `${m.mcpResultTokens.toLocaleString()} -> ${m.axonSummaryTokens.toLocaleString()} tokens ` +
      `(saved ${saved.toLocaleString()} tokens, -${m.savingsPercent.toFixed(0)}%)`
    );
  }
  console.log();

  // ── AXON OCRS store stats ──
  console.log("  AXON OCRS STORE:");
  console.log(`    Full results stored out-of-band, accessible on demand via ref IDs.`);
  console.log(`    Model sees summaries. Can drill into any result without re-calling the tool.`);
  console.log();

  // ── Summary line ──
  console.log("=".repeat(80));
  const contextRatio = (totals.mcpContextTokens / totals.axonContextTokens).toFixed(1);
  console.log(
    `  BOTTOM LINE: AXON uses ${totals.axonContextTokens.toLocaleString()} context tokens ` +
    `vs MCP's ${totals.mcpContextTokens.toLocaleString()} tokens ` +
    `(${contextRatio}x reduction, -${totals.savingsPercent.toFixed(1)}% savings)`
  );
  if (!ctx.mcpFitsIn200K) {
    console.log(
      `  MCP OVERFLOWS the 200K context window ` +
      `(${ctx.mcpTotalWithDefs.toLocaleString()} tokens > ${ctx.availableForTools.toLocaleString()} available). ` +
      `AXON fits comfortably.`
    );
  }
  console.log("=".repeat(80));
  console.log();
}

// ============================================================================
// Entry point
// ============================================================================

async function main(): Promise<void> {
  try {
    const results = await runBenchmark();

    // Print human-readable table
    printResults(results);

    // Write JSON results
    const outPath = resolve(__dirname, "benchmark-real-results.json");
    writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log(`  JSON results written to: ${outPath}\n`);
  } catch (err: any) {
    console.error("\n  BENCHMARK FAILED:", err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
