#!/usr/bin/env npx tsx
/**
 * AXON Chrome Server — MCP-Compatible Stdio Wrapper
 *
 * Translates MCP JSON-RPC over stdin/stdout into AXON calls.
 * This makes the AXON Chrome server usable with any MCP client:
 *   - Claude Desktop
 *   - Cursor
 *   - Windsurf
 *   - Any MCP-compatible host
 *
 * Protocol: JSON-RPC 2.0 over stdio (one JSON object per line)
 *
 * Supported MCP methods:
 *   - initialize
 *   - notifications/initialized
 *   - tools/list
 *   - tools/call
 *   - ping
 */

import * as readline from "node:readline";
import { randomUUID, createHash } from "node:crypto";
import { BrowserManager } from "./browser.js";
import { createChromeServer } from "./server.js";
import type { AxonServer, ResultStore, CapabilityAuthority, ToolSchema, ToolManifest, CallMessage } from "@axon-protocol/sdk";

// ============================================================================
// MCP JSON-RPC Types
// ============================================================================

interface MCPRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: any;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

interface MCPNotification {
  jsonrpc: "2.0";
  method: string;
  params?: any;
}

// ============================================================================
// State
// ============================================================================

let browser: BrowserManager;
let server: AxonServer;
let store: ResultStore;
let capAuthority: CapabilityAuthority;
let initialized = false;
let callIdCounter = 1;

// ============================================================================
// MCP Protocol Handler
// ============================================================================

async function handleMessage(msg: MCPRequest): Promise<MCPResponse | null> {
  // Notifications (no id) don't get responses
  if (msg.id === undefined) {
    await handleNotification(msg as MCPNotification);
    return null;
  }

  try {
    switch (msg.method) {
      case "initialize":
        return handleInitialize(msg);

      case "tools/list":
        return handleToolsList(msg);

      case "tools/call":
        return await handleToolsCall(msg);

      case "ping":
        return { jsonrpc: "2.0", id: msg.id, result: {} };

      default:
        return {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        };
    }
  } catch (err: any) {
    return {
      jsonrpc: "2.0",
      id: msg.id!,
      error: { code: -32603, message: err.message },
    };
  }
}

async function handleNotification(msg: MCPNotification): Promise<void> {
  if (msg.method === "notifications/initialized") {
    // Client acknowledged initialization — launch browser
    if (!browser?.isLaunched) {
      browser = new BrowserManager({
        headless: process.env.AXON_HEADLESS === "true",
        executablePath: process.env.AXON_CHROME_PATH || undefined,
        defaultViewport: { width: 1280, height: 800 },
        args: ["--no-first-run", "--disable-default-apps", "--disable-popup-blocking"],
      });
      await browser.launch();

      const created = createChromeServer(browser);
      server = created.server;
      store = created.store;
      capAuthority = created.capAuthority;
    }
    initialized = true;
    log("Browser launched, AXON Chrome server ready");
  }

  if (msg.method === "notifications/cancelled") {
    log(`Call ${msg.params?.requestId} cancelled`);
  }
}

// ============================================================================
// MCP Method Handlers
// ============================================================================

function handleInitialize(msg: MCPRequest): MCPResponse {
  return {
    jsonrpc: "2.0",
    id: msg.id!,
    result: {
      protocolVersion: "2025-03-26",
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: {
        name: "axon-chrome",
        version: "0.1.0",
      },
    },
  };
}

function handleToolsList(msg: MCPRequest): MCPResponse {
  const manifest = server.getManifest();

  // Convert AXON manifests + schemas to MCP tool format
  const tools = manifest.map((m: ToolManifest) => {
    const schema = server.getSchema(m.id);
    return {
      name: m.id,
      description: schema?.description ?? m.summary,
      inputSchema: schema?.input ?? { type: "object", properties: {} },
      annotations: schema ? {
        title: m.summary,
        readOnlyHint: schema.annotations.read_only,
        idempotentHint: schema.annotations.idempotent,
      } : undefined,
    };
  });

  return {
    jsonrpc: "2.0",
    id: msg.id!,
    result: { tools },
  };
}

async function handleToolsCall(msg: MCPRequest): Promise<MCPResponse> {
  const { name, arguments: args } = msg.params ?? {};

  if (!name) {
    return {
      jsonrpc: "2.0",
      id: msg.id!,
      error: { code: -32602, message: "Missing tool name" },
    };
  }

  // Build AXON call message
  const call: CallMessage = {
    id: callIdCounter++,
    tool: name,
    params: args ?? {},
    capability: "",
  };

  // Execute via AXON server
  const context = {
    sessionId: "mcp-stdio",
    streamId: call.id,
    reportProgress: () => {},
    isCancelled: () => false,
  };

  const result = await server.execute(call, context);

  if (result.status === "error") {
    return {
      jsonrpc: "2.0",
      id: msg.id!,
      result: {
        content: [{ type: "text", text: result.summary ?? "Unknown error" }],
        isError: true,
      },
    };
  }

  // Store in OCRS and return summary + data
  const data = result.data;

  // For screenshots, return image content
  if (name === "screenshot" && data?.base64) {
    return {
      jsonrpc: "2.0",
      id: msg.id!,
      result: {
        content: [
          {
            type: "image",
            data: data.base64,
            mimeType: "image/png",
          },
          {
            type: "text",
            text: result.summary ?? `Screenshot ${data.width}x${data.height}`,
          },
        ],
      },
    };
  }

  // For text/structured results, return as text
  const textContent = typeof data === "string"
    ? data
    : JSON.stringify(data, null, 2);

  return {
    jsonrpc: "2.0",
    id: msg.id!,
    result: {
      content: [{ type: "text", text: textContent }],
    },
  };
}

// ============================================================================
// Stdio Transport
// ============================================================================

function send(msg: MCPResponse | MCPNotification): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function log(...args: any[]): void {
  process.stderr.write(`[axon-chrome] ${args.join(" ")}\n`);
}

async function main(): Promise<void> {
  log("Starting AXON Chrome MCP server (stdio)...");

  // Pre-launch browser so tools are available before notifications/initialized
  browser = new BrowserManager({
    headless: process.env.AXON_HEADLESS === "true",
    executablePath: process.env.AXON_CHROME_PATH || undefined,
    defaultViewport: { width: 1280, height: 800 },
    args: ["--no-first-run", "--disable-default-apps", "--disable-popup-blocking"],
  });
  await browser.launch();

  const created = createChromeServer(browser);
  server = created.server;
  store = created.store;
  capAuthority = created.capAuthority;
  initialized = true;

  log(`Ready with ${server.toolCount} tools`);

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on("line", async (line: string) => {
    if (!line.trim()) return;

    let msg: MCPRequest;
    try {
      msg = JSON.parse(line);
    } catch {
      send({
        jsonrpc: "2.0",
        id: 0,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    const response = await handleMessage(msg);
    if (response) {
      send(response);
    }
  });

  rl.on("close", async () => {
    log("stdin closed, shutting down...");
    await browser.close();
    process.exit(0);
  });

  // Handle signals
  process.on("SIGINT", async () => {
    log("SIGINT received, shutting down...");
    await browser.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    log("SIGTERM received, shutting down...");
    await browser.close();
    process.exit(0);
  });
}

main().catch((err) => {
  log("Fatal error:", err.message);
  process.exit(1);
});
