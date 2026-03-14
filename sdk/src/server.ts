/**
 * AXON Protocol — Server SDK
 *
 * Framework for building AXON-compatible tool servers.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  ToolManifest,
  ToolSchema,
  ToolAnnotations,
  JSONSchema,
  CapabilityType,
  CallMessage,
  ResultMessage,
  FrameType,
  Encoding,
  AxonHello,
  AxonWelcome,
} from "./types.js";

// ============================================================================
// Tool Definition
// ============================================================================

export interface ToolDefinition<TInput = any, TOutput = any> {
  id: string;
  summary: string; // Max 10 words, for manifest
  description: string; // Full description, for schema
  category: string;
  tags: string[];
  input: JSONSchema;
  output?: JSONSchema;
  capabilities_required?: CapabilityType[];
  annotations?: Partial<ToolAnnotations>;
  handler: (params: TInput, context: ToolContext) => Promise<TOutput> | TOutput;
  summarizer?: (result: TOutput) => string;
}

export interface ToolContext {
  sessionId: string;
  streamId: number;
  reportProgress: (progress: number, message?: string) => void;
  isCancelled: () => boolean;
}

// ============================================================================
// AXON Server
// ============================================================================

export class AxonServer {
  private tools: Map<string, ToolDefinition> = new Map();
  private schemaCache: Map<string, { schema: ToolSchema; hash: string }> = new Map();
  private serverName: string;
  private serverVersion: string;

  constructor(options: { name: string; version: string }) {
    this.serverName = options.name;
    this.serverVersion = options.version;
  }

  /**
   * Register a tool with the server.
   */
  tool<TInput = any, TOutput = any>(definition: ToolDefinition<TInput, TOutput>): this {
    this.tools.set(definition.id, definition as ToolDefinition);
    this.updateSchemaCache(definition.id);
    return this;
  }

  /**
   * Get the compact tool manifest for all registered tools.
   * This is what goes into the model's context (~20 tokens/tool).
   */
  getManifest(): ToolManifest[] {
    return Array.from(this.tools.values()).map((t) => ({
      id: t.id,
      summary: t.summary,
      category: t.category,
      tags: t.tags,
    }));
  }

  /**
   * Get the full schema for a specific tool.
   * Returns cached schema with content hash.
   */
  getSchema(toolId: string): ToolSchema | null {
    const cached = this.schemaCache.get(toolId);
    return cached?.schema ?? null;
  }

  /**
   * Get schema hashes for delta sync on reconnection.
   */
  getSchemaHashes(): Record<string, string> {
    const hashes: Record<string, string> = {};
    for (const [id, cached] of this.schemaCache) {
      hashes[id] = cached.hash;
    }
    return hashes;
  }

  /**
   * Execute a tool call. Returns a progressive result.
   */
  async execute(call: CallMessage, context: ToolContext): Promise<ResultMessage> {
    const tool = this.tools.get(call.tool);
    if (!tool) {
      return {
        id: call.id,
        layer: 0,
        status: "error",
        ref: "",
        hash: "",
        summary: `Tool '${call.tool}' not found`,
      };
    }

    try {
      const result = await tool.handler(call.params, context);

      // Generate summary
      const summary = tool.summarizer
        ? tool.summarizer(result)
        : autoSummarize(call.tool, result);

      // Content hash for OCRS
      const resultStr = JSON.stringify(result);
      const contentHash = createHash("sha256")
        .update(call.tool + JSON.stringify(call.params) + resultStr)
        .digest("hex");

      const ref = `ax_r_${contentHash.slice(0, 16)}`;

      return {
        id: call.id,
        layer: 2, // Full result
        status: "ok",
        ref,
        hash: contentHash,
        summary,
        data: result,
      };
    } catch (err: any) {
      return {
        id: call.id,
        layer: 0,
        status: "error",
        ref: "",
        hash: "",
        summary: `Error: ${err.message}`,
      };
    }
  }

  /**
   * Handle an AXON handshake.
   */
  handleHello(hello: AxonHello): AxonWelcome {
    // Select encoding (prefer client's first choice that we support)
    const supportedEncodings = [Encoding.MSGPACK, Encoding.JSON];
    const selectedEncoding =
      hello.encoding.find((e) => supportedEncodings.includes(e)) ?? Encoding.JSON;

    return {
      version: "0.1.0",
      encoding: selectedEncoding,
      session_id: randomUUID(),
      server_manifest: this.getManifest(),
      capability_tokens: [], // Host's Capability Authority issues tokens
    };
  }

  /**
   * Get the number of registered tools.
   */
  get toolCount(): number {
    return this.tools.size;
  }

  /**
   * Estimate context tokens for the full manifest.
   */
  estimateManifestTokens(): number {
    const manifest = this.getManifest();
    const json = JSON.stringify(manifest);
    return Math.ceil(json.length / 4); // ~4 chars per token
  }

  // =========================================================================
  // Private
  // =========================================================================

  private updateSchemaCache(toolId: string): void {
    const tool = this.tools.get(toolId);
    if (!tool) return;

    const schema: ToolSchema = {
      id: tool.id,
      description: tool.description,
      input: tool.input,
      output: tool.output,
      capabilities_required: tool.capabilities_required ?? ["tool:call"],
      annotations: {
        idempotent: tool.annotations?.idempotent ?? false,
        read_only: tool.annotations?.read_only ?? false,
        estimated_latency_ms: tool.annotations?.estimated_latency_ms ?? 100,
        max_result_size_bytes: tool.annotations?.max_result_size_bytes ?? 1_000_000,
      },
      hash: "",
    };

    const canonical = JSON.stringify(schema, Object.keys(schema).sort());
    schema.hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);

    this.schemaCache.set(toolId, { schema, hash: schema.hash });
  }
}

// ============================================================================
// Helpers
// ============================================================================

function autoSummarize(toolId: string, data: any): string {
  if (typeof data === "string") {
    const lines = data.split("\n").length;
    return `${toolId}: ${lines} lines. Preview: "${data.slice(0, 80)}${data.length > 80 ? "..." : ""}"`;
  }

  if (Array.isArray(data)) {
    return `${toolId}: ${data.length} items returned`;
  }

  if (typeof data === "object" && data !== null) {
    const keys = Object.keys(data);
    return `${toolId}: result with fields: ${keys.slice(0, 5).join(", ")}${keys.length > 5 ? ` (+${keys.length - 5} more)` : ""}`;
  }

  return `${toolId}: ${String(data).slice(0, 100)}`;
}
