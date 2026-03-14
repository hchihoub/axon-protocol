/**
 * MCP Server Simulator — Generates realistic MCP tool servers for benchmarking.
 *
 * Simulates servers at different scales:
 * - Small: 5 tools (simple utility server)
 * - Medium: 25 tools (typical integration server)
 * - Large: 93 tools (GitHub MCP server scale)
 * - XL: 200 tools (multi-server aggregation)
 *
 * Each tool has realistic schemas, descriptions, and result generators.
 */

import {
  MCPToolDefinition,
  MCPToolResult,
  MCPSimulatedServer,
  MCPPropertySchema,
} from "./mcp-types.js";

// ============================================================================
// Tool Templates — Realistic MCP tool definitions
// ============================================================================

interface ToolTemplate {
  namePattern: string;
  descriptionPattern: string;
  properties: Record<string, MCPPropertySchema>;
  required: string[];
  resultGenerator: (args: Record<string, any>) => any;
  resultSize: "small" | "medium" | "large"; // Controls output volume
}

const TOOL_TEMPLATES: ToolTemplate[] = [
  // Filesystem tools
  {
    namePattern: "read_file_{n}",
    descriptionPattern: "Read the contents of a file at the specified path. Returns the full text content as a UTF-8 encoded string. Supports all text file formats including source code, configuration files, and documentation.",
    properties: {
      path: { type: "string", description: "The absolute path to the file to read. Must be a valid file path on the filesystem." },
      encoding: { type: "string", description: "The character encoding to use when reading the file. Defaults to utf-8.", enum: ["utf-8", "ascii", "latin1", "base64"] },
      offset: { type: "number", description: "The line number to start reading from. Only provide if the file is too large to read at once." },
      limit: { type: "number", description: "The number of lines to read. Only provide if the file is too large to read at once." },
    },
    required: ["path"],
    resultGenerator: (args) => {
      const lines = Array.from({ length: 100 }, (_, i) =>
        `  const value${i} = process(input${i}, { threshold: ${Math.random().toFixed(4)}, enabled: true });`
      ).join("\n");
      return lines;
    },
    resultSize: "large",
  },
  {
    namePattern: "write_file_{n}",
    descriptionPattern: "Write content to a file at the specified path. Creates the file if it doesn't exist, or overwrites it if it does. Ensures the parent directory exists before writing.",
    properties: {
      path: { type: "string", description: "The absolute path to the file to write" },
      content: { type: "string", description: "The content to write to the file" },
      create_dirs: { type: "boolean", description: "Whether to create parent directories if they don't exist" },
    },
    required: ["path", "content"],
    resultGenerator: () => ({ success: true, bytes_written: 1024 }),
    resultSize: "small",
  },
  {
    namePattern: "list_directory_{n}",
    descriptionPattern: "List all files and directories in the specified directory path. Returns detailed metadata for each entry including file size, modification time, permissions, and file type.",
    properties: {
      path: { type: "string", description: "The absolute path to the directory to list" },
      recursive: { type: "boolean", description: "Whether to recursively list all subdirectories and their contents" },
      include_hidden: { type: "boolean", description: "Whether to include hidden files (those starting with a dot)" },
      pattern: { type: "string", description: "Optional glob pattern to filter results (e.g., '*.ts', '**/*.test.js')" },
    },
    required: ["path"],
    resultGenerator: () =>
      Array.from({ length: 50 }, (_, i) => ({
        name: `file_${i}.ts`,
        path: `/project/src/components/file_${i}.ts`,
        type: i % 5 === 0 ? "directory" : "file",
        size: Math.floor(Math.random() * 50000),
        modified: new Date(Date.now() - Math.random() * 86400000 * 30).toISOString(),
        permissions: "rw-r--r--",
      })),
    resultSize: "large",
  },
  // Search tools
  {
    namePattern: "search_code_{n}",
    descriptionPattern: "Search for text patterns across files in the codebase using regular expressions. Returns matching lines with file paths, line numbers, and surrounding context. Supports case-insensitive search and glob-based file filtering.",
    properties: {
      query: { type: "string", description: "The search query or regular expression pattern to match against file contents" },
      path: { type: "string", description: "The root directory to search in. Defaults to the project root." },
      include: { type: "string", description: "Glob pattern for files to include in the search (e.g., '*.ts', '*.{js,jsx}')" },
      exclude: { type: "string", description: "Glob pattern for files to exclude from the search" },
      case_sensitive: { type: "boolean", description: "Whether the search should be case-sensitive. Defaults to false." },
      max_results: { type: "number", description: "Maximum number of results to return. Defaults to 100." },
      context_lines: { type: "number", description: "Number of lines of context to include before and after each match" },
    },
    required: ["query"],
    resultGenerator: (args) =>
      Array.from({ length: 47 }, (_, i) => ({
        file: `/project/src/modules/module${i % 12}/handler.ts`,
        line: Math.floor(Math.random() * 500) + 1,
        column: Math.floor(Math.random() * 80) + 1,
        content: `  const ${args.query || "result"}${i} = await fetchData(endpoint${i}, { retries: 3, timeout: 5000 });`,
        context_before: `  // Process data from API endpoint ${i}`,
        context_after: `  logger.info(\`Processed ${args.query || "result"}${i} successfully\`);`,
      })),
    resultSize: "large",
  },
  // Git tools
  {
    namePattern: "git_status_{n}",
    descriptionPattern: "Get the current status of the git repository including staged changes, unstaged modifications, untracked files, and branch information. Shows a summary of all pending changes.",
    properties: {
      path: { type: "string", description: "Path to the git repository. Defaults to the current working directory." },
      short: { type: "boolean", description: "Whether to use short format output" },
    },
    required: [],
    resultGenerator: () => ({
      branch: "feature/auth-improvements",
      ahead: 3,
      behind: 0,
      staged: ["src/auth.ts", "src/middleware.ts"],
      modified: ["src/config.ts", "tests/auth.test.ts"],
      untracked: ["src/new-feature.ts"],
    }),
    resultSize: "medium",
  },
  {
    namePattern: "git_diff_{n}",
    descriptionPattern: "Show the diff of changes between commits, branches, or the working tree. Returns unified diff format with context lines. Supports filtering by path and comparing specific refs.",
    properties: {
      ref: { type: "string", description: "Git ref to diff against (commit hash, branch name, HEAD~N)" },
      path: { type: "string", description: "Only show diff for this specific file or directory" },
      staged: { type: "boolean", description: "Show only staged changes (equivalent to git diff --staged)" },
      context: { type: "number", description: "Number of context lines to show around changes" },
    },
    required: [],
    resultGenerator: () =>
      Array.from({ length: 30 }, (_, i) =>
        `@@ -${i * 10 + 1},7 +${i * 10 + 1},9 @@ function process${i}(data) {\n-  const old = legacy(data);\n+  const result = modernized(data, { optimize: true });\n+  metrics.record('process${i}', result.duration);`
      ).join("\n"),
    resultSize: "large",
  },
  // GitHub API tools
  {
    namePattern: "create_issue_{n}",
    descriptionPattern: "Create a new issue in the specified GitHub repository. Supports setting title, body, labels, assignees, and milestone. Returns the created issue with its number and URL.",
    properties: {
      owner: { type: "string", description: "The owner of the repository (user or organization)" },
      repo: { type: "string", description: "The name of the repository" },
      title: { type: "string", description: "The title of the issue" },
      body: { type: "string", description: "The body content of the issue in Markdown format" },
      labels: { type: "string", description: "Comma-separated list of label names to add to the issue" },
      assignees: { type: "string", description: "Comma-separated list of GitHub usernames to assign" },
    },
    required: ["owner", "repo", "title"],
    resultGenerator: () => ({
      number: Math.floor(Math.random() * 1000),
      url: "https://github.com/owner/repo/issues/42",
      state: "open",
      created_at: new Date().toISOString(),
    }),
    resultSize: "small",
  },
  {
    namePattern: "list_pull_requests_{n}",
    descriptionPattern: "List pull requests in a GitHub repository with filtering by state, head/base branch, sort order, and pagination. Returns detailed PR information including review status and CI check results.",
    properties: {
      owner: { type: "string", description: "The owner of the repository" },
      repo: { type: "string", description: "The name of the repository" },
      state: { type: "string", description: "Filter by PR state", enum: ["open", "closed", "all"] },
      sort: { type: "string", description: "What to sort results by", enum: ["created", "updated", "popularity", "long-running"] },
      direction: { type: "string", description: "Sort direction", enum: ["asc", "desc"] },
      per_page: { type: "number", description: "Number of results per page (max 100)" },
      page: { type: "number", description: "Page number for pagination" },
    },
    required: ["owner", "repo"],
    resultGenerator: () =>
      Array.from({ length: 25 }, (_, i) => ({
        number: 100 + i,
        title: `PR #${100 + i}: Implement feature ${i} with comprehensive test coverage`,
        state: i < 20 ? "open" : "closed",
        user: { login: `developer${i}`, avatar_url: `https://avatars.githubusercontent.com/u/${1000 + i}` },
        created_at: new Date(Date.now() - i * 86400000).toISOString(),
        updated_at: new Date(Date.now() - i * 43200000).toISOString(),
        labels: [{ name: i % 2 === 0 ? "enhancement" : "bug" }],
        review_status: i % 3 === 0 ? "approved" : "pending",
        checks: { status: i % 4 === 0 ? "failure" : "success", total: 12, passed: i % 4 === 0 ? 10 : 12 },
      })),
    resultSize: "large",
  },
  // Database tools
  {
    namePattern: "query_database_{n}",
    descriptionPattern: "Execute a SQL query against the connected database and return the results as a structured array of rows. Supports parameterized queries to prevent SQL injection.",
    properties: {
      query: { type: "string", description: "The SQL query to execute. Use $1, $2 etc. for parameterized values." },
      params: { type: "string", description: "JSON array of parameter values for the parameterized query" },
      database: { type: "string", description: "Name of the database to query" },
      timeout: { type: "number", description: "Query timeout in milliseconds" },
    },
    required: ["query"],
    resultGenerator: () =>
      Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        name: `Record ${i + 1}`,
        email: `user${i + 1}@example.com`,
        created_at: new Date(Date.now() - i * 86400000).toISOString(),
        status: i % 3 === 0 ? "active" : i % 3 === 1 ? "pending" : "inactive",
        metadata: { score: Math.random() * 100, tier: i % 4 === 0 ? "premium" : "standard" },
      })),
    resultSize: "large",
  },
  // Shell execution tools
  {
    namePattern: "run_command_{n}",
    descriptionPattern: "Execute a shell command in the specified working directory and return the stdout, stderr, and exit code. Supports timeout configuration and environment variable overrides.",
    properties: {
      command: { type: "string", description: "The shell command to execute" },
      cwd: { type: "string", description: "Working directory for command execution" },
      timeout: { type: "number", description: "Timeout in milliseconds before killing the process" },
      env: { type: "string", description: "JSON object of environment variables to set" },
    },
    required: ["command"],
    resultGenerator: () => ({
      stdout: "Build completed successfully.\n12 modules compiled.\n0 errors, 2 warnings.\n",
      stderr: "Warning: unused variable 'temp' in module.ts:42\nWarning: deprecated API usage in legacy.ts:15\n",
      exit_code: 0,
      duration_ms: 2340,
    }),
    resultSize: "medium",
  },
];

