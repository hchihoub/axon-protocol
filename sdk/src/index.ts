/**
 * AXON Protocol SDK
 * Agent eXchange Over Network — v0.1.0
 *
 * A next-generation tool protocol for AI agents.
 * Designed for minimal context consumption, structural security,
 * and multiplexed parallel execution.
 *
 * @example
 * ```ts
 * import { AxonServer, CapabilityAuthority, ResultStore } from "@axon-protocol/sdk";
 *
 * const server = new AxonServer({ name: "my-tools", version: "1.0.0" });
 *
 * server.tool({
 *   id: "read_file",
 *   summary: "Read file contents",
 *   description: "Read the full contents of a file at the given path",
 *   category: "filesystem",
 *   tags: ["read", "io"],
 *   input: {
 *     type: "object",
 *     properties: {
 *       path: { type: "string", description: "Absolute file path" },
 *     },
 *     required: ["path"],
 *   },
 *   annotations: { read_only: true, idempotent: true },
 *   handler: async ({ path }) => {
 *     const fs = await import("node:fs/promises");
 *     return fs.readFile(path, "utf-8");
 *   },
 *   summarizer: (content) => {
 *     const lines = content.split("\\n").length;
 *     return `${lines} lines. First line: "${content.split("\\n")[0]}"`;
 *   },
 * });
 * ```
 */

// Core types
export * from "./types.js";

// Binary framing
export { encodeFrame, decodeFrame, FrameReader, AxonFrameError, hasFlag, setFlag, clearFlag } from "./frame.js";

// Capability-based security
export { CapabilityAuthority, globMatch, isScopeSubset } from "./capability.js";

// Out-of-Context Result Store
export { ResultStore } from "./ocrs.js";

// Stream multiplexer
export { Multiplexer } from "./multiplexer.js";
export type { Stream } from "./multiplexer.js";

// Server SDK
export { AxonServer } from "./server.js";
export type { ToolDefinition, ToolContext } from "./server.js";

// MCP-to-AXON Bridge
export { MCPToAxonBridge } from "./bridge.js";
export type { BridgeConfig, BridgeStats } from "./bridge.js";

// MCP Types & Simulator
export * from "./mcp-types.js";
export { generateMCPServer, generateBenchmarkServers, estimateMCPContextTokens, mcpToolsListResponseSize } from "./mcp-simulator.js";
