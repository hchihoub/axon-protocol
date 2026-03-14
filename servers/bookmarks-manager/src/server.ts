/**
 * AXON Bookmarks Manager Server — Tool Definitions
 *
 * 7 bookmark management tools registered with AXON's 3-tier discovery:
 *   Tier 1: Compact manifests (~20 tokens/tool) — always in context
 *   Tier 2: Full schemas — fetched on demand when model calls a tool
 *
 * Results go through OCRS:
 *   - Bookmark lists → stored in OCRS, summary in context
 *   - Export data → stored in OCRS, counts in context
 *
 * Capabilities enforce access:
 *   - "resource:read" for listing, searching, exporting
 *   - "resource:write" for add, edit, delete, create folder
 */

import { AxonServer, ResultStore, CapabilityAuthority } from "@axon-protocol/sdk";
import { BookmarksManager } from "./bookmarks-manager.js";

export interface BookmarksServerConfig {
  /** Restrict to read-only operations */
  readOnly?: boolean;
}

export function createBookmarksManagerServer(
  bm: BookmarksManager,
  config?: BookmarksServerConfig,
): {
  server: AxonServer;
  store: ResultStore;
  capAuthority: CapabilityAuthority;
} {
  const server = new AxonServer({ name: "axon-bookmarks-manager", version: "0.1.0" });
  const store = new ResultStore({ max_summary_tokens: 300, max_total_result_tokens: 6000 });

  const key = Buffer.alloc(32);
  Buffer.from(Date.now().toString(16).padStart(32, "0"), "hex").copy(key);
  const capAuthority = new CapabilityAuthority("axon-bookmarks-manager", key, key);

  // ==========================================================================
  // List Bookmarks
  // ==========================================================================

  server.tool({
    id: "list_bookmarks",
    summary: "List all bookmarks and folders",
    description:
      "List all saved bookmarks and folders from Chrome's bookmarks page. Returns titles, URLs, and folder structure.",
    category: "bookmarks",
    tags: ["bookmarks", "list", "browse", "folders"],
    input: {
      type: "object",
      properties: {},
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 3000,
      max_result_size_bytes: 200_000,
    },
    handler: async () => {
      return bm.listBookmarks();
    },
    summarizer: (entries: any[]) => {
      if (!Array.isArray(entries)) return "No bookmarks found";
      const bookmarks = entries.filter((e: any) => e.type === "bookmark");
      const folders = entries.filter((e: any) => e.type === "folder");
      const sample = bookmarks
        .slice(0, 5)
        .map((e: any) => e.title)
        .join(", ");
      return `${bookmarks.length} bookmark(s), ${folders.length} folder(s)${bookmarks.length > 0 ? `: ${sample}${bookmarks.length > 5 ? "..." : ""}` : ""}`;
    },
  });

  // ==========================================================================
  // Search Bookmarks
  // ==========================================================================

  server.tool({
    id: "search_bookmarks",
    summary: "Search bookmarks by title or URL",
    description:
      "Search saved bookmarks by title or URL. Returns matching entries with titles and URLs.",
    category: "bookmarks",
    tags: ["bookmarks", "search", "find"],
    input: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query — matches against bookmark titles and URLs",
        },
      },
      required: ["query"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 3000,
      max_result_size_bytes: 100_000,
    },
    handler: async ({ query }: any) => {
      return bm.searchBookmarks(query);
    },
    summarizer: (entries: any[]) => {
      if (!Array.isArray(entries)) return "No results";
      return `${entries.length} match(es): ${entries
        .slice(0, 5)
        .map((e: any) => e.title)
        .join(", ")}`;
    },
  });

  // ==========================================================================
  // Add Bookmark
  // ==========================================================================

  server.tool({
    id: "add_bookmark",
    summary: "Add a new bookmark",
    description:
      "Add a new bookmark to Chrome's bookmarks. Requires a title and URL. Optionally specify a target folder.",
    category: "bookmarks",
    tags: ["bookmarks", "add", "create", "save"],
    input: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Bookmark title/name",
        },
        url: {
          type: "string",
          description: "Bookmark URL (e.g., 'https://github.com')",
        },
        folder: {
          type: "string",
          description: "Target folder name (optional, defaults to Bookmarks Bar)",
        },
      },
      required: ["title", "url"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: false,
      estimated_latency_ms: 5000,
      max_result_size_bytes: 500,
    },
    handler: async ({ title, url, folder }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return bm.addBookmark(title, url, folder);
    },
    summarizer: (entry: any) => {
      return `Added bookmark "${entry.title}" (${entry.url})`;
    },
  });

  // ==========================================================================
  // Edit Bookmark
  // ==========================================================================

  server.tool({
    id: "edit_bookmark",
    summary: "Edit a bookmark's title or URL",
    description:
      "Modify an existing bookmark's title and/or URL. Identify the bookmark by its current title.",
    category: "bookmarks",
    tags: ["bookmarks", "edit", "update", "modify"],
    input: {
      type: "object",
      properties: {
        currentTitle: {
          type: "string",
          description: "Current bookmark title to identify the entry",
        },
        newTitle: {
          type: "string",
          description: "New title (optional)",
        },
        newUrl: {
          type: "string",
          description: "New URL (optional)",
        },
      },
      required: ["currentTitle"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: false,
      estimated_latency_ms: 5000,
      max_result_size_bytes: 500,
    },
    handler: async ({ currentTitle, newTitle, newUrl }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return bm.editBookmark(currentTitle, newTitle, newUrl);
    },
    summarizer: (entry: any) => {
      return `Updated bookmark "${entry.title}"`;
    },
  });

  // ==========================================================================
  // Delete Bookmark
  // ==========================================================================

  server.tool({
    id: "delete_bookmark",
    summary: "Delete a bookmark",
    description:
      "Delete a bookmark from Chrome's bookmarks. Identify the bookmark by its title. This action is permanent.",
    category: "bookmarks",
    tags: ["bookmarks", "delete", "remove"],
    input: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Bookmark title to delete",
        },
      },
      required: ["title"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: true,
      estimated_latency_ms: 4000,
      max_result_size_bytes: 200,
    },
    handler: async ({ title }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return bm.deleteBookmark(title);
    },
    summarizer: (result: any) => {
      return result ? "Bookmark deleted successfully" : "Bookmark deletion failed";
    },
  });

  // ==========================================================================
  // Create Folder
  // ==========================================================================

  server.tool({
    id: "create_folder",
    summary: "Create a bookmark folder",
    description:
      "Create a new bookmark folder in Chrome's bookmarks. Optionally specify a parent folder.",
    category: "bookmarks",
    tags: ["bookmarks", "folder", "create", "organize"],
    input: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Folder name",
        },
        parentFolder: {
          type: "string",
          description: "Parent folder name (optional, defaults to root)",
        },
      },
      required: ["name"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: false,
      estimated_latency_ms: 5000,
      max_result_size_bytes: 500,
    },
    handler: async ({ name, parentFolder }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return bm.createFolder(name, parentFolder);
    },
    summarizer: (folder: any) => {
      return `Created folder "${folder.title}"`;
    },
  });

  // ==========================================================================
  // Export Bookmarks
  // ==========================================================================

  server.tool({
    id: "export_bookmarks",
    summary: "Export bookmarks as HTML or JSON",
    description:
      "Export all bookmarks from Chrome's bookmarks page. Supports HTML (Netscape format) and JSON export formats.",
    category: "bookmarks",
    tags: ["bookmarks", "export", "backup", "html", "json"],
    input: {
      type: "object",
      properties: {
        format: {
          type: "string",
          description: "Export format: 'html' (default) or 'json'",
          enum: ["html", "json"],
        },
      },
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 5000,
      max_result_size_bytes: 5_000_000,
    },
    handler: async ({ format }: any) => {
      return bm.exportBookmarks(format ?? "html");
    },
    summarizer: (result: any) => {
      if (typeof result === "string") {
        const lines = result.split("\n").length;
        return `Exported bookmarks (${lines} lines) — stored in OCRS`;
      }
      return "Export completed — stored in OCRS";
    },
  });

  return { server, store, capAuthority };
}
