/**
 * AXON Clipboard Server — Tool Definitions
 *
 * 6 clipboard management tools registered with AXON's 3-tier discovery:
 *   Tier 1: Compact manifests (~20 tokens/tool) — always in context
 *   Tier 2: Full schemas — fetched on demand when model calls a tool
 *
 * Results go through OCRS:
 *   - Clipboard history → stored in OCRS, summary shows count
 *   - Search results → stored in OCRS, summary shows matches
 *
 * Capabilities enforce access:
 *   - "resource:read" for getting clipboard, viewing history, searching
 *   - "resource:write" for setting clipboard, pinning, clearing history
 */

import { AxonServer, ResultStore, CapabilityAuthority } from "@axon-protocol/sdk";
import { ClipboardManager } from "./clipboard-manager.js";

export interface ClipboardServerConfig {
  /** Restrict to read-only operations */
  readOnly?: boolean;
}

export function createClipboardServer(
  cm: ClipboardManager,
  config?: ClipboardServerConfig,
): {
  server: AxonServer;
  store: ResultStore;
  capAuthority: CapabilityAuthority;
} {
  const server = new AxonServer({ name: "axon-clipboard", version: "0.1.0" });
  const store = new ResultStore({ max_summary_tokens: 300, max_total_result_tokens: 6000 });

  const key = Buffer.alloc(32);
  Buffer.from(Date.now().toString(16).padStart(32, "0"), "hex").copy(key);
  const capAuthority = new CapabilityAuthority("axon-clipboard", key, key);

  // ==========================================================================
  // Get Clipboard
  // ==========================================================================

  server.tool({
    id: "get_clipboard",
    summary: "Get current clipboard content",
    description:
      "Read the current system clipboard text content. Uses platform-specific commands (pbpaste on macOS, xclip on Linux, PowerShell on Windows).",
    category: "clipboard",
    tags: ["clipboard", "read", "paste", "current"],
    input: {
      type: "object",
      properties: {},
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 500,
      max_result_size_bytes: 1_000_000,
    },
    handler: async () => {
      return cm.getClipboard();
    },
    summarizer: (result: any) => {
      if (!result || !result.content) return "Clipboard is empty";
      const preview = result.content.length > 80
        ? result.content.substring(0, 80) + "..."
        : result.content;
      return `Clipboard (${result.length} chars): "${preview}"`;
    },
  });

  // ==========================================================================
  // Set Clipboard
  // ==========================================================================

  server.tool({
    id: "set_clipboard",
    summary: "Set clipboard content",
    description:
      "Write text to the system clipboard and add the entry to clipboard history. Uses platform-specific commands (pbcopy on macOS, xclip on Linux, PowerShell on Windows).",
    category: "clipboard",
    tags: ["clipboard", "write", "copy", "set"],
    input: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Text content to copy to the clipboard",
        },
      },
      required: ["text"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: true,
      estimated_latency_ms: 500,
      max_result_size_bytes: 1000,
    },
    handler: async ({ text }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return cm.setClipboard(text);
    },
    summarizer: (entry: any) => {
      return `Copied to clipboard (${entry.length} chars, id: ${entry.id})`;
    },
  });

  // ==========================================================================
  // Get History
  // ==========================================================================

  server.tool({
    id: "get_history",
    summary: "Get clipboard history",
    description:
      "Retrieve clipboard history entries, most recent first. Returns up to N entries (default 20). Each entry includes id, content, timestamp, and pinned status.",
    category: "clipboard",
    tags: ["clipboard", "history", "list", "recent"],
    input: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of entries to return (default: 20, max: 100)",
        },
      },
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 100,
      max_result_size_bytes: 500_000,
    },
    handler: async ({ limit }: any) => {
      const max = Math.min(100, Math.max(1, limit ?? 20));
      return cm.getHistory(max);
    },
    summarizer: (result: any) => {
      if (!result || result.total === 0) return "Clipboard history is empty";
      const pinnedCount = result.entries.filter((e: any) => e.pinned).length;
      const pinnedStr = pinnedCount > 0 ? `, ${pinnedCount} pinned` : "";
      return `${result.entries.length} of ${result.total} clipboard entries${pinnedStr}`;
    },
  });

  // ==========================================================================
  // Search History
  // ==========================================================================

  server.tool({
    id: "search_history",
    summary: "Search clipboard history by text",
    description:
      "Search through clipboard history for entries containing the given text. Case-insensitive substring match.",
    category: "clipboard",
    tags: ["clipboard", "search", "find", "history"],
    input: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text to search for in clipboard history entries",
        },
      },
      required: ["query"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 100,
      max_result_size_bytes: 500_000,
    },
    handler: async ({ query }: any) => {
      return cm.searchHistory(query);
    },
    summarizer: (result: any) => {
      if (!result || result.total === 0) return `No clipboard entries match "${result.query}"`;
      return `${result.total} clipboard entries match "${result.query}"`;
    },
  });

  // ==========================================================================
  // Pin Entry
  // ==========================================================================

  server.tool({
    id: "pin_entry",
    summary: "Pin a clipboard entry",
    description:
      "Pin or unpin a clipboard history entry by its ID. Pinned entries are never evicted when the history reaches its maximum size.",
    category: "clipboard",
    tags: ["clipboard", "pin", "keep", "persist"],
    input: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "ID of the clipboard entry to pin (e.g., 'clip_0')",
        },
        pinned: {
          type: "boolean",
          description: "Set to true to pin, false to unpin (default: true)",
        },
      },
      required: ["id"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: true,
      estimated_latency_ms: 100,
      max_result_size_bytes: 1000,
    },
    handler: async ({ id, pinned }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return cm.pinEntry(id, pinned);
    },
    summarizer: (entry: any) => {
      return entry.pinned
        ? `Pinned clipboard entry ${entry.id}`
        : `Unpinned clipboard entry ${entry.id}`;
    },
  });

  // ==========================================================================
  // Clear History
  // ==========================================================================

  server.tool({
    id: "clear_history",
    summary: "Clear clipboard history",
    description:
      "Clear all clipboard history entries. Optionally keep pinned entries. This action cannot be undone.",
    category: "clipboard",
    tags: ["clipboard", "clear", "delete", "reset"],
    input: {
      type: "object",
      properties: {
        keepPinned: {
          type: "boolean",
          description: "If true, keep pinned entries and only clear unpinned ones (default: false)",
        },
      },
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: true,
      estimated_latency_ms: 100,
      max_result_size_bytes: 200,
    },
    handler: async ({ keepPinned }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return cm.clearHistory(keepPinned ?? false);
    },
    summarizer: (result: any) => {
      return `Cleared ${result.cleared} entries, ${result.remaining} remaining`;
    },
  });

  return { server, store, capAuthority };
}
