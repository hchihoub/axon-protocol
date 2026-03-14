/**
 * AXON Extensions Manager Server — Tool Definitions
 *
 * 6 extension management tools registered with AXON's 3-tier discovery:
 *   Tier 1: Compact manifests (~20 tokens/tool) — always in context
 *   Tier 2: Full schemas — fetched on demand when model calls a tool
 *
 * Results go through OCRS:
 *   - Extension lists → stored in OCRS, summary in context
 *   - Extension details → stored in OCRS, key info in context
 *
 * Capabilities enforce access:
 *   - "resource:read" for listing, searching, viewing details/permissions
 *   - "resource:write" for toggling, removing
 */

import { AxonServer, ResultStore, CapabilityAuthority } from "@axon-protocol/sdk";
import { ExtensionsManager } from "./extensions-manager.js";

export interface ExtensionsServerConfig {
  /** Restrict to read-only operations */
  readOnly?: boolean;
}

export function createExtensionsManagerServer(
  em: ExtensionsManager,
  config?: ExtensionsServerConfig,
): {
  server: AxonServer;
  store: ResultStore;
  capAuthority: CapabilityAuthority;
} {
  const server = new AxonServer({ name: "axon-extensions-manager", version: "0.1.0" });
  const store = new ResultStore({ max_summary_tokens: 300, max_total_result_tokens: 6000 });

  const key = Buffer.alloc(32);
  Buffer.from(Date.now().toString(16).padStart(32, "0"), "hex").copy(key);
  const capAuthority = new CapabilityAuthority("axon-extensions-manager", key, key);

  // ==========================================================================
  // List Extensions
  // ==========================================================================

  server.tool({
    id: "list_extensions",
    summary: "List all installed extensions with status",
    description:
      "List all installed Chrome extensions with their names, IDs, versions, and enabled/disabled status.",
    category: "extensions",
    tags: ["extensions", "list", "browse", "installed"],
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
      return em.listExtensions();
    },
    summarizer: (entries: any[]) => {
      if (!Array.isArray(entries)) return "No extensions found";
      const enabled = entries.filter((e: any) => e.enabled).length;
      const disabled = entries.length - enabled;
      const sample = entries
        .slice(0, 5)
        .map((e: any) => e.name)
        .join(", ");
      return `${entries.length} extension(s) (${enabled} enabled, ${disabled} disabled): ${sample}${entries.length > 5 ? "..." : ""}`;
    },
  });

  // ==========================================================================
  // Get Extension Details
  // ==========================================================================

  server.tool({
    id: "get_extension_details",
    summary: "Get detailed info about an extension",
    description:
      "Get detailed information about a specific Chrome extension including name, version, description, permissions, site access, and more. Identify the extension by its ID.",
    category: "extensions",
    tags: ["extensions", "details", "info", "inspect"],
    input: {
      type: "object",
      properties: {
        extensionId: {
          type: "string",
          description: "Extension ID (e.g., 'cjpalhdlnbpafiamejdnhcphjbkeiagm')",
        },
      },
      required: ["extensionId"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 5000,
      max_result_size_bytes: 10_000,
    },
    handler: async ({ extensionId }: any) => {
      return em.getExtensionDetails(extensionId);
    },
    summarizer: (details: any) => {
      if (!details) return "Extension not found";
      const status = details.enabled ? "enabled" : "disabled";
      const permCount = details.permissions?.length ?? 0;
      return `${details.name} v${details.version} (${status}, ${permCount} permissions)`;
    },
  });

  // ==========================================================================
  // Toggle Extension
  // ==========================================================================

  server.tool({
    id: "toggle_extension",
    summary: "Enable or disable an extension",
    description:
      "Toggle a Chrome extension on or off. Specify the extension ID and whether to enable or disable it.",
    category: "extensions",
    tags: ["extensions", "toggle", "enable", "disable"],
    input: {
      type: "object",
      properties: {
        extensionId: {
          type: "string",
          description: "Extension ID to toggle",
        },
        enable: {
          type: "boolean",
          description: "True to enable, false to disable",
        },
      },
      required: ["extensionId", "enable"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: true,
      estimated_latency_ms: 4000,
      max_result_size_bytes: 200,
    },
    handler: async ({ extensionId, enable }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return em.toggleExtension(extensionId, enable);
    },
    summarizer: (result: any) => {
      return result ? "Extension toggled successfully" : "Failed to toggle extension";
    },
  });

  // ==========================================================================
  // Search Extensions
  // ==========================================================================

  server.tool({
    id: "search_extensions",
    summary: "Search installed extensions",
    description:
      "Search installed Chrome extensions by name, description, or ID. Returns matching extensions with their status.",
    category: "extensions",
    tags: ["extensions", "search", "find"],
    input: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query — matches against extension names, descriptions, and IDs",
        },
      },
      required: ["query"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 4000,
      max_result_size_bytes: 100_000,
    },
    handler: async ({ query }: any) => {
      return em.searchExtensions(query);
    },
    summarizer: (entries: any[]) => {
      if (!Array.isArray(entries)) return "No results";
      return `${entries.length} match(es): ${entries
        .slice(0, 5)
        .map((e: any) => e.name)
        .join(", ")}`;
    },
  });

  // ==========================================================================
  // Get Extension Permissions
  // ==========================================================================

  server.tool({
    id: "get_extension_permissions",
    summary: "View permissions for an extension",
    description:
      "Get the list of permissions requested by a specific Chrome extension. Useful for security auditing and understanding what access an extension has.",
    category: "extensions",
    tags: ["extensions", "permissions", "security", "audit"],
    input: {
      type: "object",
      properties: {
        extensionId: {
          type: "string",
          description: "Extension ID to check permissions for",
        },
      },
      required: ["extensionId"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 5000,
      max_result_size_bytes: 10_000,
    },
    handler: async ({ extensionId }: any) => {
      const permissions = await em.getExtensionPermissions(extensionId);
      return { extensionId, permissions };
    },
    summarizer: (result: any) => {
      const perms = result.permissions ?? [];
      if (perms.length === 0) return "No permissions found";
      return `${perms.length} permission(s): ${perms.slice(0, 5).join(", ")}${perms.length > 5 ? "..." : ""}`;
    },
  });

  // ==========================================================================
  // Remove Extension
  // ==========================================================================

  server.tool({
    id: "remove_extension",
    summary: "Remove an extension",
    description:
      "Remove (uninstall) a Chrome extension. Identify the extension by its ID. This action is permanent and will remove the extension from Chrome.",
    category: "extensions",
    tags: ["extensions", "remove", "uninstall", "delete"],
    input: {
      type: "object",
      properties: {
        extensionId: {
          type: "string",
          description: "Extension ID to remove",
        },
      },
      required: ["extensionId"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: true,
      estimated_latency_ms: 5000,
      max_result_size_bytes: 200,
    },
    handler: async ({ extensionId }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return em.removeExtension(extensionId);
    },
    summarizer: (result: any) => {
      return result ? "Extension removed successfully" : "Extension removal failed";
    },
  });

  return { server, store, capAuthority };
}
