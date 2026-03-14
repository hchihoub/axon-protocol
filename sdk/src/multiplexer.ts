/**
 * AXON Protocol — Stream Multiplexer
 *
 * Manages concurrent tool call streams over a single connection.
 * Supports dependency graphs, priorities, and cancellation.
 */

import { EventEmitter } from "node:events";
import {
  CallMessage,
  CallGraph,
  CallGraphNode,
  ResultMessage,
  StreamPriority,
  FrameType,
  FrameFlag,
  Frame,
} from "./types.js";
import { encodeFrame, FrameReader } from "./frame.js";

// ============================================================================
// Stream
// ============================================================================

export interface Stream {
  id: number;
  toolId: string;
  priority: StreamPriority;
  state: "pending" | "active" | "completed" | "cancelled" | "error";
  callMessage: CallMessage;
  results: ResultMessage[];
  createdAt: number;
  completedAt?: number;
}

// ============================================================================
// Multiplexer
// ============================================================================

export class Multiplexer extends EventEmitter {
  private streams: Map<number, Stream> = new Map();
  private nextStreamId = 1;
  private frameReader = new FrameReader();
  private sendFn: (data: Uint8Array) => void;
  private encoder: (data: any) => Uint8Array;
  private decoder: (data: Uint8Array) => any;

  constructor(options: {
    send: (data: Uint8Array) => void;
    encode: (data: any) => Uint8Array;
    decode: (data: Uint8Array) => any;
  }) {
    super();
    this.sendFn = options.send;
    this.encoder = options.encode;
    this.decoder = options.decode;
  }

  /**
   * Execute a single tool call on a new stream.
   */
  call(message: CallMessage): number {
    const streamId = this.nextStreamId++;
    message.id = streamId;

    const stream: Stream = {
      id: streamId,
      toolId: message.tool,
      priority: message.priority ?? StreamPriority.STANDARD,
      state: "active",
      callMessage: message,
      results: [],
      createdAt: Date.now(),
    };

    this.streams.set(streamId, stream);

    // Send CALL frame
    const payload = this.encoder(message);
    let flags = FrameFlag.FIN;
    if (stream.priority <= StreamPriority.INTERACTIVE) {
      flags |= FrameFlag.PRIORITY;
    }

    this.sendFrame(streamId, FrameType.CALL, flags, payload);

    return streamId;
  }

  /**
   * Execute a call graph — multiple tool calls with dependencies.
   * Returns a map of call IDs to stream IDs.
   */
  async callGraph(graph: CallGraph): Promise<Map<string, number>> {
    const callToStream = new Map<string, number>();
    const callResults = new Map<string, ResultMessage>();

    // Topological sort
    const sorted = topoSort(graph.calls);

    // Group by dependency level for parallel execution
    const levels = groupByLevel(sorted, graph.calls);

    for (const level of levels) {
      // Execute all calls in this level in parallel
      const promises = level.map(async (node) => {
        // Resolve parameter bindings from previous results
        const resolvedParams = resolveBindings(node, callResults);

        const message: CallMessage = {
          id: 0,
          tool: node.tool,
          params: resolvedParams,
          capability: "", // Must be set by caller
        };

        const streamId = this.call(message);
        callToStream.set(node.id, streamId);

        // Wait for this stream to complete
        const result = await this.waitForStream(streamId);
        callResults.set(node.id, result);
      });

      await Promise.all(promises);
    }

    return callToStream;
  }

  /**
   * Cancel an in-flight stream.
   */
  cancel(streamId: number, reason = "cancelled"): void {
    const stream = this.streams.get(streamId);
    if (!stream || stream.state !== "active") return;

    stream.state = "cancelled";
    stream.completedAt = Date.now();

    this.sendFrame(
      streamId,
      FrameType.CANCEL,
      FrameFlag.FIN,
      this.encoder({ stream: streamId, reason })
    );

    this.emit("stream:cancelled", streamId, reason);
  }

  /**
   * Process incoming data from the connection.
   */
  receive(data: Uint8Array): void {
    const frames = this.frameReader.push(data);

    for (const frame of frames) {
      this.handleFrame(frame);
    }
  }

  /**
   * Get stream by ID.
   */
  getStream(streamId: number): Stream | undefined {
    return this.streams.get(streamId);
  }

