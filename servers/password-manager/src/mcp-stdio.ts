#!/usr/bin/env npx tsx
/**
 * AXON Password Manager Server — MCP-Compatible Stdio Wrapper
 *
 * Translates MCP JSON-RPC over stdin/stdout into AXON calls.
 * This makes the AXON Password Manager server usable with any MCP client:
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
 *
 * Environment variables:
 *   - AXON_CHROME_PROFILE_DIR: Chrome user data directory
 *   - AXON_CHROME_PROFILE_NAME: Chrome profile name (default: "Default")
 *   - AXON_CHROME_PATH: Custom Chrome executable path
 *   - AXON_HEADLESS: Run in headless mode (default: "false")
 */

import * as readline from "node:readline";
import { PasswordManager } from "./password-manager.js";
import { createPasswordManagerServer } from "./server.js";
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

let pm: PasswordManager;
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
    if (!pm?.isLaunched) {
      pm = new PasswordManager({
        headless: process.env.AXON_HEADLESS === "true",
        executablePath: process.env.AXON_CHROME_PATH || undefined,
        userDataDir: process.env.AXON_CHROME_PROFILE_DIR || undefined,
        profileName: process.env.AXON_CHROME_PROFILE_NAME || "Default",
      });
      await pm.launch();

      const created = createPasswordManagerServer(pm);
      server = created.server;
      store = created.store;
      capAuthority = created.capAuthority;
    }
    initialized = true;
    log("Chrome launched with user profile, password manager server ready");
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
        name: "axon-password-manager",
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
      annotations: schema
        ? {
            title: m.summary,
            readOnlyHint: schema.annotations.read_only,
            idempotentHint: schema.annotations.idempotent,
          }
        : undefined,
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

  // Return data as text content (no screenshots in password manager)
  const data = result.data;
  const textContent =
    typeof data === "string" ? data : JSON.stringify(data, null, 2);

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
  process.stderr.write(`[axon-passwords] ${args.join(" ")}\n`);
}

async function main(): Promise<void> {
  log("Starting AXON Password Manager MCP server (stdio)...");
  log("IMPORTANT: Close Chrome before launching — Puppeteer cannot share a profile directory.");

  // Pre-launch so tools are available immediately
  pm = new PasswordManager({
    headless: process.env.AXON_HEADLESS === "true",
    executablePath: process.env.AXON_CHROME_PATH || undefined,
    userDataDir: process.env.AXON_CHROME_PROFILE_DIR || undefined,
    profileName: process.env.AXON_CHROME_PROFILE_NAME || "Default",
  });
  await pm.launch();

  const created = createPasswordManagerServer(pm);
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
    await pm.close();
    process.exit(0);
  });

  // Handle signals
  process.on("SIGINT", async () => {
    log("SIGINT received, shutting down...");
    await pm.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    log("SIGTERM received, shutting down...");
    await pm.close();
    process.exit(0);
  });
}

main().catch((err) => {
  log("Fatal error:", err.message);
  process.exit(1);
});
