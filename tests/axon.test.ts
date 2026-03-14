/**
 * AXON Protocol — Comprehensive Test Suite
 *
 * Tests all core components:
 * 1. Binary frame encoding/decoding
 * 2. Capability-based security
 * 3. Out-of-Context Result Store (OCRS)
 * 4. MCP-to-AXON Bridge
 * 5. MCP Simulator
 * 6. Stream Multiplexer
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  // Frame
  encodeFrame,
  decodeFrame,
  FrameReader,
  AxonFrameError,
  hasFlag,
  setFlag,
  // Types
  FrameType,
  FrameFlag,
  Frame,
  Encoding,
  StreamPriority,
  // Capability
  CapabilityAuthority,
  globMatch,
  isScopeSubset,
  // OCRS
  ResultStore,
  // Server
  AxonServer,
  // Bridge
  MCPToAxonBridge,
  // Simulator
  generateMCPServer,
  generateBenchmarkServers,
  estimateMCPContextTokens,
  mcpToolsListResponseSize,
} from "../sdk/src/index.js";

// ============================================================================
// 1. Binary Frame Tests
// ============================================================================

describe("Binary Frame Encoding", () => {
  it("should encode and decode a frame roundtrip", () => {
    const payload = new TextEncoder().encode('{"tool":"read_file"}');
    const frame: Frame = {
      magic: 0xaa,
      streamId: 42,
      type: FrameType.CALL,
      flags: FrameFlag.FIN,
      payload,
    };

    const encoded = encodeFrame(frame);
    const decoded = decodeFrame(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded!.frame.magic).toBe(0xaa);
    expect(decoded!.frame.streamId).toBe(42);
    expect(decoded!.frame.type).toBe(FrameType.CALL);
    expect(decoded!.frame.flags).toBe(FrameFlag.FIN);
    expect(new TextDecoder().decode(decoded!.frame.payload)).toBe('{"tool":"read_file"}');
    expect(decoded!.bytesRead).toBe(8 + payload.byteLength);
  });

  it("should handle empty payload", () => {
    const frame: Frame = {
      magic: 0xaa,
      streamId: 1,
      type: FrameType.PING,
      flags: 0,
      payload: new Uint8Array(0),
    };

    const encoded = encodeFrame(frame);
    expect(encoded.byteLength).toBe(8); // Header only

    const decoded = decodeFrame(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.frame.payload.byteLength).toBe(0);
  });

  it("should handle max stream ID (65535)", () => {
    const frame: Frame = {
      magic: 0xaa,
      streamId: 65535,
      type: FrameType.RESULT,
      flags: 0,
      payload: new Uint8Array([1, 2, 3]),
    };

    const decoded = decodeFrame(encodeFrame(frame));
    expect(decoded!.frame.streamId).toBe(65535);
  });

  it("should handle combined flags", () => {
    let flags = 0;
    flags = setFlag(flags, FrameFlag.FIN);
    flags = setFlag(flags, FrameFlag.COMPRESSED);
    flags = setFlag(flags, FrameFlag.SIGNED);

    expect(hasFlag(flags, FrameFlag.FIN)).toBe(true);
    expect(hasFlag(flags, FrameFlag.COMPRESSED)).toBe(true);
    expect(hasFlag(flags, FrameFlag.SIGNED)).toBe(true);
    expect(hasFlag(flags, FrameFlag.PRIORITY)).toBe(false);
  });

  it("should return null for incomplete data", () => {
    const result = decodeFrame(new Uint8Array([0xaa, 0x00]));
    expect(result).toBeNull();
  });

  it("should throw on invalid magic byte", () => {
    const bad = new Uint8Array(8);
    bad[0] = 0xff; // Wrong magic
    expect(() => decodeFrame(bad)).toThrow(AxonFrameError);
  });

  it("should handle large payloads (100KB)", () => {
    const payload = new Uint8Array(100_000);
    payload.fill(0x42);

    const frame: Frame = {
      magic: 0xaa,
      streamId: 7,
      type: FrameType.RESULT,
      flags: FrameFlag.FIN,
      payload,
    };

    const decoded = decodeFrame(encodeFrame(frame));
    expect(decoded!.frame.payload.byteLength).toBe(100_000);
    expect(decoded!.frame.payload[0]).toBe(0x42);
  });
});

describe("FrameReader (streaming)", () => {
  it("should parse multiple frames from a single chunk", () => {
    const reader = new FrameReader();

    const f1 = encodeFrame({
      magic: 0xaa, streamId: 1, type: FrameType.CALL,
      flags: FrameFlag.FIN, payload: new TextEncoder().encode("a"),
    });
    const f2 = encodeFrame({
      magic: 0xaa, streamId: 2, type: FrameType.RESULT,
      flags: FrameFlag.FIN, payload: new TextEncoder().encode("b"),
    });

    const combined = new Uint8Array(f1.byteLength + f2.byteLength);
    combined.set(f1, 0);
    combined.set(f2, f1.byteLength);

    const frames = reader.push(combined);
    expect(frames).toHaveLength(2);
    expect(frames[0].streamId).toBe(1);
    expect(frames[1].streamId).toBe(2);
  });

  it("should handle split frames across chunks", () => {
    const reader = new FrameReader();

    const full = encodeFrame({
      magic: 0xaa, streamId: 5, type: FrameType.CALL,
      flags: 0, payload: new TextEncoder().encode("hello world"),
    });

    // Split in the middle
    const part1 = full.slice(0, 5);
    const part2 = full.slice(5);

    expect(reader.push(part1)).toHaveLength(0);
    expect(reader.pending).toBe(5);

    const frames = reader.push(part2);
    expect(frames).toHaveLength(1);
    expect(new TextDecoder().decode(frames[0].payload)).toBe("hello world");
  });
});

// ============================================================================
// 2. Capability-Based Security Tests
// ============================================================================

describe("Capability Authority", () => {
  let authority: CapabilityAuthority;

  beforeEach(() => {
    const key = Buffer.from("test-key-32-bytes-long-for-hmac!", "utf-8");
    authority = new CapabilityAuthority("test-authority", key, key);
  });

  it("should issue and validate a capability token", () => {
    const token = authority.issue("session-1", "tool:call", "read_file");
    expect(token.type).toBe("tool:call");
    expect(token.scope).toBe("read_file");
    expect(token.signature).toBeTruthy();
    expect(authority.validate(token)).toBeNull(); // null = valid
  });

  it("should reject an expired token", () => {
    const token = authority.issue("session-1", "tool:call", "read_file", {
      ttl_seconds: -1, // Already expired
    });
    expect(authority.validate(token)).toContain("expired");
  });

  it("should reject a revoked token", () => {
    const token = authority.issue("session-1", "tool:call", "read_file");
    expect(authority.validate(token)).toBeNull();

    authority.revoke(token.id);
    expect(authority.validate(token)).toContain("revoked");
  });

  it("should reject a tampered token", () => {
    const token = authority.issue("session-1", "tool:call", "read_file");
    token.scope = "/etc/passwd"; // Tamper with scope
    expect(authority.validate(token)).toContain("signature");
  });

  it("should enforce scope matching", () => {
    const token = authority.issue("session-1", "resource:read", "/project/src/**");

    expect(authority.checkScope(token, "/project/src/main.ts")).toBe(true);
    expect(authority.checkScope(token, "/project/src/lib/utils.ts")).toBe(true);
    expect(authority.checkScope(token, "/etc/passwd")).toBe(false);
    expect(authority.checkScope(token, "/project/test/main.ts")).toBe(false);
  });

  it("should enforce parameter constraints", () => {
    const token = authority.issue("session-1", "tool:call", "query_db", {
      parameter_constraints: {
        limit: { max_value: 100, min_value: 1 },
        table: { allowed_values: ["users", "orders"] },
      },
    });

    expect(authority.checkParams(token, { limit: 50, table: "users" })).toBeNull();
    expect(authority.checkParams(token, { limit: 200 })).toContain("exceeds max");
    expect(authority.checkParams(token, { limit: 0 })).toContain("below min");
    expect(authority.checkParams(token, { table: "secrets" })).toContain("not in allowed");
  });

  it("should attenuate to a narrower scope", () => {
    const broad = authority.issue("session-1", "resource:read", "/project/**");
    const narrow = authority.attenuate(broad, "/project/src/main.ts");

    expect(narrow).not.toBeNull();
    expect(narrow!.scope).toBe("/project/src/main.ts");
    expect(authority.validate(narrow!)).toBeNull();
  });

  it("should refuse to widen scope via attenuation", () => {
    const narrow = authority.issue("session-1", "resource:read", "/project/src/main.ts");
    const wider = authority.attenuate(narrow, "/project/**");

    expect(wider).toBeNull();
  });

  it("should refuse to attenuate a revoked token", () => {
    const token = authority.issue("session-1", "resource:read", "/project/**");
    authority.revoke(token.id);

    const attenuated = authority.attenuate(token, "/project/src/**");
    expect(attenuated).toBeNull();
  });
});

describe("Glob Matching", () => {
  it("should match exact paths", () => {
    expect(globMatch("read_file", "read_file")).toBe(true);
    expect(globMatch("read_file", "write_file")).toBe(false);
  });

  it("should match * as single segment", () => {
    expect(globMatch("/project/*/file.ts", "/project/src/file.ts")).toBe(true);
    expect(globMatch("/project/*/file.ts", "/project/src/lib/file.ts")).toBe(false);
  });

  it("should match ** as multiple segments", () => {
    expect(globMatch("/project/**", "/project/src/lib/deep/file.ts")).toBe(true);
    expect(globMatch("/project/**", "/project/file.ts")).toBe(true);
    expect(globMatch("/other/**", "/project/file.ts")).toBe(false);
  });

  it("should handle wildcard-only patterns", () => {
    expect(globMatch("*", "anything")).toBe(true);
  });

  it("should validate subset relationships", () => {
    expect(isScopeSubset("/project/src/main.ts", "/project/**")).toBe(true);
    expect(isScopeSubset("/etc/passwd", "/project/**")).toBe(false);
  });
});