  /**
   * Get all active streams, sorted by priority.
   */
  activeStreams(): Stream[] {
    return Array.from(this.streams.values())
      .filter((s) => s.state === "active")
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * Get multiplexer statistics.
   */
  stats(): {
    total_streams: number;
    active: number;
    completed: number;
    cancelled: number;
    avg_latency_ms: number;
  } {
    const all = Array.from(this.streams.values());
    const completed = all.filter((s) => s.state === "completed");
    const avgLatency =
      completed.length > 0
        ? completed.reduce((sum, s) => sum + ((s.completedAt ?? 0) - s.createdAt), 0) / completed.length
        : 0;

    return {
      total_streams: all.length,
      active: all.filter((s) => s.state === "active").length,
      completed: completed.length,
      cancelled: all.filter((s) => s.state === "cancelled").length,
      avg_latency_ms: Math.round(avgLatency),
    };
  }

  // =========================================================================
  // Private
  // =========================================================================

  private handleFrame(frame: Frame): void {
    const stream = this.streams.get(frame.streamId);

    switch (frame.type) {
      case FrameType.RESULT: {
        const result = this.decoder(frame.payload) as ResultMessage;

        if (stream) {
          stream.results.push(result);

          // Emit progressive results
          this.emit("stream:result", frame.streamId, result);

          // Check if this is the final result
          if (result.status !== "partial" && !result.streaming) {
            stream.state = "completed";
            stream.completedAt = Date.now();
            this.emit("stream:complete", frame.streamId, result);
          }
        }
        break;
      }

      case FrameType.PROGRESS: {
        const progress = this.decoder(frame.payload);
        this.emit("stream:progress", frame.streamId, progress);
        break;
      }

      case FrameType.ERROR: {
        const error = this.decoder(frame.payload);
        if (stream) {
          stream.state = "error";
          stream.completedAt = Date.now();
        }
        this.emit("stream:error", frame.streamId, error);
        break;
      }

      case FrameType.CAPABILITY: {
        const cap = this.decoder(frame.payload);
        this.emit("capability", cap);
        break;
      }

      default:
        this.emit("frame", frame);
    }
  }

  private sendFrame(
    streamId: number,
    type: FrameType,
    flags: number,
    payload: Uint8Array
  ): void {
    const frame: Frame = {
      magic: 0xaa,
      streamId,
      type,
      flags,
      payload,
    };
    this.sendFn(encodeFrame(frame));
  }

  private waitForStream(streamId: number): Promise<ResultMessage> {
    return new Promise((resolve, reject) => {
      const onComplete = (id: number, result: ResultMessage) => {
        if (id !== streamId) return;
        this.off("stream:complete", onComplete);
        this.off("stream:error", onError);
        resolve(result);
      };
      const onError = (id: number, error: any) => {
        if (id !== streamId) return;
        this.off("stream:complete", onComplete);
        this.off("stream:error", onError);
        reject(error);
      };
      this.on("stream:complete", onComplete);
      this.on("stream:error", onError);
    });
  }
}

// ============================================================================
// Graph Utilities
// ============================================================================

function topoSort(calls: CallGraphNode[]): CallGraphNode[] {
  const visited = new Set<string>();
  const sorted: CallGraphNode[] = [];
  const callMap = new Map(calls.map((c) => [c.id, c]));

  function visit(id: string): void {
    if (visited.has(id)) return;
    visited.add(id);
    const node = callMap.get(id)!;
    for (const dep of node.depends_on ?? []) {
      visit(dep);
    }
    sorted.push(node);
  }

  for (const call of calls) {
    visit(call.id);
  }

  return sorted;
}

function groupByLevel(
  sorted: CallGraphNode[],
  allCalls: CallGraphNode[]
): CallGraphNode[][] {
  const levels: CallGraphNode[][] = [];
  const nodeLevel = new Map<string, number>();

  for (const node of sorted) {
    let maxDepLevel = -1;
    for (const dep of node.depends_on ?? []) {
      maxDepLevel = Math.max(maxDepLevel, nodeLevel.get(dep) ?? 0);
    }
    const level = maxDepLevel + 1;
    nodeLevel.set(node.id, level);

    while (levels.length <= level) levels.push([]);
    levels[level].push(node);
  }

  return levels;
}

function resolveBindings(
  node: CallGraphNode,
  results: Map<string, ResultMessage>
): Record<string, any> {
  const params = { ...node.params };

  if (node.param_bindings) {
    for (const [param, binding] of Object.entries(node.param_bindings)) {
      const result = results.get(binding.from_call);
      if (result?.data) {
        // Simple JSONPath resolution ($.field[index].subfield)
        params[param] = resolvePath(result.data, binding.select);
      }
    }
  }

  return params;
}

/**
 * Minimal JSONPath resolver for parameter bindings.
 */
function resolvePath(data: any, path: string): any {
  const parts = path
    .replace(/^\$\.?/, "")
    .split(/\.|\[(\d+)\]/)
    .filter(Boolean);

  let current = data;
  for (const part of parts) {
    if (current == null) return undefined;
    const index = parseInt(part, 10);
    current = isNaN(index) ? current[part] : current[index];
  }
  return current;
}
