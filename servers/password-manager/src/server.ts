/**
 * AXON Password Manager Server — Tool Definitions
 *
 * 9 password management tools registered with AXON's 3-tier discovery:
 *   Tier 1: Compact manifests (~20 tokens/tool) — always in context
 *   Tier 2: Full schemas — fetched on demand when model calls a tool
 *
 * Results go through OCRS:
 *   - Password lists → stored in OCRS, summary in context
 *   - Security reports → stored in OCRS, counts in context
 *
 * SECURITY: Summarizers NEVER include password values.
 * Passwords only live in OCRS data, never in the model's context window.
 *
 * Capabilities enforce access:
 *   - "resource:read" for listing, searching, checking
 *   - "resource:write" for add, edit, delete
 */

import { AxonServer, ResultStore, CapabilityAuthority } from "@axon-protocol/sdk";
import { PasswordManager } from "./password-manager.js";

export interface PasswordServerConfig {
  /** Restrict to read-only operations */
  readOnly?: boolean;
}

export function createPasswordManagerServer(
  pm: PasswordManager,
  config?: PasswordServerConfig,
): {
  server: AxonServer;
  store: ResultStore;
  capAuthority: CapabilityAuthority;
} {
  const server = new AxonServer({ name: "axon-password-manager", version: "0.1.0" });
  const store = new ResultStore({ max_summary_tokens: 300, max_total_result_tokens: 6000 });

  const key = Buffer.alloc(32);
  Buffer.from(Date.now().toString(16).padStart(32, "0"), "hex").copy(key);
  const capAuthority = new CapabilityAuthority("axon-password-manager", key, key);

  // ==========================================================================
  // List Passwords
  // ==========================================================================

  server.tool({
    id: "list_passwords",
    summary: "List all saved passwords",
    description:
      "List all saved password entries from Chrome's password manager. Returns site URLs and usernames only — passwords are NEVER included in the list. Use get_password to retrieve a specific password.",
    category: "passwords",
    tags: ["passwords", "list", "browse"],
    input: {
      type: "object",
      properties: {},
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 3000,
      max_result_size_bytes: 100_000,
    },
    handler: async () => {
      return pm.listPasswords();
    },
    summarizer: (entries: any[]) => {
      if (!Array.isArray(entries)) return "No passwords found";
      const count = entries.length;
      const sample = entries
        .slice(0, 5)
        .map((e: any) => e.site)
        .join(", ");
      return `${count} saved password(s)${count > 0 ? `: ${sample}${count > 5 ? "..." : ""}` : ""}`;
    },
  });

  // ==========================================================================
  // Search Passwords
  // ==========================================================================

  server.tool({
    id: "search_passwords",
    summary: "Search passwords by site or username",
    description:
      "Search saved passwords by site URL or username. Returns matching entries without password values.",
    category: "passwords",
    tags: ["passwords", "search", "find"],
    input: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query — matches against site URLs and usernames",
        },
      },
      required: ["query"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 3000,
      max_result_size_bytes: 50_000,
    },
    handler: async ({ query }: any) => {
      return pm.searchPasswords(query);
    },
    summarizer: (entries: any[]) => {
      if (!Array.isArray(entries)) return "No results";
      return `${entries.length} match(es): ${entries
        .slice(0, 5)
        .map((e: any) => `${e.site} (${e.username})`)
        .join(", ")}`;
    },
  });

  // ==========================================================================
  // Get Password (with value)
  // ==========================================================================

  server.tool({
    id: "get_password",
    summary: "Get a specific password",
    description:
      "Retrieve a saved password including its value. May trigger OS authentication (Touch ID, system password). The password value is stored in OCRS and NEVER appears in summaries.",
    category: "passwords",
    tags: ["passwords", "get", "retrieve", "credential"],
    input: {
      type: "object",
      properties: {
        site: {
          type: "string",
          description: "Site URL or domain to match (e.g., 'github.com')",
        },
        username: {
          type: "string",
          description: "Username or email to match",
        },
      },
      required: ["site"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 5000,
      max_result_size_bytes: 1000,
    },
    handler: async ({ site, username }: any) => {
      return pm.getPassword(site, username ?? "");
    },
    // SECURITY: Never include password in summary
    summarizer: (entry: any) => {
      return `Password retrieved for ${entry.site} (${entry.username}) — stored in OCRS [password not shown]`;
    },
  });

  // ==========================================================================
  // Add Password
  // ==========================================================================

  server.tool({
    id: "add_password",
    summary: "Add a new password entry",
    description:
      "Add a new password entry to Chrome's password manager. Requires site URL, username, and password.",
    category: "passwords",
    tags: ["passwords", "add", "create", "save"],
    input: {
      type: "object",
      properties: {
        site: {
          type: "string",
          description: "Website URL (e.g., 'https://github.com')",
        },
        username: {
          type: "string",
          description: "Username or email",
        },
        password: {
          type: "string",
          description: "Password value",
        },
        note: {
          type: "string",
          description: "Optional note for this entry",
        },
      },
      required: ["site", "username", "password"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: false,
      estimated_latency_ms: 5000,
      max_result_size_bytes: 500,
    },
    handler: async ({ site, username, password, note }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return pm.addPassword(site, username, password, note);
    },
    // SECURITY: Never include password in summary
    summarizer: (entry: any) => {
      return `Added password for ${entry.site} (${entry.username})`;
    },
  });

  // ==========================================================================
  // Edit Password
  // ==========================================================================

  server.tool({
    id: "edit_password",
    summary: "Edit an existing password",
    description:
      "Modify an existing password entry. Can update username, password, and/or note. Identify the entry by site and current username.",
    category: "passwords",
    tags: ["passwords", "edit", "update", "modify"],
    input: {
      type: "object",
      properties: {
        site: {
          type: "string",
          description: "Site URL to identify the entry",
        },
        username: {
          type: "string",
          description: "Current username to identify the entry",
        },
        newUsername: {
          type: "string",
          description: "New username (optional)",
        },
        newPassword: {
          type: "string",
          description: "New password (optional)",
        },
        newNote: {
          type: "string",
          description: "New note (optional)",
        },
      },
      required: ["site", "username"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: false,
      estimated_latency_ms: 5000,
      max_result_size_bytes: 500,
    },
    handler: async ({ site, username, newUsername, newPassword, newNote }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return pm.editPassword(site, username, { newUsername, newPassword, newNote });
    },
    // SECURITY: Never include password in summary
    summarizer: (entry: any) => {
      return `Updated password for ${entry.site} (${entry.username})`;
    },
  });

  // ==========================================================================
  // Delete Password
  // ==========================================================================

  server.tool({
    id: "delete_password",
    summary: "Delete a saved password",
    description:
      "Delete a password entry from Chrome's password manager. Identify the entry by site and username. This action is permanent.",
    category: "passwords",
    tags: ["passwords", "delete", "remove"],
    input: {
      type: "object",
      properties: {
        site: {
          type: "string",
          description: "Site URL to identify the entry",
        },
        username: {
          type: "string",
          description: "Username to identify the entry",
        },
      },
      required: ["site", "username"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: true,
      estimated_latency_ms: 4000,
      max_result_size_bytes: 200,
    },
    handler: async ({ site, username }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return pm.deletePassword(site, username);
    },
    summarizer: (result: any) => {
      return result ? "Password deleted successfully" : "Password deletion failed";
    },
  });

  // ==========================================================================
  // Generate Password
  // ==========================================================================

  server.tool({
    id: "generate_password",
    summary: "Generate a strong password",
    description:
      "Generate a cryptographically strong random password. Uses crypto.getRandomValues for true randomness. The generated password is stored in OCRS and NEVER appears in summaries.",
    category: "passwords",
    tags: ["passwords", "generate", "random", "strong"],
    input: {
      type: "object",
      properties: {
        length: {
          type: "number",
          description: "Password length (default: 20, min: 8, max: 128)",
        },
        includeSymbols: {
          type: "boolean",
          description: "Include special characters (default: true)",
        },
        includeNumbers: {
          type: "boolean",
          description: "Include digits (default: true)",
        },
      },
    },
    annotations: {
      read_only: true,
      idempotent: false,
      estimated_latency_ms: 200,
      max_result_size_bytes: 200,
    },
    handler: async ({ length, includeSymbols, includeNumbers }: any) => {
      const len = Math.min(128, Math.max(8, length ?? 20));
      const password = await pm.generatePassword({
        length: len,
        includeSymbols: includeSymbols ?? true,
        includeNumbers: includeNumbers ?? true,
      });
      return { password, length: len };
    },
    // SECURITY: Never include generated password in summary
    summarizer: (result: any) => {
      return `Generated ${result.length}-character password — stored in OCRS [password not shown]`;
    },
  });

  // ==========================================================================
  // Check Compromised
  // ==========================================================================

  server.tool({
    id: "check_compromised",
    summary: "Check for compromised passwords",
    description:
      "Run Chrome's password security checkup. Identifies compromised (leaked), reused, and weak passwords. May take several seconds to complete the check.",
    category: "passwords",
    tags: ["passwords", "security", "checkup", "compromised", "breach"],
    input: {
      type: "object",
      properties: {},
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 10000,
      max_result_size_bytes: 100_000,
    },
    handler: async () => {
      return pm.checkCompromised();
    },
    summarizer: (report: any) => {
      const parts = [];
      if (report.compromised?.length > 0) parts.push(`${report.compromised.length} compromised`);
      if (report.reused?.length > 0) parts.push(`${report.reused.length} reused`);
      if (report.weak?.length > 0) parts.push(`${report.weak.length} weak`);
      if (parts.length === 0) return "All passwords passed security check ✓";
      return `Security issues found: ${parts.join(", ")} (${report.total} total)`;
    },
  });

  // ==========================================================================
  // Export Passwords
  // ==========================================================================

  server.tool({
    id: "export_passwords",
    summary: "Export all saved passwords",
    description:
      "Export all saved passwords from Chrome's password manager. May trigger OS authentication. Exported data is stored in OCRS — passwords NEVER appear in summaries.",
    category: "passwords",
    tags: ["passwords", "export", "backup", "csv"],
    input: {
      type: "object",
      properties: {
        format: {
          type: "string",
          description: "Export format: 'csv' (default) or 'json'",
          enum: ["csv", "json"],
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
      return pm.exportPasswords(format ?? "csv");
    },
    // SECURITY: Never include passwords in summary
    summarizer: (result: any) => {
      if (typeof result === "string") {
        const lines = result.split("\n").length;
        return `Exported ${lines} entries — stored in OCRS [passwords not shown]`;
      }
      return "Export triggered — check Chrome for OS authentication prompt";
    },
  });

  return { server, store, capAuthority };
}
