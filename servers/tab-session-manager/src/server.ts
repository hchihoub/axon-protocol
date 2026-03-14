/**
 * AXON Tab Session Manager Server — Tool Definitions
 *
 * 8 tab and session management tools registered with AXON's 3-tier discovery:
 *   Tier 1: Compact manifests (~20 tokens/tool) — always in context
 *   Tier 2: Full schemas — fetched on demand when model calls a tool
 *
 * Results go through OCRS:
 *   - Tab lists -> stored in OCRS, summary in context
 *   - Session data -> stored in OCRS, summary in context
 *
 * Capabilities enforce access:
 *   - "resource:read" for listing, searching
 *   - "resource:write" for open, close, save, restore, delete
 */

import { AxonServer, ResultStore, CapabilityAuthority } from "@axon-protocol/sdk";
import { TabSessionManager } from "./tab-session-manager.js";

export interface TabServerConfig {
  /** Restrict to read-only operations */
  readOnly?: boolean;
}

export function createTabSessionManagerServer(
  tsm: TabSessionManager,
  config?: TabServerConfig,
): {
  server: AxonServer;
  store: ResultStore;
  capAuthority: CapabilityAuthority;
} {
  const server = new AxonServer({ name: "axon-tab-session-manager", version: "0.1.0" });
  const store = new ResultStore({ max_summary_tokens: 300, max_total_result_tokens: 6000 });

  const key = Buffer.alloc(32);
  Buffer.from(Date.now().toString(16).padStart(32, "0"), "hex").copy(key);
  const capAuthority = new CapabilityAuthority("axon-tab-session-manager", key, key);

  // ==========================================================================
  // List Tabs
  // ==========================================================================

  server.tool({
    id: "list_tabs",
    summary: "List all open browser tabs",
    description:
      "List all currently open browser tabs with their index, title, and URL. Use the index to switch to or close a specific tab.",
    category: "tabs",
    tags: ["tabs", "list", "browse"],
    input: {
      type: "object",
      properties: {},
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 1000,
      max_result_size_bytes: 50_000,
    },
    handler: async () => {
      return tsm.listTabs();
    },
    summarizer: (tabs: any[]) => {
      if (!Array.isArray(tabs)) return "No tabs found";
      const count = tabs.length;
      const sample = tabs
        .slice(0, 5)
        .map((t: any) => t.title || t.url)
        .join(", ");
      return `${count} open tab(s)${count > 0 ? `: ${sample}${count > 5 ? "..." : ""}` : ""}`;
    },
  });

  // ==========================================================================
  // Open Tab
  // ==========================================================================

  server.tool({
    id: "open_tab",
    summary: "Open a new browser tab",
    description:
      "Open a new browser tab with an optional URL. If no URL is provided, opens a blank tab. Returns the tab's index, title, and URL.",
    category: "tabs",
    tags: ["tabs", "open", "new", "navigate"],
    input: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL to open in the new tab (optional, defaults to blank tab)",
        },
      },
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: false,
      estimated_latency_ms: 5000,
      max_result_size_bytes: 1000,
    },
    handler: async ({ url }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return tsm.openTab(url);
    },
    summarizer: (tab: any) => {
      return `Opened tab #${tab.index}: ${tab.title || tab.url || "blank"}`;
    },
  });

  // ==========================================================================
  // Close Tab
  // ==========================================================================

  server.tool({
    id: "close_tab",
    summary: "Close a browser tab",
    description:
      "Close a browser tab by index or URL match. Provide either an index (from list_tabs) or a URL substring to match. Cannot close the last remaining tab.",
    category: "tabs",
    tags: ["tabs", "close", "remove"],
    input: {
      type: "object",
      properties: {
        index: {
          type: "number",
          description: "Tab index to close (from list_tabs)",
        },
        url: {
          type: "string",
          description: "URL substring to match — closes the first matching tab",
        },
      },
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: true,
      estimated_latency_ms: 1000,
      max_result_size_bytes: 500,
    },
    handler: async ({ index, url }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return tsm.closeTab({ index, url });
    },
    summarizer: (result: any) => {
      if (!result.closed) return "No matching tab found to close";
      return `Closed tab #${result.tab.index}: ${result.tab.title || result.tab.url}`;
    },
  });

  // ==========================================================================
  // Switch Tab
  // ==========================================================================

  server.tool({
    id: "switch_tab",
    summary: "Switch to a browser tab",
    description:
      "Bring a tab to focus by its index (from list_tabs). The tab becomes the active/visible tab in the browser window.",
    category: "tabs",
    tags: ["tabs", "switch", "focus", "activate"],
    input: {
      type: "object",
      properties: {
        index: {
          type: "number",
          description: "Tab index to switch to (from list_tabs)",
        },
      },
      required: ["index"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: true,
      estimated_latency_ms: 500,
      max_result_size_bytes: 500,
    },
    handler: async ({ index }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return tsm.switchTab(index);
    },
    summarizer: (tab: any) => {
      return `Switched to tab #${tab.index}: ${tab.title || tab.url}`;
    },
  });

  // ==========================================================================
  // Save Session
  // ==========================================================================

  server.tool({
    id: "save_session",
    summary: "Save current tabs as a named session",
    description:
      "Save all currently open tabs as a named session to disk (~/.axon/tab-sessions.json). If a session with the same name exists, it will be overwritten. The session can later be restored with restore_session.",
    category: "sessions",
    tags: ["sessions", "save", "persist", "backup"],
    input: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Session name (e.g., 'work', 'research', 'morning-routine')",
        },
      },
      required: ["name"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: true,
      estimated_latency_ms: 2000,
      max_result_size_bytes: 50_000,
    },
    handler: async ({ name }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return tsm.saveSession(name);
    },
    summarizer: (session: any) => {
      return `Saved session "${session.name}" with ${session.tabs?.length ?? 0} tab(s)`;
    },
  });

  // ==========================================================================
  // Restore Session
  // ==========================================================================

  server.tool({
    id: "restore_session",
    summary: "Restore a saved session",
    description:
      "Restore a previously saved session by opening all of its tabs. Existing tabs remain open. Use list_sessions to see available session names.",
    category: "sessions",
    tags: ["sessions", "restore", "open", "load"],
    input: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the session to restore (from list_sessions)",
        },
      },
      required: ["name"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: false,
      estimated_latency_ms: 15000,
      max_result_size_bytes: 50_000,
    },
    handler: async ({ name }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return tsm.restoreSession(name);
    },
    summarizer: (result: any) => {
      const total = result.openedTabs?.length ?? 0;
      const failed = result.openedTabs?.filter((t: any) => t.index === -1).length ?? 0;
      const msg = `Restored session "${result.session.name}": ${total} tab(s) opened`;
      return failed > 0 ? `${msg} (${failed} failed)` : msg;
    },
  });

  // ==========================================================================
  // List Sessions
  // ==========================================================================

  server.tool({
    id: "list_sessions",
    summary: "List all saved sessions",
    description:
      "List all saved tab sessions from disk (~/.axon/tab-sessions.json). Shows session names, tab counts, and timestamps.",
    category: "sessions",
    tags: ["sessions", "list", "browse"],
    input: {
      type: "object",
      properties: {},
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 100,
      max_result_size_bytes: 50_000,
    },
    handler: async () => {
      return tsm.listSessions();
    },
    summarizer: (sessions: any[]) => {
      if (!Array.isArray(sessions) || sessions.length === 0) return "No saved sessions";
      const names = sessions.map((s: any) => `"${s.name}" (${s.tabs?.length ?? 0} tabs)`);
      return `${sessions.length} saved session(s): ${names.join(", ")}`;
    },
  });

  // ==========================================================================
  // Delete Session
  // ==========================================================================

  server.tool({
    id: "delete_session",
    summary: "Delete a saved session",
    description:
      "Delete a saved session by name from disk. This action is permanent — the session cannot be recovered after deletion.",
    category: "sessions",
    tags: ["sessions", "delete", "remove"],
    input: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the session to delete",
        },
      },
      required: ["name"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: true,
      estimated_latency_ms: 100,
      max_result_size_bytes: 200,
    },
    handler: async ({ name }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return tsm.deleteSession(name);
    },
    summarizer: (result: any) => {
      return result ? "Session deleted successfully" : "Session not found";
    },
  });

  return { server, store, capAuthority };
}
