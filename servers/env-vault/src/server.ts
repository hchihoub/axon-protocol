/**
 * AXON ENV/Secrets Vault Server — Tool Definitions
 *
 * 7 .env management tools registered with AXON's 3-tier discovery:
 *   Tier 1: Compact manifests (~20 tokens/tool) — always in context
 *   Tier 2: Full schemas — fetched on demand when model calls a tool
 *
 * Results go through OCRS:
 *   - Env file scans → stored in OCRS, counts in context
 *   - Variable values → stored in OCRS ONLY, NEVER in summaries
 *   - Secret detections → stored in OCRS, severity counts in context
 *
 * SECURITY: Values are MASKED by default in all operations.
 * Only get_env_value returns actual values, stored in OCRS only.
 * Summarizers NEVER include secret values.
 *
 * Capabilities enforce access:
 *   - "resource:read" for scanning, reading, detecting, comparing
 *   - "resource:write" for set and delete operations
 */

import { AxonServer, ResultStore, CapabilityAuthority } from "@axon-protocol/sdk";
import { EnvVaultManager } from "./env-vault-manager.js";

export interface EnvVaultServerConfig {
  /** Restrict to read-only operations */
  readOnly?: boolean;
}

export function createEnvVaultServer(
  manager: EnvVaultManager,
  config?: EnvVaultServerConfig,
): {
  server: AxonServer;
  store: ResultStore;
  capAuthority: CapabilityAuthority;
} {
  const server = new AxonServer({ name: "axon-env-vault", version: "0.1.0" });
  const store = new ResultStore({ max_summary_tokens: 300, max_total_result_tokens: 6000 });

  const key = Buffer.alloc(32);
  Buffer.from(Date.now().toString(16).padStart(32, "0"), "hex").copy(key);
  const capAuthority = new CapabilityAuthority("axon-env-vault", key, key);

  // ==========================================================================
  // Scan Env Files
  // ==========================================================================

  server.tool({
    id: "scan_env_files",
    summary: "Scan a directory tree for all .env files",
    description:
      "Recursively scan a directory for .env files (.env, .env.local, .env.production, etc.). Returns file paths, variable counts, and sizes. Skips node_modules, .git, dist, and other common non-project directories.",
    category: "env-vault",
    tags: ["env", "scan", "find", "discover"],
    input: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description: "Root directory to scan (default: AXON_VAULT_ROOT or cwd)",
        },
      },
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 5000,
      max_result_size_bytes: 100_000,
    },
    handler: async ({ directory }: any) => {
      return manager.scanEnvFiles(directory);
    },
    summarizer: (files: any[]) => {
      if (!Array.isArray(files)) return "No .env files found";
      const count = files.length;
      const totalVars = files.reduce((sum: number, f: any) => sum + (f.variableCount || 0), 0);
      const sample = files
        .slice(0, 5)
        .map((f: any) => f.relativePath)
        .join(", ");
      return `${count} .env file(s) with ${totalVars} total variables${count > 0 ? `: ${sample}${count > 5 ? "..." : ""}` : ""}`;
    },
  });

  // ==========================================================================
  // Read Env
  // ==========================================================================

  server.tool({
    id: "read_env",
    summary: "Read an .env file (values masked by default)",
    description:
      "Read and parse an .env file. By default, values are MASKED (shown as ****) for security. Only shows key names and masked values. Use get_env_value to retrieve a specific value.",
    category: "env-vault",
    tags: ["env", "read", "parse", "view"],
    input: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Path to the .env file",
        },
      },
      required: ["file"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 500,
      max_result_size_bytes: 50_000,
    },
    handler: async ({ file }: any) => {
      return manager.readEnv(file, false);
    },
    // SECURITY: Never include values in summary
    summarizer: (result: any) => {
      const count = result.count ?? 0;
      const sample = (result.variables ?? [])
        .slice(0, 5)
        .map((v: any) => v.key)
        .join(", ");
      return `${count} variable(s) in ${result.path}${count > 0 ? `: ${sample}${count > 5 ? "..." : ""}` : ""} [values masked]`;
    },
  });

  // ==========================================================================
  // Get Env Value
  // ==========================================================================

  server.tool({
    id: "get_env_value",
    summary: "Get a specific env variable value from a file",
    description:
      "Retrieve the actual value of a specific environment variable from an .env file. This is the ONLY tool that returns unmasked values. The value is stored in OCRS and NEVER appears in summaries.",
    category: "env-vault",
    tags: ["env", "get", "value", "retrieve"],
    input: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Path to the .env file",
        },
        key: {
          type: "string",
          description: "Variable name to retrieve",
        },
      },
      required: ["file", "key"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 500,
      max_result_size_bytes: 5000,
    },
    handler: async ({ file, key }: any) => {
      return manager.getEnvValue(file, key);
    },
    // SECURITY: Never include value in summary
    summarizer: (result: any) => {
      return `Retrieved value for "${result.key}" from ${result.path} — stored in OCRS [value not shown]`;
    },
  });

  // ==========================================================================
  // Set Env Value
  // ==========================================================================

  server.tool({
    id: "set_env_value",
    summary: "Set/update a variable in an .env file",
    description:
      "Set or update an environment variable in an .env file. Creates the variable if it doesn't exist, updates it if it does. Creates the file if it doesn't exist.",
    category: "env-vault",
    tags: ["env", "set", "update", "write"],
    input: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Path to the .env file",
        },
        key: {
          type: "string",
          description: "Variable name",
        },
        value: {
          type: "string",
          description: "Variable value",
        },
      },
      required: ["file", "key", "value"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: true,
      estimated_latency_ms: 500,
      max_result_size_bytes: 500,
    },
    handler: async ({ file, key, value }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return manager.setEnvValue(file, key, value);
    },
    // SECURITY: Never include value in summary
    summarizer: (result: any) => {
      return `${result.action === "updated" ? "Updated" : "Created"} "${result.key}" in ${result.path}`;
    },
  });

  // ==========================================================================
  // Delete Env Value
  // ==========================================================================

  server.tool({
    id: "delete_env_value",
    summary: "Remove a variable from an .env file",
    description:
      "Remove an environment variable from an .env file. The variable's line is deleted entirely. Fails if the variable doesn't exist.",
    category: "env-vault",
    tags: ["env", "delete", "remove"],
    input: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Path to the .env file",
        },
        key: {
          type: "string",
          description: "Variable name to remove",
        },
      },
      required: ["file", "key"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: true,
      estimated_latency_ms: 500,
      max_result_size_bytes: 500,
    },
    handler: async ({ file, key }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return manager.deleteEnvValue(file, key);
    },
    summarizer: (result: any) => {
      return result.deleted
        ? `Deleted "${result.key}" from ${result.path}`
        : `Failed to delete "${result.key}" from ${result.path}`;
    },
  });

  // ==========================================================================
  // Detect Secrets
  // ==========================================================================

  server.tool({
    id: "detect_secrets",
    summary: "Scan files for potential secrets (API keys, tokens, passwords)",
    description:
      "Scan .env files for potential leaked secrets using pattern matching. Detects AWS keys, GitHub tokens, Stripe keys, Google API keys, Slack tokens, JWTs, database URLs, and other common secret formats. Reports severity (high/medium/low) for each finding.",
    category: "env-vault",
    tags: ["env", "secrets", "security", "scan", "detect", "audit"],
    input: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description: "Directory to scan (default: AXON_VAULT_ROOT or cwd)",
        },
      },
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 5000,
      max_result_size_bytes: 100_000,
    },
    handler: async ({ directory }: any) => {
      return manager.detectSecrets(directory);
    },
    // SECURITY: Never include actual secret values — only counts and patterns
    summarizer: (matches: any[]) => {
      if (!Array.isArray(matches) || matches.length === 0) {
        return "No potential secrets detected";
      }
      const high = matches.filter((m: any) => m.severity === "high").length;
      const medium = matches.filter((m: any) => m.severity === "medium").length;
      const low = matches.filter((m: any) => m.severity === "low").length;
      const parts: string[] = [];
      if (high > 0) parts.push(`${high} high`);
      if (medium > 0) parts.push(`${medium} medium`);
      if (low > 0) parts.push(`${low} low`);
      return `${matches.length} potential secret(s) detected: ${parts.join(", ")} severity`;
    },
  });

  // ==========================================================================
  // Compare Envs
  // ==========================================================================

  server.tool({
    id: "compare_envs",
    summary: "Compare two .env files (show missing/different keys)",
    description:
      "Compare two .env files side by side. Shows keys that are only in one file, keys with different values (values are masked), and keys that are the same. Useful for ensuring environment parity between development, staging, and production.",
    category: "env-vault",
    tags: ["env", "compare", "diff", "audit"],
    input: {
      type: "object",
      properties: {
        fileA: {
          type: "string",
          description: "Path to the first .env file",
        },
        fileB: {
          type: "string",
          description: "Path to the second .env file",
        },
      },
      required: ["fileA", "fileB"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 500,
      max_result_size_bytes: 50_000,
    },
    handler: async ({ fileA, fileB }: any) => {
      return manager.compareEnvs(fileA, fileB);
    },
    // SECURITY: Never include values in summary — only key-level diff info
    summarizer: (result: any) => {
      const parts: string[] = [];
      if (result.onlyInA?.length > 0) parts.push(`${result.onlyInA.length} only in A`);
      if (result.onlyInB?.length > 0) parts.push(`${result.onlyInB.length} only in B`);
      if (result.different?.length > 0) parts.push(`${result.different.length} different`);
      if (result.same?.length > 0) parts.push(`${result.same.length} same`);
      if (parts.length === 0) return "Files are identical";
      return `Comparison: ${parts.join(", ")} [values masked]`;
    },
  });

  return { server, store, capAuthority };
}
