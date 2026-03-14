/**
 * AXON History Analyzer Server — Tool Definitions
 *
 * 6 history analysis tools registered with AXON's 3-tier discovery:
 *   Tier 1: Compact manifests (~20 tokens/tool) — always in context
 *   Tier 2: Full schemas — fetched on demand when model calls a tool
 *
 * Results go through OCRS:
 *   - History lists → stored in OCRS, summary in context
 *   - Analytics data → stored in OCRS, top results in context
 *
 * Capabilities enforce access:
 *   - "resource:read" for searching, browsing, analyzing
 *   - "resource:write" for deleting, clearing
 */

import { AxonServer, ResultStore, CapabilityAuthority } from "@axon-protocol/sdk";
import { HistoryAnalyzer } from "./history-analyzer.js";

export interface HistoryServerConfig {
  /** Restrict to read-only operations */
  readOnly?: boolean;
}

export function createHistoryAnalyzerServer(
  ha: HistoryAnalyzer,
  config?: HistoryServerConfig,
): {
  server: AxonServer;
  store: ResultStore;
  capAuthority: CapabilityAuthority;
} {
  const server = new AxonServer({ name: "axon-history-analyzer", version: "0.1.0" });
  const store = new ResultStore({ max_summary_tokens: 300, max_total_result_tokens: 6000 });

  const key = Buffer.alloc(32);
  Buffer.from(Date.now().toString(16).padStart(32, "0"), "hex").copy(key);
  const capAuthority = new CapabilityAuthority("axon-history-analyzer", key, key);

  // ==========================================================================
  // Search History
  // ==========================================================================

  server.tool({
    id: "search_history",
    summary: "Search browsing history by keyword or URL",
    description:
      "Search Chrome browsing history by keyword, site name, or URL. Returns matching history entries with titles, URLs, and timestamps.",
    category: "history",
    tags: ["history", "search", "find", "browse"],
    input: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query — matches against page titles and URLs",
        },
      },
      required: ["query"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 4000,
      max_result_size_bytes: 200_000,
    },
    handler: async ({ query }: any) => {
      return ha.searchHistory(query);
    },
    summarizer: (entries: any[]) => {
      if (!Array.isArray(entries)) return "No results";
      const sample = entries
        .slice(0, 5)
        .map((e: any) => e.title || e.url)
        .join(", ");
      return `${entries.length} result(s): ${sample}${entries.length > 5 ? "..." : ""}`;
    },
  });

  // ==========================================================================
  // Get Recent History
  // ==========================================================================

  server.tool({
    id: "get_recent_history",
    summary: "Get recent browsing history entries",
    description:
      "Get the most recent N browsing history entries. Defaults to 50 entries. Returns titles, URLs, and visit timestamps.",
    category: "history",
    tags: ["history", "recent", "latest", "browse"],
    input: {
      type: "object",
      properties: {
        count: {
          type: "number",
          description: "Number of recent entries to return (default: 50, max: 500)",
        },
      },
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 5000,
      max_result_size_bytes: 500_000,
    },
    handler: async ({ count }: any) => {
      const n = Math.min(500, Math.max(1, count ?? 50));
      return ha.getRecentHistory(n);
    },
    summarizer: (entries: any[]) => {
      if (!Array.isArray(entries)) return "No history found";
      const sample = entries
        .slice(0, 3)
        .map((e: any) => e.title || e.domain || e.url)
        .join(", ");
      return `${entries.length} recent entry(ies): ${sample}${entries.length > 3 ? "..." : ""}`;
    },
  });

  // ==========================================================================
  // Get History By Date
  // ==========================================================================

  server.tool({
    id: "get_history_by_date",
    summary: "Get history for a specific date range",
    description:
      "Get browsing history entries for a specific date range. Provide start and optional end dates in ISO format (YYYY-MM-DD).",
    category: "history",
    tags: ["history", "date", "range", "filter"],
    input: {
      type: "object",
      properties: {
        startDate: {
          type: "string",
          description: "Start date in ISO format (e.g., '2025-01-15')",
        },
        endDate: {
          type: "string",
          description: "End date in ISO format (optional, defaults to today)",
        },
      },
      required: ["startDate"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 5000,
      max_result_size_bytes: 500_000,
    },
    handler: async ({ startDate, endDate }: any) => {
      return ha.getHistoryByDate(startDate, endDate);
    },
    summarizer: (entries: any[]) => {
      if (!Array.isArray(entries)) return "No history found for date range";
      return `${entries.length} entry(ies) in date range`;
    },
  });

  // ==========================================================================
  // Delete History Entry
  // ==========================================================================

  server.tool({
    id: "delete_history_entry",
    summary: "Delete a specific history entry",
    description:
      "Delete a specific browsing history entry by title or URL. This action is permanent and cannot be undone.",
    category: "history",
    tags: ["history", "delete", "remove"],
    input: {
      type: "object",
      properties: {
        titleOrUrl: {
          type: "string",
          description: "Title or URL of the history entry to delete",
        },
      },
      required: ["titleOrUrl"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: true,
      estimated_latency_ms: 5000,
      max_result_size_bytes: 200,
    },
    handler: async ({ titleOrUrl }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return ha.deleteHistoryEntry(titleOrUrl);
    },
    summarizer: (result: any) => {
      return result ? "History entry deleted successfully" : "History entry deletion failed";
    },
  });

  // ==========================================================================
  // Clear History
  // ==========================================================================

  server.tool({
    id: "clear_history",
    summary: "Clear browsing history for a date range",
    description:
      "Clear browsing history data. Can optionally specify a date range. WARNING: This clears all browsing history in the specified range and cannot be undone.",
    category: "history",
    tags: ["history", "clear", "delete", "wipe"],
    input: {
      type: "object",
      properties: {
        startDate: {
          type: "string",
          description: "Start date in ISO format (optional)",
        },
        endDate: {
          type: "string",
          description: "End date in ISO format (optional)",
        },
      },
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: false,
      estimated_latency_ms: 8000,
      max_result_size_bytes: 200,
    },
    handler: async ({ startDate, endDate }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return ha.clearHistory(startDate, endDate);
    },
    summarizer: (result: any) => {
      return result ? "Browsing history cleared successfully" : "Failed to clear browsing history";
    },
  });

  // ==========================================================================
  // Get Most Visited
  // ==========================================================================

  server.tool({
    id: "get_most_visited",
    summary: "Get most frequently visited sites",
    description:
      "Analyze browsing history to find the most frequently visited websites. Returns sites ranked by visit frequency with domain grouping.",
    category: "history",
    tags: ["history", "analytics", "top-sites", "frequency", "most-visited"],
    input: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of sites to return (default: 20)",
        },
      },
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 8000,
      max_result_size_bytes: 50_000,
    },
    handler: async ({ limit }: any) => {
      const n = Math.min(100, Math.max(1, limit ?? 20));
      return ha.getMostVisited(n);
    },
    summarizer: (sites: any[]) => {
      if (!Array.isArray(sites)) return "No visit data available";
      const top = sites
        .slice(0, 5)
        .map((s: any) => `${s.domain} (${s.visitCount})`)
        .join(", ");
      return `Top ${sites.length} sites: ${top}${sites.length > 5 ? "..." : ""}`;
    },
  });

  return { server, store, capAuthority };
}
