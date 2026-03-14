/**
 * AXON Protocol — Core Type Definitions
 * Agent eXchange Over Network v0.1.0
 */

// ============================================================================
// Frame Types
// ============================================================================

export enum FrameType {
  CALL = 0x01,
  RESULT = 0x02,
  SCHEMA = 0x03,
  SUMMARY = 0x04,
  DETAIL = 0x05,
  DELTA = 0x06,
  CAPABILITY = 0x07,
  CANCEL = 0x08,
  PROGRESS = 0x09,
  ERROR = 0x0a,
  PING = 0x0b,
  PONG = 0x0c,
}

export enum FrameFlag {
  FIN = 1 << 0,
  COMPRESSED = 1 << 1,
  SIGNED = 1 << 2,
  PRIORITY = 1 << 3,
}

export enum Encoding {
  MSGPACK = 0x01,
  PROTOBUF = 0x02,
  JSON = 0x03,
  RAW = 0x04,
}

export enum StreamPriority {
  CRITICAL = 0,
  INTERACTIVE = 1,
  STANDARD = 2,
  BACKGROUND = 3,
  IDLE = 7,
}

// ============================================================================
// Binary Frame
// ============================================================================

export interface Frame {
  magic: 0xAA; // 'AX' simplified to single byte
  streamId: number; // uint16
  type: FrameType;
  flags: number; // Bitfield of FrameFlag
  payload: Uint8Array;
}

export const FRAME_HEADER_SIZE = 8;

// ============================================================================
// Tool Manifest (Tier 1 — Always in Context, ~20 tokens/tool)
// ============================================================================

export interface ToolManifest {
  id: string;
  summary: string; // Max 10 words
  category: string;
  tags: string[];
}

// ============================================================================
// Tool Schema (Tier 2 — Fetched on demand, cached by hash)
// ============================================================================

export interface ToolSchema {
  id: string;
  description: string;
  input: JSONSchema;
  output?: JSONSchema;
  capabilities_required: CapabilityType[];
  annotations: ToolAnnotations;
  hash: string; // SHA256 of canonical schema
}

export interface ToolAnnotations {
  idempotent: boolean;
  read_only: boolean;
  estimated_latency_ms: number;
  max_result_size_bytes: number;
}

export interface JSONSchema {
  type: string;
  properties?: Record<string, JSONSchema & { description?: string }>;
  required?: string[];
  items?: JSONSchema;
  enum?: any[];
  description?: string;
  [key: string]: any;
}

// ============================================================================
// Tool Documentation (Tier 3 — Rare, on explicit request)
// ============================================================================

export interface ToolDocs {
  id: string;
  examples: ToolExample[];
  related_tools: string[];
  caveats: string[];
}

export interface ToolExample {
  description: string;
  input: Record<string, any>;
  output: any;
}

// ============================================================================
// Capability Tokens
// ============================================================================

export type CapabilityType =
  | "tool:call"
  | "tool:call:*"
  | "resource:read"
  | "resource:write"
  | "resource:delete"
  | "sampling:request"
  | "result:detail";

export interface CapabilityToken {
  id: string;
  type: CapabilityType;
  scope: string; // Tool ID or resource glob pattern
  constraints: CapabilityConstraints;
  signature: string; // Ed25519 signature
  issued_at: number; // Unix timestamp
  expires_at: number; // Unix timestamp
}

export interface CapabilityConstraints {
  max_calls?: number;
  ttl_seconds?: number;
  parameter_constraints?: Record<string, ParameterConstraint>;
}

export interface ParameterConstraint {
  allowed_values?: any[];
  pattern?: string; // Regex
  max_value?: number;
  min_value?: number;
}

// ============================================================================
// Messages
// ============================================================================

export interface CallMessage {
  id: number;
  tool: string;
  params: Record<string, any>;
  capability: string; // Serialized capability token
  graph?: CallGraph;
  priority?: StreamPriority;
  timeout_ms?: number;
  context_hash?: string;
}

export interface CallGraph {
  calls: CallGraphNode[];
}

export interface CallGraphNode {
  id: string;
  tool: string;
  params: Record<string, any>;
  depends_on?: string[];
  param_bindings?: Record<string, ParamBinding>;
}

export interface ParamBinding {
  from_call: string;
  select: string; // JSONPath expression
}

export type ResultLayer = 0 | 1 | 2;

export interface ResultMessage {
  id: number;
  layer: ResultLayer;
  status: "ok" | "error" | "partial";
  ref: string; // OCRS reference
  hash: string; // Content hash
  summary?: string;
  data?: any;
  delta?: DeltaOp[];
  streaming?: boolean;
  capabilities?: CapabilityToken[];
}

export interface DeltaOp {
  op: "insert" | "delete" | "replace";
  path: string; // JSONPath
  value?: any;
  old_value?: any;
}

export interface DetailRequest {
  ref: string;
  selector: ResultSelector;
  capability: string;
}

export interface ResultSelector {
  filter?: Record<string, any>;
  select?: string[];
  slice?: { offset: number; limit: number };
  sort?: { field: string; order: "asc" | "desc" };
}

export interface CancelMessage {
  stream: number;
  reason: string;
}

export interface ProgressMessage {
  stream: number;
  progress: number; // 0.0 - 1.0
  message?: string;
}

export interface ErrorMessage {
  id: number;
  code: ErrorCode;
  message: string;
  details?: any;
}

export enum ErrorCode {
  INVALID_CAPABILITY = 1001,
  EXPIRED_CAPABILITY = 1002,
  SCOPE_VIOLATION = 1003,
  TOOL_NOT_FOUND = 2001,
  INVALID_PARAMS = 2002,
  TOOL_EXECUTION_ERROR = 2003,
  TIMEOUT = 3001,
  CANCELLED = 3002,
  RATE_LIMITED = 3003,
  INTERNAL_ERROR = 5000,
}

// ============================================================================
// Handshake
// ============================================================================

export interface AxonHello {
  version: string;
  encoding: Encoding[];
  transport: "local" | "stream" | "request";
  capabilities: string[];
  state_hash?: string; // For reconnection delta sync
}

export interface AxonWelcome {
  version: string;
  encoding: Encoding;
  session_id: string;
  server_manifest: ToolManifest[];
  capability_tokens: CapabilityToken[];
  state_delta?: StateDelta;
}

export interface StateDelta {
  base_hash: string;
  unchanged: string[];
  updated: ToolSchema[];
  removed: string[];
}

// ============================================================================
// OCRS (Out-of-Context Result Store)
// ============================================================================

export interface OCRSEntry {
  ref: string;
  hash: string;
  tool_id: string;
  params_hash: string;
  data: any;
  summary: string;
  created_at: number;
  accessed_at: number;
  size_bytes: number;
  size_tokens_estimate: number;
}

export interface ContextBudget {
  max_summary_tokens: number;
  max_total_result_tokens: number;
  eviction_policy: "lru" | "priority" | "relevance";
}