// ============================================================================
// Server Generator
// ============================================================================

export function generateMCPServer(
  name: string,
  toolCount: number
): MCPSimulatedServer {
  const tools: MCPToolDefinition[] = [];
  const templateCount = TOOL_TEMPLATES.length;

  for (let i = 0; i < toolCount; i++) {
    const template = TOOL_TEMPLATES[i % templateCount];
    const suffix = Math.floor(i / templateCount);
    const toolName = template.namePattern.replace("{n}", String(suffix || "").replace(/^0$/, ""));

    tools.push({
      name: toolName.replace(/_$/, ""),
      description: template.descriptionPattern,
      inputSchema: {
        type: "object",
        properties: template.properties,
        required: template.required,
      },
      annotations: {
        readOnlyHint: template.resultSize === "large" || template.namePattern.includes("read") || template.namePattern.includes("list") || template.namePattern.includes("search"),
        idempotentHint: template.namePattern.includes("read") || template.namePattern.includes("list"),
      },
    });
  }

  const toolHandlers = new Map<string, ToolTemplate>();
  tools.forEach((t, i) => {
    toolHandlers.set(t.name, TOOL_TEMPLATES[i % templateCount]);
  });

  return {
    name,
    version: "1.0.0",
    tools,
    handleCall: (name: string, args: Record<string, any>): MCPToolResult => {
      const template = toolHandlers.get(name);
      if (!template) {
        return {
          content: [{ type: "text", text: `Tool not found: ${name}` }],
          isError: true,
        };
      }
      const data = template.resultGenerator(args);
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        isError: false,
      };
    },
  };
}

/**
 * Generate MCP servers at standard benchmark scales.
 */
export function generateBenchmarkServers(): Record<string, MCPSimulatedServer> {
  return {
    small: generateMCPServer("small-server", 5),
    medium: generateMCPServer("medium-server", 25),
    large: generateMCPServer("github-scale", 93),
    xl: generateMCPServer("multi-server-aggregation", 200),
  };
}

/**
 * Estimate what MCP would consume in context tokens for a server's tools.
 */
export function estimateMCPContextTokens(server: MCPSimulatedServer): number {
  const fullDefinitions = JSON.stringify(server.tools);
  return Math.ceil(fullDefinitions.length / 4);
}

/**
 * Get the raw byte size of MCP tool definitions (JSON-RPC tools/list response).
 */
export function mcpToolsListResponseSize(server: MCPSimulatedServer): number {
  const response = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { tools: server.tools },
  });
  return Buffer.byteLength(response);
}
