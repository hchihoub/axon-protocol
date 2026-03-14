/**
 * AXON File System Server — Tool Definitions
 *
 * 10 file system tools registered with AXON's 3-tier discovery:
 *   Tier 1: Compact manifests (~20 tokens/tool) — always in context
 *   Tier 2: Full schemas — fetched on demand when model calls a tool
 *
 * Results go through OCRS:
 *   - File contents → stored in OCRS, summary shows preview
 *   - Search results → stored in OCRS, counts in context
 *   - Binary files → base64 stored in OCRS, summary shows size
 *
 * SECURITY: All paths validated against rootDir to prevent traversal.
 *
 * Capabilities enforce access:
 *   - "resource:read" for listing, reading, searching
 *   - "resource:write" for write, move, copy, delete, create
 */

import { AxonServer, ResultStore, CapabilityAuthority } from "@axon-protocol/sdk";
import { FileSystemManager } from "./filesystem-manager.js";

export interface FileSystemServerConfig {
  /** Restrict to read-only operations */
  readOnly?: boolean;
}

export function createFileSystemServer(
  fsm: FileSystemManager,
  config?: FileSystemServerConfig,
): {
  server: AxonServer;
  store: ResultStore;
  capAuthority: CapabilityAuthority;
} {
  const server = new AxonServer({ name: "axon-filesystem", version: "0.1.0" });
  const store = new ResultStore({ max_summary_tokens: 300, max_total_result_tokens: 6000 });

  const key = Buffer.alloc(32);
  Buffer.from(Date.now().toString(16).padStart(32, "0"), "hex").copy(key);
  const capAuthority = new CapabilityAuthority("axon-filesystem", key, key);

  // ==========================================================================
  // List Directory
  // ==========================================================================

  server.tool({
    id: "list_directory",
    summary: "List files and directories with metadata",
    description:
      "List files and directories at the specified path with metadata including size, modified date, and type. Paths are relative to the configured root directory.",
    category: "filesystem",
    tags: ["files", "list", "directory", "browse"],
    input: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path to list (relative to root). Defaults to root directory.",
        },
      },
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 500,
      max_result_size_bytes: 200_000,
    },
    handler: async ({ path: dirPath }: any) => {
      return fsm.listDirectory(dirPath ?? ".");
    },
    summarizer: (entries: any[]) => {
      if (!Array.isArray(entries)) return "Empty directory";
      const files = entries.filter((e: any) => e.type === "file").length;
      const dirs = entries.filter((e: any) => e.type === "directory").length;
      const sample = entries
        .slice(0, 5)
        .map((e: any) => e.name)
        .join(", ");
      return `${entries.length} entries (${files} files, ${dirs} dirs): ${sample}${entries.length > 5 ? "..." : ""}`;
    },
  });

  // ==========================================================================
  // Read File
  // ==========================================================================

  server.tool({
    id: "read_file",
    summary: "Read file contents (text or binary as base64)",
    description:
      "Read the contents of a file. Text files are returned as UTF-8 strings. Binary files are returned as base64-encoded strings. The full content is stored in OCRS; the summary shows a preview.",
    category: "filesystem",
    tags: ["files", "read", "content", "text"],
    input: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path to read (relative to root)",
        },
        encoding: {
          type: "string",
          description: "Force encoding: 'utf-8' or 'base64'. Auto-detected if not set.",
          enum: ["utf-8", "base64"],
        },
      },
      required: ["path"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 500,
      max_result_size_bytes: 5_000_000,
    },
    handler: async ({ path: filePath, encoding }: any) => {
      return fsm.readFile(filePath, encoding);
    },
    summarizer: (result: any) => {
      if (result.encoding === "base64") {
        return `Binary file (${result.size} bytes) — stored in OCRS as base64`;
      }
      const preview = result.content.substring(0, 100);
      const truncated = result.content.length > 100 ? "..." : "";
      return `File (${result.size} bytes): ${preview}${truncated}`;
    },
  });

  // ==========================================================================
  // Write File
  // ==========================================================================

  server.tool({
    id: "write_file",
    summary: "Write content to a file",
    description:
      "Write text or binary content to a file. Creates parent directories if needed. Use encoding 'base64' for binary data.",
    category: "filesystem",
    tags: ["files", "write", "create", "save"],
    input: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path to write (relative to root)",
        },
        content: {
          type: "string",
          description: "File content to write",
        },
        encoding: {
          type: "string",
          description: "Content encoding: 'utf-8' (default) or 'base64' for binary",
          enum: ["utf-8", "base64"],
        },
      },
      required: ["path", "content"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: true,
      estimated_latency_ms: 500,
      max_result_size_bytes: 500,
    },
    handler: async ({ path: filePath, content, encoding }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return fsm.writeFile(filePath, content, encoding);
    },
    summarizer: (result: any) => {
      return `Written ${result.size} bytes to ${result.path}`;
    },
  });

  // ==========================================================================
  // Create Directory
  // ==========================================================================

  server.tool({
    id: "create_directory",
    summary: "Create a directory (recursive)",
    description:
      "Create a new directory. Intermediate directories are created automatically if they don't exist.",
    category: "filesystem",
    tags: ["directory", "create", "mkdir"],
    input: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path to create (relative to root)",
        },
      },
      required: ["path"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: true,
      estimated_latency_ms: 200,
      max_result_size_bytes: 200,
    },
    handler: async ({ path: dirPath }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return fsm.createDirectory(dirPath);
    },
    summarizer: (result: any) => {
      return `Created directory: ${result.path}`;
    },
  });

  // ==========================================================================
  // Move / Rename
  // ==========================================================================

  server.tool({
    id: "move",
    summary: "Move or rename a file or directory",
    description:
      "Move or rename a file or directory. Creates destination parent directories if needed. Both source and destination must be within the root directory.",
    category: "filesystem",
    tags: ["files", "move", "rename"],
    input: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Source path (relative to root)",
        },
        destination: {
          type: "string",
          description: "Destination path (relative to root)",
        },
      },
      required: ["source", "destination"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: false,
      estimated_latency_ms: 500,
      max_result_size_bytes: 500,
    },
    handler: async ({ source, destination }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return fsm.move(source, destination);
    },
    summarizer: (result: any) => {
      return `Moved ${result.source} → ${result.destination}`;
    },
  });

  // ==========================================================================
  // Copy
  // ==========================================================================

  server.tool({
    id: "copy",
    summary: "Copy a file or directory",
    description:
      "Copy a file or directory to a new location. Directories are copied recursively. Creates destination parent directories if needed.",
    category: "filesystem",
    tags: ["files", "copy", "duplicate"],
    input: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Source path (relative to root)",
        },
        destination: {
          type: "string",
          description: "Destination path (relative to root)",
        },
      },
      required: ["source", "destination"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: true,
      estimated_latency_ms: 2000,
      max_result_size_bytes: 500,
    },
    handler: async ({ source, destination }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return fsm.copy(source, destination);
    },
    summarizer: (result: any) => {
      return `Copied ${result.source} → ${result.destination}`;
    },
  });

  // ==========================================================================
  // Delete
  // ==========================================================================

  server.tool({
    id: "delete",
    summary: "Delete a file or directory",
    description:
      "Delete a file or directory. Directories are deleted recursively. This action is permanent and cannot be undone.",
    category: "filesystem",
    tags: ["files", "delete", "remove"],
    input: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to delete (relative to root)",
        },
      },
      required: ["path"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: true,
      estimated_latency_ms: 500,
      max_result_size_bytes: 200,
    },
    handler: async ({ path: targetPath }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return fsm.delete(targetPath);
    },
    summarizer: (result: any) => {
      return `Deleted ${result.type}: ${result.path}`;
    },
  });

  // ==========================================================================
  // Search Files
  // ==========================================================================

  server.tool({
    id: "search_files",
    summary: "Search files by glob pattern",
    description:
      "Search for files and directories matching a glob pattern. Supports * (any chars except /) and ** (any chars including /). Common directories like node_modules and .git are excluded.",
    category: "filesystem",
    tags: ["files", "search", "find", "glob"],
    input: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern to match (e.g., '*.ts', '**/*.json', 'src/**/*.ts')",
        },
        path: {
          type: "string",
          description: "Directory to search in (relative to root). Defaults to root.",
        },
      },
      required: ["pattern"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 5000,
      max_result_size_bytes: 500_000,
    },
    handler: async ({ pattern, path: searchPath }: any) => {
      return fsm.searchFiles(pattern, searchPath);
    },
    summarizer: (results: any[]) => {
      if (!Array.isArray(results)) return "No results";
      const files = results.filter((r: any) => r.type === "file").length;
      const dirs = results.filter((r: any) => r.type === "directory").length;
      const sample = results
        .slice(0, 5)
        .map((r: any) => r.path)
        .join(", ");
      return `${results.length} matches (${files} files, ${dirs} dirs): ${sample}${results.length > 5 ? "..." : ""}`;
    },
  });

  // ==========================================================================
  // Get File Info
  // ==========================================================================

  server.tool({
    id: "get_file_info",
    summary: "Get detailed file or directory metadata",
    description:
      "Get detailed metadata for a file or directory: size, permissions, timestamps (created, modified, accessed), type, and access flags.",
    category: "filesystem",
    tags: ["files", "info", "metadata", "stat"],
    input: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File or directory path (relative to root)",
        },
      },
      required: ["path"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 200,
      max_result_size_bytes: 1000,
    },
    handler: async ({ path: filePath }: any) => {
      return fsm.getFileInfo(filePath);
    },
    summarizer: (info: any) => {
      return `${info.type}: ${info.name} (${info.size} bytes, ${info.permissions}, modified: ${info.modified})`;
    },
  });

  // ==========================================================================
  // Find Text (grep-like)
  // ==========================================================================

  server.tool({
    id: "find_text",
    summary: "Search for text content within files (grep)",
    description:
      "Search for text content within files, similar to grep. Returns matching lines with file paths and line numbers. Binary files are automatically skipped.",
    category: "filesystem",
    tags: ["files", "search", "grep", "text", "content"],
    input: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Text pattern to search for",
        },
        path: {
          type: "string",
          description: "Directory to search in (relative to root). Defaults to root.",
        },
        case_sensitive: {
          type: "boolean",
          description: "Whether the search is case-sensitive (default: false)",
        },
        max_results: {
          type: "number",
          description: "Maximum number of matches to return (default: 500)",
        },
        file_pattern: {
          type: "string",
          description: "Glob pattern to filter which files to search (e.g., '*.ts')",
        },
      },
      required: ["pattern"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 10000,
      max_result_size_bytes: 1_000_000,
    },
    handler: async ({ pattern, query, text, path: searchPath, directory, case_sensitive, max_results, file_pattern }: any) => {
      const searchText = pattern ?? query ?? text;
      const searchDir = searchPath ?? directory;
      return fsm.findText(searchText, searchDir, {
        caseSensitive: case_sensitive,
        maxResults: max_results,
        filePattern: file_pattern,
      });
    },
    summarizer: (result: any) => {
      return `"${result.pattern}": ${result.matches.length} matches in ${result.filesMatched} files (${result.filesSearched} searched)`;
    },
  });

  return { server, store, capAuthority };
}