// ============================================================================
// 3. OCRS Tests
// ============================================================================

describe("Out-of-Context Result Store", () => {
  let store: ResultStore;

  beforeEach(() => {
    store = new ResultStore({
      max_summary_tokens: 200,
      max_total_result_tokens: 2000,
    });
  });

  it("should store and retrieve results", () => {
    const data = Array.from({ length: 50 }, (_, i) => ({ id: i, name: `item-${i}` }));
    const entry = store.store("search", { query: "test" }, data);

    expect(entry.ref).toMatch(/^ax_r_/);
    expect(entry.size_tokens_estimate).toBeGreaterThan(0);
    expect(store.get(entry.ref)).toBeDefined();
  });

  it("should deduplicate identical results", () => {
    const data = [{ id: 1 }, { id: 2 }];
    const entry1 = store.store("tool1", { a: 1 }, data);
    const entry2 = store.store("tool1", { a: 1 }, data);

    expect(entry1.ref).toBe(entry2.ref);
    expect(store.stats().total_entries).toBe(1);
  });

  it("should filter results with selectors", () => {
    const data = [
      { file: "a.ts", line: 1 },
      { file: "b.ts", line: 2 },
      { file: "a.ts", line: 3 },
    ];
    const entry = store.store("search", {}, data);

    const filtered = store.query(entry.ref, { filter: { file: "a.ts" } });
    expect(filtered).toHaveLength(2);
    expect(filtered.every((r: any) => r.file === "a.ts")).toBe(true);
  });

  it("should select specific fields", () => {
    const data = [{ file: "a.ts", line: 1, content: "long content" }];
    const entry = store.store("search", {}, data);

    const selected = store.query(entry.ref, { select: ["line"] });
    expect(selected).toEqual([{ line: 1 }]);
  });

  it("should sort results", () => {
    const data = [{ score: 3 }, { score: 1 }, { score: 2 }];
    const entry = store.store("scores", {}, data);

    const sorted = store.query(entry.ref, {
      sort: { field: "score", order: "asc" },
    });
    expect(sorted.map((s: any) => s.score)).toEqual([1, 2, 3]);
  });

  it("should paginate results", () => {
    const data = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const entry = store.store("many", {}, data);

    const page = store.query(entry.ref, {
      slice: { offset: 10, limit: 5 },
    });
    expect(page).toHaveLength(5);
    expect(page[0].id).toBe(10);
    expect(page[4].id).toBe(14);
  });

  it("should generate context summaries within budget", () => {
    const data = Array.from({ length: 1000 }, (_, i) => ({ id: i, text: `item ${i}` }));
    const entry = store.store("large", {}, data);

    const summary = store.getSummaryForContext(entry.ref);
    expect(summary).toContain("[large]");
    expect(summary).toContain("[ref:");
    // Summary should be much smaller than the full data
    expect(summary!.length).toBeLessThan(JSON.stringify(data).length * 0.1);
  });

  it("should evict old summaries when budget exceeded", () => {
    // Fill the budget
    for (let i = 0; i < 20; i++) {
      const data = Array.from({ length: 50 }, (_, j) => ({ id: j, batch: i }));
      const entry = store.store(`tool${i}`, { i }, data);
      store.getSummaryForContext(entry.ref);
    }

    const stats = store.stats();
    expect(stats.context_tokens_used).toBeLessThanOrEqual(2000);
    expect(stats.total_entries).toBe(20); // All stored, but not all in context
  });
});

