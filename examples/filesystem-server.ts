/**
 * Example AXON Tool Server — Filesystem Tools
 *
 * Demonstrates how to build an AXON server with:
 * - Compact tool manifests (~20 tokens/tool)
 * - On-demand schema loading
 * - Custom result summarizers
 * - Capability-scoped file access
 *
 * Compare: MCP's GitHub server uses ~55,000 tokens for 93 tools.
 * This AXON server with 5 tools uses ~100 tokens for manifests.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AxonServer, CapabilityAuthority, ResultStore } from "../sdk/src/index.js";

// ============================================================================
// Create the server
// ============================================================================

const server = new AxonServer({
  name: "axon-filesystem",
  version: "1.0.0",
});

// ============================================================================
// Register tools
// ============================================================================

server.tool({
  id: "read_file",
  summary: "Read file contents",
  description: "Read the full text contents of a file at the specified absolute path. Returns the file content as a UTF-8 string.",
  category: "filesystem",
  tags: ["read", "io", "file"],
  input: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute file path to read" },
      encoding: { type: "string", description: "File encoding (default: utf-8)" },
    },
    required: ["path"],
  },
  capabilities_required: ["resource:read"],
  annotations: { read_only: true, idempotent: true, estimated_latency_ms: 10, max_result_size_bytes: 10_000_000 },
  handler: async ({ path: filePath, encoding }) => {
    return fs.readFile(filePath, (encoding as BufferEncoding) ?? "utf-8");
  },
  summarizer: (content: string) => {
    const lines = content.split("\n").length;
    const bytes = Buffer.byteLength(content);
    const firstLine = content.split("\n")[0]?.trim() ?? "";
    return `${lines} lines (${bytes} bytes). First: "${firstLine.slice(0, 60)}"`;
  },
});

server.tool({
  id: "write_file",
  summary: "Write content to file",
  description: "Write text content to a file, creating it if it doesn't exist or overwriting if it does.",
  category: "filesystem",
  tags: ["write", "io", "file"],
  input: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute file path to write" },
      content: { type: "string", description: "Content to write to the file" },
    },
    required: ["path", "content"],
  },
  capabilities_required: ["resource:write"],
  annotations: { read_only: false, idempotent: true, estimated_latency_ms: 15, max_result_size_bytes: 100 },
  handler: async ({ path: filePath, content }) => {
    await fs.writeFile(filePath, content, "utf-8");
    return { written: true, bytes: Buffer.byteLength(content), path: filePath };
  },
  summarizer: (result) => `Wrote ${result.bytes} bytes to ${path.basename(result.path)}`,
});

server.tool({
  id: "list_dir",
  summary: "List directory contents",
  description: "List all files and directories in the specified path with metadata (size, type, modified time).",
  category: "filesystem",
  tags: ["list", "directory", "browse"],
  input: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute directory path" },
      recursive: { type: "boolean", description: "Recurse into subdirectories (default: false)" },
    },
    required: ["path"],
  },
  capabilities_required: ["resource:read"],
  annotations: { read_only: true, idempotent: true, estimated_latency_ms: 50, max_result_size_bytes: 1_000_000 },
  handler: async ({ path: dirPath, recursive }) => {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const results = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(dirPath, entry.name);
        try {
          const stat = await fs.stat(fullPath);
          return {
            name: entry.name,
            type: entry.isDirectory() ? "directory" : "file",
            size: stat.size,
            modified: stat.mtime.toISOString(),
          };
        } catch {
          return { name: entry.name, type: "unknown", size: 0, modified: "" };
        }
      })
    );
    return results;
  },
  summarizer: (results: any[]) => {
    const dirs = results.filter((r) => r.type === "directory").length;
    const files = results.length - dirs;
    return `${files} files, ${dirs} directories`;
  },
});

server.tool({
  id: "search_files",
  summary: "Search files by content pattern",
  description: "Search for files matching a text pattern (regex supported) within a directory tree.",
  category: "filesystem",
  tags: ["search", "grep", "find", "pattern"],
  input: {
    type: "object",
    properties: {
      directory: { type: "string", description: "Root directory to search in" },
      pattern: { type: "string", description: "Search pattern (regex)" },
      glob: { type: "string", description: "File name glob filter (e.g., '*.ts')" },
      max_results: { type: "number", description: "Maximum results to return (default: 50)" },
    },
    required: ["directory", "pattern"],
  },
  capabilities_required: ["resource:read"],
  annotations: { read_only: true, idempotent: true, estimated_latency_ms: 500, max_result_size_bytes: 5_000_000 },
  handler: async ({ directory, pattern, glob: globPattern, max_results }, context) => {
    const regex = new RegExp(pattern, "gi");
    const maxResults = max_results ?? 50;
    const results: any[] = [];

    async function searchDir(dir: string): Promise<void> {
      if (results.length >= maxResults || context.isCancelled()) return;

      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxResults || context.isCancelled()) return;

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await searchDir(fullPath);
        } else if (entry.isFile()) {
          if (globPattern && !minimatch(entry.name, globPattern)) continue;
          try {
            const content = await fs.readFile(fullPath, "utf-8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                results.push({
                  file: fullPath,
                  line: i + 1,
                  content: lines[i].trim(),
                });
                if (results.length >= maxResults) return;
              }
              regex.lastIndex = 0; // Reset regex state
            }
          } catch {
            // Skip unreadable files
          }
        }

        // Report progress
        context.reportProgress(Math.min(results.length / maxResults, 0.99));
      }
    }

    await searchDir(directory);
    return results;
  },
  summarizer: (results: any[]) => {
    const files = new Set(results.map((r: any) => r.file));
    return `${results.length} matches in ${files.size} files`;
  },
});

server.tool({
  id: "file_stat",
  summary: "Get file metadata",
  description: "Get detailed metadata about a file: size, permissions, timestamps, type.",
  category: "filesystem",
  tags: ["stat", "metadata", "info"],
  input: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute file path" },
    },
    required: ["path"],
  },
  capabilities_required: ["resource:read"],
  annotations: { read_only: true, idempotent: true, estimated_latency_ms: 5, max_result_size_bytes: 500 },
  handler: async ({ path: filePath }) => {
    const stat = await fs.stat(filePath);
    return {
      path: filePath,
      size: stat.size,
      type: stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file",
      permissions: stat.mode.toString(8),
      created: stat.birthtime.toISOString(),
      modified: stat.mtime.toISOString(),
      accessed: stat.atime.toISOString(),
    };
  },
  summarizer: (result) =>
    `${path.basename(result.path)}: ${result.type}, ${formatBytes(result.size)}, modified ${result.modified}`,
});

// ============================================================================
// Demo: Show context savings
// ============================================================================

console.log("=== AXON Filesystem Server ===\n");
console.log(`Tools registered: ${server.toolCount}`);
console.log(`Manifest tokens: ~${server.estimateManifestTokens()} tokens`);
console.log(`\nManifest (what goes into model context):`);
console.log(JSON.stringify(server.getManifest(), null, 2));

console.log(`\n--- Context Comparison ---`);
console.log(`MCP: 5 tools × ~600 tokens/tool = ~3,000 tokens in system prompt`);
console.log(`AXON: 5 tools × ~20 tokens/tool = ~${server.estimateManifestTokens()} tokens in system prompt`);
console.log(`Savings: ~${Math.round((1 - server.estimateManifestTokens() / 3000) * 100)}%\n`);

// Demo: Schema on demand
console.log(`Schema for 'read_file' (fetched on demand, NOT in context):`);
console.log(JSON.stringify(server.getSchema("read_file"), null, 2));

// Demo: OCRS
console.log(`\n--- Out-of-Context Result Store Demo ---`);
const store = new ResultStore({ max_total_result_tokens: 2000 });

// Simulate a large search result
const fakeSearchResults = Array.from({ length: 47 }, (_, i) => ({
  file: `/project/src/file${i}.ts`,
  line: Math.floor(Math.random() * 200),
  content: `const auth${i} = new AuthProvider(config${i});`,
}));

const entry = store.store("search_files", { pattern: "auth" }, fakeSearchResults);
console.log(`\nFull result: ${entry.size_tokens_estimate} tokens`);
console.log(`Summary for context: "${store.getSummaryForContext(entry.ref)}"`);
console.log(`Context tokens used: ${store.stats().context_tokens_used}`);
console.log(`Context budget remaining: ${store.stats().context_budget_remaining}`);

// Demo: Selective query (what the model would do to "zoom in")
const filtered = store.query(entry.ref, {
  filter: { file: "/project/src/file0.ts" },
  select: ["line", "content"],
});
console.log(`\nFiltered query result (1 file): ${JSON.stringify(filtered)}`);
console.log(`Tokens for filtered result: ~${Math.ceil(JSON.stringify(filtered).length / 4)}`);
console.log(`\nSavings: ~${entry.size_tokens_estimate} tokens → ~${Math.ceil(JSON.stringify(filtered).length / 4)} tokens = ${Math.round((1 - JSON.stringify(filtered).length / 4 / entry.size_tokens_estimate) * 100)}% reduction`);

// ============================================================================
// Capability Demo
// ============================================================================

console.log(`\n--- Capability-Based Security Demo ---`);

const keyBytes = Buffer.from("demo-private-key-32-bytes-long!!", "utf-8");
const pubBytes = Buffer.from("demo-public-key-32-bytes-long!!!", "utf-8");
const authority = new CapabilityAuthority("demo-authority", keyBytes, pubBytes);

// Issue a read-only capability scoped to /project/src
const readCap = authority.issue("session-1", "resource:read", "/project/src/**", {
  max_calls: 100,
  ttl_seconds: 300,
});
console.log(`\nIssued capability: type=${readCap.type}, scope=${readCap.scope}`);
console.log(`Valid: ${authority.validate(readCap) ?? "yes"}`);
console.log(`Scope check /project/src/main.ts: ${authority.checkScope(readCap, "/project/src/main.ts")}`);
console.log(`Scope check /etc/passwd: ${authority.checkScope(readCap, "/etc/passwd")}`);

// Attenuate to a single file
const narrowCap = authority.attenuate(readCap, "/project/src/main.ts");
console.log(`\nAttenuated: scope=${narrowCap?.scope}`);
console.log(`Scope check /project/src/main.ts: ${narrowCap && authority.checkScope(narrowCap, "/project/src/main.ts")}`);
console.log(`Scope check /project/src/other.ts: ${narrowCap && authority.checkScope(narrowCap, "/project/src/other.ts")}`);

// ============================================================================
// Helpers
// ============================================================================

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function minimatch(name: string, pattern: string): boolean {
  // Simplified glob: *.ext
  if (pattern.startsWith("*.")) {
    return name.endsWith(pattern.slice(1));
  }
  return name === pattern;
}
