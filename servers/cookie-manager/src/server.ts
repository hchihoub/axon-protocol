/**
 * AXON Cookie Manager Server — Tool Definitions
 *
 * 7 cookie management tools registered with AXON's 3-tier discovery:
 *   Tier 1: Compact manifests (~20 tokens/tool) — always in context
 *   Tier 2: Full schemas — fetched on demand when model calls a tool
 *
 * Results go through OCRS:
 *   - Cookie lists -> stored in OCRS, summary in context
 *   - Cookie exports -> stored in OCRS, summary in context
 *
 * SECURITY: Summarizers NEVER include cookie values.
 * Cookie values only live in OCRS data, never in the model's context window.
 *
 * Capabilities enforce access:
 *   - "resource:read" for listing, searching, getting, exporting
 *   - "resource:write" for set, delete, clear
 */

import { AxonServer, ResultStore, CapabilityAuthority } from "@axon-protocol/sdk";
import { CookieManager } from "./cookie-manager.js";

export interface CookieServerConfig {
  /** Restrict to read-only operations */
  readOnly?: boolean;
}

export function createCookieManagerServer(
  cm: CookieManager,
  config?: CookieServerConfig,
): {
  server: AxonServer;
  store: ResultStore;
  capAuthority: CapabilityAuthority;
} {
  const server = new AxonServer({ name: "axon-cookie-manager", version: "0.1.0" });
  const store = new ResultStore({ max_summary_tokens: 300, max_total_result_tokens: 6000 });

  const key = Buffer.alloc(32);
  Buffer.from(Date.now().toString(16).padStart(32, "0"), "hex").copy(key);
  const capAuthority = new CapabilityAuthority("axon-cookie-manager", key, key);

  // ==========================================================================
  // List Cookies
  // ==========================================================================

  server.tool({
    id: "list_cookies",
    summary: "List all cookies (optionally by domain)",
    description:
      "List all browser cookies, optionally filtered by domain. Returns cookie names, domains, and metadata. Cookie values are included in OCRS data but NEVER appear in summaries.",
    category: "cookies",
    tags: ["cookies", "list", "browse"],
    input: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "Filter cookies by domain (e.g., 'github.com'). If omitted, lists all cookies.",
        },
      },
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 2000,
      max_result_size_bytes: 500_000,
    },
    handler: async ({ domain }: any) => {
      return cm.listCookies(domain);
    },
    // SECURITY: Never include cookie values in summary
    summarizer: (cookies: any[]) => {
      if (!Array.isArray(cookies)) return "No cookies found";
      const count = cookies.length;
      const domains = [...new Set(cookies.map((c: any) => c.domain))];
      const sample = domains.slice(0, 5).join(", ");
      return `${count} cookie(s) across ${domains.length} domain(s)${domains.length > 0 ? `: ${sample}${domains.length > 5 ? "..." : ""}` : ""}`;
    },
  });

  // ==========================================================================
  // Search Cookies
  // ==========================================================================

  server.tool({
    id: "search_cookies",
    summary: "Search cookies by name, domain, or value",
    description:
      "Search cookies by matching against name, domain, or value. Returns matching cookies with metadata. Cookie values are in OCRS data only.",
    category: "cookies",
    tags: ["cookies", "search", "find"],
    input: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query — matches against cookie names, domains, and values",
        },
      },
      required: ["query"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 2000,
      max_result_size_bytes: 100_000,
    },
    handler: async ({ query }: any) => {
      return cm.searchCookies(query);
    },
    // SECURITY: Never include cookie values in summary
    summarizer: (cookies: any[]) => {
      if (!Array.isArray(cookies)) return "No results";
      return `${cookies.length} match(es): ${cookies
        .slice(0, 5)
        .map((c: any) => `${c.name} (${c.domain})`)
        .join(", ")}${cookies.length > 5 ? "..." : ""}`;
    },
  });

  // ==========================================================================
  // Get Cookie
  // ==========================================================================

  server.tool({
    id: "get_cookie",
    summary: "Get a specific cookie by name and domain",
    description:
      "Retrieve a specific cookie by its name and domain. Returns the full cookie including its value. The cookie value is stored in OCRS and NEVER appears in summaries.",
    category: "cookies",
    tags: ["cookies", "get", "retrieve"],
    input: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Cookie name to look up",
        },
        domain: {
          type: "string",
          description: "Domain the cookie belongs to (e.g., 'github.com')",
        },
      },
      required: ["name", "domain"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 2000,
      max_result_size_bytes: 5000,
    },
    handler: async ({ name, domain }: any) => {
      const cookie = await cm.getCookie(name, domain);
      if (!cookie) {
        throw new Error(`Cookie "${name}" not found for domain "${domain}"`);
      }
      return cookie;
    },
    // SECURITY: Never include cookie value in summary
    summarizer: (cookie: any) => {
      return `Cookie "${cookie.name}" on ${cookie.domain} — stored in OCRS [value not shown]`;
    },
  });

  // ==========================================================================
  // Set Cookie
  // ==========================================================================

  server.tool({
    id: "set_cookie",
    summary: "Set or update a cookie",
    description:
      "Set a new cookie or update an existing one. Requires name, value, and domain. Optional parameters control path, expiry, security flags, and SameSite attribute.",
    category: "cookies",
    tags: ["cookies", "set", "create", "update"],
    input: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Cookie name",
        },
        value: {
          type: "string",
          description: "Cookie value",
        },
        domain: {
          type: "string",
          description: "Domain for the cookie (e.g., '.github.com')",
        },
        path: {
          type: "string",
          description: "Cookie path (default: '/')",
        },
        expires: {
          type: "number",
          description: "Expiry time as Unix timestamp in seconds. Omit for session cookie.",
        },
        httpOnly: {
          type: "boolean",
          description: "HttpOnly flag (default: false)",
        },
        secure: {
          type: "boolean",
          description: "Secure flag (default: true)",
        },
        sameSite: {
          type: "string",
          description: "SameSite attribute: 'Strict', 'Lax', or 'None' (default: 'Lax')",
          enum: ["Strict", "Lax", "None"],
        },
      },
      required: ["name", "value", "domain"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: true,
      estimated_latency_ms: 2000,
      max_result_size_bytes: 5000,
    },
    handler: async ({ name, value, domain, path, expires, httpOnly, secure, sameSite }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return cm.setCookie({ name, value, domain, path, expires, httpOnly, secure, sameSite });
    },
    // SECURITY: Never include cookie value in summary
    summarizer: (cookie: any) => {
      return `Set cookie "${cookie.name}" on ${cookie.domain}`;
    },
  });

  // ==========================================================================
  // Delete Cookie
  // ==========================================================================

  server.tool({
    id: "delete_cookie",
    summary: "Delete a specific cookie",
    description:
      "Delete a specific cookie by name and domain. This action is permanent — the cookie cannot be recovered.",
    category: "cookies",
    tags: ["cookies", "delete", "remove"],
    input: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Cookie name to delete",
        },
        domain: {
          type: "string",
          description: "Domain the cookie belongs to",
        },
      },
      required: ["name", "domain"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: true,
      estimated_latency_ms: 1000,
      max_result_size_bytes: 200,
    },
    handler: async ({ name, domain }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return cm.deleteCookie(name, domain);
    },
    summarizer: (result: any) => {
      return result ? "Cookie deleted successfully" : "Cookie deletion failed";
    },
  });

  // ==========================================================================
  // Clear Cookies
  // ==========================================================================

  server.tool({
    id: "clear_cookies",
    summary: "Clear all cookies for a domain",
    description:
      "Delete ALL cookies for a specific domain. This is a bulk operation — all cookies matching the domain will be permanently removed.",
    category: "cookies",
    tags: ["cookies", "clear", "bulk-delete", "domain"],
    input: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "Domain to clear all cookies for (e.g., 'github.com')",
        },
      },
      required: ["domain"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: true,
      estimated_latency_ms: 3000,
      max_result_size_bytes: 500,
    },
    handler: async ({ domain }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return cm.clearCookies(domain);
    },
    summarizer: (result: any) => {
      return `Cleared ${result.cleared} cookie(s) for the specified domain`;
    },
  });

  // ==========================================================================
  // Export Cookies
  // ==========================================================================

  server.tool({
    id: "export_cookies",
    summary: "Export cookies as JSON",
    description:
      "Export all cookies (optionally filtered by domain) as a JSON array. The exported data is stored in OCRS — cookie values NEVER appear in summaries.",
    category: "cookies",
    tags: ["cookies", "export", "backup", "json"],
    input: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "Filter export to a specific domain (optional — exports all if omitted)",
        },
      },
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 2000,
      max_result_size_bytes: 5_000_000,
    },
    handler: async ({ domain }: any) => {
      return cm.exportCookies(domain);
    },
    // SECURITY: Never include cookie values in summary
    summarizer: (cookies: any[]) => {
      if (!Array.isArray(cookies)) return "Export completed — stored in OCRS [values not shown]";
      const domains = [...new Set(cookies.map((c: any) => c.domain))];
      return `Exported ${cookies.length} cookie(s) from ${domains.length} domain(s) — stored in OCRS [values not shown]`;
    },
  });

  return { server, store, capAuthority };
}
