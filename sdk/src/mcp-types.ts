/**
 * MCP Protocol Types — Faithful representation of MCP JSON-RPC messages
 * Used by the bridge and benchmarks to simulate real MCP behavior.
 */

// ============================================================================
// MCP JSON-RPC Base
// ============================================================================

export interface MCPRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, any>;
}

export interface MCPResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: any;
  error?: MCPError;
}

export interface MCPNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, any>;
}

export interface MCPError {
  code: number;
  message: string;
  data?: any;
}

// ============================================================================
// MCP Tool Definitions (as returned by tools/list)
// ============================================================================

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: MCPInputSchema;
  annotations?: MCPToolAnnotations;
}

export interface MCPInputSchema {
  type: "object";
  properties: Record<string, MCPPropertySchema>;
  required?: string[];
}

export interface MCPPropertySchema {
  type: string;
  description?: string;
  enum?: any[];
  items?: MCPPropertySchema;
  properties?: Record<string, MCPPropertySchema>;
  required?: string[];
  default?: any;
}

export interface MCPToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

// ============================================================================
// MCP Tool Call / Result
// ============================================================================

export interface MCPToolCallParams {
  name: string;
  arguments: Record<string, any>;
}

export interface MCPToolResult {
  content: MCPContent[];
  isError: boolean;
  structuredContent?: any;
}

export type MCPContent =
  | MCPTextContent
  | MCPImageContent
  | MCPResourceContent;

export interface MCPTextContent {
  type: "text";
  text: string;
}

export interface MCPImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface MCPResourceContent {
  type: "resource";
  resource: { uri: string; text: string };
}

// ============================================================================
// MCP Initialize
// ============================================================================

export interface MCPInitializeParams {
  protocolVersion: string;
  capabilities: Record<string, any>;
  clientInfo: { name: string; version: string };
}

export interface MCPInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, any>;
  serverInfo: { name: string; version: string };
}

// ============================================================================
// MCP Simulated Server (for benchmarking)
// ============================================================================

export interface MCPSimulatedServer {
  name: string;
  version: string;
  tools: MCPToolDefinition[];
  handleCall: (name: string, args: Record<string, any>) => MCPToolResult;
}