// ============================================================================
// 4. AXON Server Tests
// ============================================================================

describe("AXON Server", () => {
  let server: AxonServer;

  beforeEach(() => {
    server = new AxonServer({ name: "test-server", version: "1.0.0" });
    server.tool({
      id: "echo",
      summary: "Echo input back",
      description: "Returns the input text unchanged",
      category: "utility",
      tags: ["echo", "test"],
      input: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      annotations: { read_only: true, idempotent: true },
      handler: ({ text }: any) => text,
    });
  });

  it("should generate compact manifests", () => {
    const manifest = server.getManifest();
    expect(manifest).toHaveLength(1);
    expect(manifest[0].id).toBe("echo");
    expect(manifest[0].summary).toBe("Echo input back");

    // Manifest should be much smaller than full schema
    const manifestSize = JSON.stringify(manifest).length;
    const schemaSize = JSON.stringify(server.getSchema("echo")).length;
    expect(manifestSize).toBeLessThan(schemaSize);
  });

  it("should cache schemas with content hashes", () => {
    const schema = server.getSchema("echo");
    expect(schema).not.toBeNull();
    expect(schema!.hash).toBeTruthy();
    expect(schema!.hash.length).toBe(16);
  });

  it("should execute tool calls", async () => {
    const result = await server.execute(
      { id: 1, tool: "echo", params: { text: "hello" }, capability: "" },
      { sessionId: "s1", streamId: 1, reportProgress: () => {}, isCancelled: () => false }
    );
    expect(result.status).toBe("ok");
    expect(result.data).toBe("hello");
    expect(result.summary).toBeTruthy();
  });

  it("should return error for unknown tools", async () => {
    const result = await server.execute(
      { id: 1, tool: "nonexistent", params: {}, capability: "" },
      { sessionId: "s1", streamId: 1, reportProgress: () => {}, isCancelled: () => false }
    );
    expect(result.status).toBe("error");
  });

  it("should handle AXON handshake", () => {
    const welcome = server.handleHello({
      version: "0.1.0",
      encoding: [Encoding.MSGPACK, Encoding.JSON],
      transport: "local",
      capabilities: [],
    });

    expect(welcome.version).toBe("0.1.0");
    expect(welcome.session_id).toBeTruthy();
    expect(welcome.server_manifest).toHaveLength(1);
  });
});

