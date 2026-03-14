/**
 * AXON Screenshot Server — Tool Definitions
 *
 * 5 screenshot tools registered with AXON's 3-tier discovery:
 *   Tier 1: Compact manifests (~20 tokens/tool) — always in context
 *   Tier 2: Full schemas — fetched on demand when model calls a tool
 *
 * Results go through OCRS:
 *   - Screenshot data (base64) → stored in OCRS, summary shows dimensions/size
 *   - Screenshot lists → stored in OCRS, summary shows count
 *
 * Capabilities enforce access:
 *   - "resource:read" for listing, viewing screenshots
 *   - "resource:write" for taking screenshots, deleting
 */

import { AxonServer, ResultStore, CapabilityAuthority } from "@axon-protocol/sdk";
import { ScreenshotManager } from "./screenshot-manager.js";

export interface ScreenshotServerConfig {
  /** Restrict to read-only operations */
  readOnly?: boolean;
}

export function createScreenshotServer(
  sm: ScreenshotManager,
  config?: ScreenshotServerConfig,
): {
  server: AxonServer;
  store: ResultStore;
  capAuthority: CapabilityAuthority;
} {
  const server = new AxonServer({ name: "axon-screenshot", version: "0.1.0" });
  const store = new ResultStore({ max_summary_tokens: 300, max_total_result_tokens: 6000 });

  const key = Buffer.alloc(32);
  Buffer.from(Date.now().toString(16).padStart(32, "0"), "hex").copy(key);
  const capAuthority = new CapabilityAuthority("axon-screenshot", key, key);

  // ==========================================================================
  // Take Screenshot
  // ==========================================================================

  server.tool({
    id: "take_screenshot",
    summary: "Capture full screen or region",
    description:
      "Take a screenshot of the full screen or a specific rectangular region. The screenshot is saved as a PNG file in ~/.axon/screenshots/. On macOS uses screencapture, on Linux uses import/gnome-screenshot/scrot, on Windows uses PowerShell.",
    category: "screenshot",
    tags: ["screenshot", "capture", "screen", "image"],
    input: {
      type: "object",
      properties: {
        region: {
          type: "object",
          description: "Optional region to capture. Omit for full screen.",
          properties: {
            x: { type: "number", description: "X coordinate of top-left corner" },
            y: { type: "number", description: "Y coordinate of top-left corner" },
            width: { type: "number", description: "Width of the region in pixels" },
            height: { type: "number", description: "Height of the region in pixels" },
          },
          required: ["x", "y", "width", "height"],
        },
        label: {
          type: "string",
          description: "Optional label or description for the screenshot",
        },
      },
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: false,
      estimated_latency_ms: 2000,
      max_result_size_bytes: 5000,
    },
    handler: async ({ region, label }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return sm.takeScreenshot({ region, label });
    },
    summarizer: (info: any) => {
      const sizeKB = Math.round(info.sizeBytes / 1024);
      const labelStr = info.label ? ` "${info.label}"` : "";
      return `Screenshot captured${labelStr}: ${info.captureType}, ${sizeKB} KB (id: ${info.id})`;
    },
  });

  // ==========================================================================
  // List Screenshots
  // ==========================================================================

  server.tool({
    id: "list_screenshots",
    summary: "List saved screenshots",
    description:
      "List all saved screenshots with metadata (id, filename, timestamp, size, capture type). Screenshots are sorted by most recent first.",
    category: "screenshot",
    tags: ["screenshot", "list", "browse", "history"],
    input: {
      type: "object",
      properties: {},
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 100,
      max_result_size_bytes: 100_000,
    },
    handler: async () => {
      return sm.listScreenshots();
    },
    summarizer: (result: any) => {
      if (!result || result.total === 0) return "No screenshots saved";
      const totalSize = result.screenshots.reduce((sum: number, s: any) => sum + s.sizeBytes, 0);
      const totalMB = (totalSize / (1024 * 1024)).toFixed(1);
      return `${result.total} screenshot(s), ${totalMB} MB total`;
    },
  });

  // ==========================================================================
  // Get Screenshot
  // ==========================================================================

  server.tool({
    id: "get_screenshot",
    summary: "Read a screenshot as base64",
    description:
      "Read a saved screenshot file and return it as base64-encoded PNG data. Use list_screenshots to find screenshot IDs. The base64 data is stored in OCRS.",
    category: "screenshot",
    tags: ["screenshot", "read", "get", "base64", "image"],
    input: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Screenshot ID (e.g., 'ss_0') from list_screenshots",
        },
      },
      required: ["id"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 500,
      max_result_size_bytes: 50_000_000,
    },
    handler: async ({ id }: any) => {
      return sm.getScreenshot(id);
    },
    summarizer: (result: any) => {
      const sizeKB = Math.round(result.info.sizeBytes / 1024);
      return `Screenshot ${result.info.id}: ${sizeKB} KB PNG — base64 data stored in OCRS`;
    },
  });

  // ==========================================================================
  // Delete Screenshot
  // ==========================================================================

  server.tool({
    id: "delete_screenshot",
    summary: "Delete a saved screenshot",
    description:
      "Delete a saved screenshot file from disk. This action is permanent and cannot be undone. Use list_screenshots to find screenshot IDs.",
    category: "screenshot",
    tags: ["screenshot", "delete", "remove", "cleanup"],
    input: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Screenshot ID (e.g., 'ss_0') from list_screenshots",
        },
      },
      required: ["id"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: true,
      estimated_latency_ms: 200,
      max_result_size_bytes: 500,
    },
    handler: async ({ id }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return sm.deleteScreenshot(id);
    },
    summarizer: (result: any) => {
      return result.deleted
        ? `Deleted screenshot: ${result.filename}`
        : "Screenshot deletion failed";
    },
  });

  // ==========================================================================
  // Capture Window
  // ==========================================================================

  server.tool({
    id: "capture_window",
    summary: "Capture a specific window by title",
    description:
      "Capture a screenshot of a specific application window identified by its title. On macOS uses screencapture -l with window ID. On Linux uses xdotool + import. On Windows uses PowerShell FindWindow API.",
    category: "screenshot",
    tags: ["screenshot", "window", "capture", "application"],
    input: {
      type: "object",
      properties: {
        windowTitle: {
          type: "string",
          description: "Title (or partial title) of the window to capture",
        },
        label: {
          type: "string",
          description: "Optional label or description for the screenshot",
        },
      },
      required: ["windowTitle"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: false,
      estimated_latency_ms: 3000,
      max_result_size_bytes: 5000,
    },
    handler: async ({ windowTitle, label }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return sm.captureWindow(windowTitle, label);
    },
    summarizer: (info: any) => {
      const sizeKB = Math.round(info.sizeBytes / 1024);
      return `Window captured "${info.label}": ${sizeKB} KB (id: ${info.id})`;
    },
  });

  return { server, store, capAuthority };
}