// ============================================================================
// 5. MCP Simulator Tests
// ============================================================================

describe("MCP Simulator", () => {
  it("should generate servers at different scales", () => {
    const servers = generateBenchmarkServers();

    expect(servers.small.tools).toHaveLength(5);
    expect(servers.medium.tools).toHaveLength(25);
    expect(servers.large.tools).toHaveLength(93);
    expect(servers.xl.tools).toHaveLength(200);
  });

  it("should generate valid MCP tool definitions", () => {
    const server = generateMCPServer("test", 10);
    for (const tool of server.tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });

  it("should produce realistic results", () => {
    const server = generateMCPServer("test", 5);
    const tool = server.tools[0];

    const result = server.handleCall(tool.name, {});
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
  });

  it("should estimate MCP context tokens", () => {
    const server = generateMCPServer("test", 93);
    const tokens = estimateMCPContextTokens(server);

    // 93 simulated tools (shorter descs than real MCP) — ~200 tokens/tool
    expect(tokens).toBeGreaterThan(10_000);
    expect(tokens).toBeLessThan(100_000);
  });

  it("should calculate tools/list response size", () => {
    const server = generateMCPServer("test", 93);
    const bytes = mcpToolsListResponseSize(server);

    // Large JSON response
    expect(bytes).toBeGreaterThan(50_000);
  });
});

// ============================================================================
// 6. MCP-to-AXON Bridge Tests
// ============================================================================

describe("MCP-to-AXON Bridge", () => {
  let bridge: MCPToAxonBridge;
  const mcpServer = generateMCPServer("test-server", 10);

  beforeEach(() => {
    bridge = new MCPToAxonBridge();
    bridge.importMCPTools(mcpServer.tools);
  });

  it("should convert MCP tools to AXON manifests", () => {
    const manifest = bridge.getManifest();
    expect(manifest).toHaveLength(10);

    for (const entry of manifest) {
      expect(entry.id).toBeTruthy();
      expect(entry.summary.split(/\s+/).length).toBeLessThanOrEqual(10);
      expect(entry.category).toBeTruthy();
      expect(entry.tags.length).toBeGreaterThan(0);
    }
  });

  it("should achieve >75% token reduction on manifests", () => {
    const stats = bridge.getStats();
    // Even with shorter simulated descriptions, AXON manifests are far smaller.
    // Real-world MCP tools with verbose schemas see 90-97% savings.
    expect(stats.token_savings_percent).toBeGreaterThan(75);
  });

  it("should provide on-demand schemas", () => {
    const toolName = mcpServer.tools[0].name;
    const schema = bridge.getSchema(toolName);

    expect(schema).not.toBeNull();
    expect(schema!.id).toBe(toolName);
    expect(schema!.description).toBeTruthy();
    expect(schema!.input).toBeDefined();
    expect(schema!.hash).toBeTruthy();
  });

  it("should bridge tool calls and store results in OCRS", async () => {
    const executor = bridge.createMCPExecutor(mcpServer);
    const toolName = mcpServer.tools[0].name;

    const result = await bridge.bridgeCall(
      { id: 1, tool: toolName, params: { path: "/test.ts" }, capability: "" },
      executor
    );

    expect(result.result.status).toBe("ok");
    expect(result.result.ref).toMatch(/^ax_r_/);
    expect(result.contextInjection).toBeTruthy();
    expect(result.axonContextSize).toBeLessThan(result.mcpResultSize);
  });

  it("should achieve significant context reduction on results", async () => {
    const executor = bridge.createMCPExecutor(mcpServer);

    // Execute multiple tool calls
    for (let i = 0; i < 5; i++) {
      const tool = mcpServer.tools[i % mcpServer.tools.length];
      await bridge.bridgeCall(
        { id: i, tool: tool.name, params: { path: `/test${i}.ts`, query: "auth" }, capability: "" },
        executor
      );
    }

    const stats = bridge.getStats();
    expect(stats.total_calls_bridged).toBe(5);
    expect(stats.total_result_tokens_saved).toBeGreaterThan(0);
    expect(stats.total_axon_context_tokens).toBeLessThan(stats.total_mcp_result_tokens);
  });

  it("should handle AXON handshake with MCP backend", () => {
    const welcome = bridge.handleHello({
      version: "0.1.0",
      encoding: [Encoding.MSGPACK, Encoding.JSON],
      transport: "stream",
      capabilities: [],
    });

    expect(welcome.session_id).toBeTruthy();
    expect(welcome.server_manifest).toHaveLength(10);
    expect(welcome.capability_tokens.length).toBeGreaterThan(0);
  });

  it("should enforce capabilities on bridged calls", async () => {
    const capAuthority = bridge.getCapAuthority();
    const executor = bridge.createMCPExecutor(mcpServer);

    // Issue a narrow capability
    const token = capAuthority.issue("s1", "tool:call", mcpServer.tools[0].name);

    // Call with valid capability
    const result1 = await bridge.bridgeCall(
      { id: 1, tool: mcpServer.tools[0].name, params: {}, capability: JSON.stringify(token) },
      executor
    );
    expect(result1.result.status).toBe("ok");

    // Call with capability for wrong tool
    const result2 = await bridge.bridgeCall(
      { id: 2, tool: mcpServer.tools[1].name, params: {}, capability: JSON.stringify(token) },
      executor
    );
    expect(result2.result.status).toBe("error");
    expect(result2.result.summary).toContain("Scope violation");
  });

  it("should track wire bytes for MCP vs AXON", async () => {
    const executor = bridge.createMCPExecutor(mcpServer);

    for (let i = 0; i < 3; i++) {
      const tool = mcpServer.tools[i % mcpServer.tools.length];
      await bridge.bridgeCall(
        { id: i, tool: tool.name, params: { query: "test" }, capability: "" },
        executor
      );
    }

    const stats = bridge.getStats();
    expect(stats.wire_bytes_mcp).toBeGreaterThan(0);
    expect(stats.wire_bytes_axon).toBeGreaterThan(0);
    expect(stats.wire_bytes_axon).toBeLessThan(stats.wire_bytes_mcp);
  });
});
