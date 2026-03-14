# AXON Protocol Specification v0.1.0

## Agent eXchange Over Network

**Status:** Draft
**Authors:** Designed as a next-generation successor to MCP
**Date:** 2026-03-13

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Design Principles](#2-design-principles)
3. [Architecture Overview](#3-architecture-overview)
4. [Transport Layer](#4-transport-layer)
5. [Wire Format](#5-wire-format)
6. [Tool Registry & Lazy Discovery](#6-tool-registry--lazy-discovery)
7. [Out-of-Context Result Store (OCRS)](#7-out-of-context-result-store-ocrs)
8. [Capability-Based Security](#8-capability-based-security)
9. [Multiplexed Execution](#9-multiplexed-execution)
10. [Progressive Results](#10-progressive-results)
11. [Delta-Encoded State](#11-delta-encoded-state)
12. [Session Lifecycle](#12-session-lifecycle)
13. [Comparison with MCP](#13-comparison-with-mcp)
14. [Migration Path from MCP](#14-migration-path-from-mcp)

---

## 1. Executive Summary

AXON is a next-generation tool protocol for AI agents, designed to solve the fundamental limitations of the Model Context Protocol (MCP):

| Problem | MCP Impact | AXON Solution |
|---------|-----------|---------------|
| Tool definitions consume 55,000+ tokens | 30% of context wasted on schemas | **Lazy Discovery**: ~20 tokens/tool manifest, full schema on demand |
| Tool results serialized into context | Context fills after 10-15 calls | **Out-of-Context Result Store**: results stored externally, model gets summaries |
| Advisory-only security | 43% of servers vulnerable | **Capability Tokens**: unforgeable, scoped, attenuable permissions |
| Sequential execution | 300-800ms stacking latency | **Multiplexed Streams**: parallel tool calls with dependency graphs |
| Text-only JSON-RPC | Verbose, no compression | **Binary framing**: MessagePack default, negotiable encoding |
| All-or-nothing results | Oversized payloads | **Progressive Results**: layered delivery, early termination |
| Full retransmission | Same data sent repeatedly | **Delta Encoding**: content-addressed, transmit only changes |

**Headline metrics (projected vs MCP):**
- **95% reduction** in context tokens consumed by tool definitions
- **70-80% reduction** in context tokens consumed by tool results
- **3-5x throughput** improvement via multiplexed parallel execution
- **Zero advisory security** — all permissions are enforced structurally

---

## 2. Design Principles

### 2.1 Context Is the Scarcest Resource

Every token in the model's context window has a cost. AXON treats context consumption as the primary optimization target. The protocol is designed so that the model's context contains ONLY information actively needed for reasoning.

### 2.2 Progressive Disclosure

Information flows from compact to detailed:
- Tool manifests → full schemas (on demand)
- Result summaries → result details → raw data (on demand)
- Error codes → error details → stack traces (on demand)

The model pulls detail when it needs it, not when the server pushes it.

### 2.3 Enforce, Don't Advise

MCP's `readOnlyHint` and `destructiveHint` are advisory — servers can lie. AXON replaces hints with **capability tokens** that structurally enforce permissions. A tool without a write capability token CANNOT write, regardless of what it claims.

### 2.4 Parallel by Default

Tool calls are multiplexed over a single connection. The protocol natively supports dependency graphs: "call A and B in parallel, then call C with their results."

### 2.5 Binary-First, Human-Readable on Demand

The default wire format is binary (MessagePack). JSON mode is available for debugging. The protocol negotiates encoding at connection time.

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                    AXON HOST                         │
│                                                      │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  Model    │  │  Context     │  │  Capability   │  │
│  │  Runtime  │←→│  Manager     │←→│  Authority    │  │
│  │          │  │              │  │               │  │
│  └────┬─────┘  └──────┬───────┘  └───────┬───────┘  │
│       │               │                  │           │
│       │        ┌──────┴───────┐          │           │
│       │        │   Result     │          │           │
│       │        │   Store      │          │           │
│       │        │   (OCRS)     │          │           │
│       │        └──────┬───────┘          │           │
│       │               │                  │           │
│  ┌────┴───────────────┴──────────────────┴────────┐  │
│  │              AXON Multiplexer                   │  │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐          │  │
│  │  │Stream 1 │ │Stream 2 │ │Stream N │          │  │
│  │  └────┬────┘ └────┬────┘ └────┬────┘          │  │
│  └───────┼───────────┼───────────┼────────────────┘  │
│          │           │           │                    │
└──────────┼───────────┼───────────┼────────────────────┘
           │           │           │
    ┌──────┴──┐  ┌─────┴───┐  ┌───┴───────┐
    │ Server  │  │ Server  │  │ Server    │
    │ A       │  │ B       │  │ C         │
    └─────────┘  └─────────┘  └───────────┘
```

### Key Components

- **Model Runtime**: The LLM inference engine. Receives only compact manifests and summaries.
- **Context Manager**: Controls what enters the model's context. Enforces token budgets.
- **Capability Authority**: Issues, validates, and revokes capability tokens.
- **Result Store (OCRS)**: Content-addressed store for tool results. Results live here, NOT in the model's context.
- **Multiplexer**: Binary framing layer that interleaves multiple tool call streams over a single connection.

---

## 4. Transport Layer

### 4.1 Transport Modes

AXON supports three transport modes, negotiated at connection time:

| Mode | Use Case | Underlying Protocol |
|------|----------|-------------------|
| `local` | Same-machine tools | Unix domain socket or stdio |
| `stream` | Remote tools, bidirectional | WebSocket with binary frames |
| `request` | Stateless/serverless tools | HTTP/2+ POST with streaming response |

### 4.2 Connection Establishment

```
Client                              Server
  │                                    │
  │──── AXON-HELLO ──────────────────→│
  │     { version: "0.1.0",           │
  │       encoding: ["msgpack","json"],│
  │       transport: "stream",         │
  │       capabilities: [...] }        │
  │                                    │
  │←─── AXON-WELCOME ────────────────│
  │     { version: "0.1.0",           │
  │       encoding: "msgpack",         │
  │       session_id: "...",           │
  │       server_manifest: [...],      │
  │       capability_token: "..." }    │
  │                                    │
  │──── AXON-READY ──────────────────→│
  │                                    │
```

The `AXON-HELLO` / `AXON-WELCOME` handshake:
1. Negotiates protocol version and encoding
2. Server sends its **tool manifest** (compact, ~20 tokens/tool)
3. Server issues initial **capability tokens** scoped to the session
4. Client confirms readiness

### 4.3 Binary Framing

Every AXON message is wrapped in a binary frame:

```
┌────────────────────────────────────────────────┐
│  Frame Header (8 bytes)                         │
│  ┌──────┬──────┬────────┬──────────┬──────────┐│
│  │ Magic│Stream│ Type   │ Flags    │ Length    ││
│  │ 1B   │ ID   │ 1B     │ 1B       │ 4B       ││
│  │ 0xAX │ 2B   │        │          │          ││
│  └──────┴──────┴────────┴──────────┴──────────┘│
├────────────────────────────────────────────────┤
│  Payload (Length bytes, encoded per negotiation)│
└────────────────────────────────────────────────┘
```

**Frame Types:**

| Type ID | Name | Description |
|---------|------|-------------|
| 0x01 | CALL | Tool invocation request |
| 0x02 | RESULT | Tool result (may be partial) |
| 0x03 | SCHEMA | Full tool schema (on demand) |
| 0x04 | SUMMARY | Compact result summary for context |
| 0x05 | DETAIL | Detailed result section (on demand) |
| 0x06 | DELTA | Delta-encoded update |
| 0x07 | CAPABILITY | Capability token grant/revoke |
| 0x08 | CANCEL | Cancel an in-flight tool call |
| 0x09 | PROGRESS | Progress notification |
| 0x0A | ERROR | Error response |
| 0x0B | PING/PONG | Keepalive |

**Flags (bitfield):**

| Bit | Name | Meaning |
|-----|------|---------|
| 0 | FIN | Final frame for this stream |
| 1 | COMPRESSED | Payload is zstd-compressed |
| 2 | SIGNED | Payload includes cryptographic signature |
| 3 | PRIORITY | High-priority frame (skip queue) |

---

## 5. Wire Format

### 5.1 Encoding Negotiation

AXON supports pluggable encodings, negotiated during handshake:

| Encoding | ID | Use Case |
|----------|----|----------|
| MessagePack | 0x01 | Default. 15-25% smaller than JSON, fast parsing |
| Protobuf | 0x02 | Structured data with known schemas. Smallest wire size |
| JSON | 0x03 | Debugging, human inspection |
| Raw | 0x04 | Binary blobs (images, files). No encoding overhead |

The client proposes encodings in preference order. The server selects one.

### 5.2 MessagePack Message Structure

All AXON messages share a common envelope:

```typescript
type AxonMessage = {
  id: uint32;         // Request/correlation ID
  type: FrameType;    // Message type enum
  stream: uint16;     // Stream ID for multiplexing
  cap?: string;       // Capability token (compact base64)
  payload: any;       // Type-specific payload
};
```

This is 12-20 bytes of overhead vs MCP's ~80-120 bytes of JSON-RPC envelope.

---

## 6. Tool Registry & Lazy Discovery

### 6.1 The Problem with MCP

MCP injects ALL tool schemas into the model's system prompt:

```
MCP: 93 tools × ~600 tokens/tool = 55,800 tokens consumed at startup
```

### 6.2 AXON's Three-Tier Discovery

AXON uses a three-tier system that reduces context consumption by **95%**:

#### Tier 1: Tool Manifest (Always in Context)

During handshake, the server sends a **manifest** — a compact list of tool summaries:

```typescript
type ToolManifest = {
  id: string;           // "read_file"
  summary: string;      // "Read file contents" (max 10 words)
  category: string;     // "filesystem"
  tags: string[];       // ["read", "io"]
};
```

**Cost: ~15-20 tokens per tool**

For 93 tools: **~1,800 tokens** (vs MCP's 55,800 = **97% reduction**)

The manifest gives the model enough information to DECIDE which tool to use, without the full parameter schema.

#### Tier 2: Tool Schema (Fetched On Demand)

When the model decides to call a tool, the host fetches the full schema:

```typescript
type ToolSchema = {
  id: string;
  description: string;      // Full description
  input: JSONSchema;         // Parameter schema
  output?: JSONSchema;       // Output schema
  capabilities_required: string[];  // Required capability types
  annotations: {
    idempotent: boolean;
    read_only: boolean;
    estimated_latency_ms: number;
    max_result_size_bytes: number;
  };
};
```

The schema is:
- Fetched ONCE per tool per session
- Cached by content hash (if the schema hasn't changed, don't re-fetch)
- Injected into context ONLY for the current tool call, then evicted

#### Tier 3: Tool Documentation (Rare, On Demand)

For complex tools, the server can provide extended documentation:

```typescript
type ToolDocs = {
  id: string;
  examples: ToolExample[];   // Input/output examples
  related_tools: string[];   // Suggested combinations
  caveats: string[];         // Known limitations
};
```

This is NEVER automatically injected. The model explicitly requests it when stuck.

### 6.3 Schema Caching

Schemas are content-addressed:

```
schema_hash = SHA256(canonical(schema))
```

The host maintains a local schema cache. On reconnection or server restart, the host sends known schema hashes. The server only transmits schemas that have changed.

```
Client                              Server
  │                                    │
  │── SCHEMA_CHECK ──────────────────→│
  │   { known: ["abc123", "def456"] }  │
  │                                    │
  │←── SCHEMA_DELTA ─────────────────│
  │   { unchanged: ["abc123"],         │
  │     updated: [{ id: "...",         │
  │       hash: "ghi789", ... }] }     │
  │                                    │
```

---

## 7. Out-of-Context Result Store (OCRS)

### 7.1 The Problem

In MCP, every tool result is serialized directly into the model's context:

```
tool_call("search_code", { query: "auth" })
→ 15,000 tokens of search results injected into context
→ After 10 calls: 150,000 tokens consumed = context exhausted
```

### 7.2 AXON's Approach: Store Outside, Summarize Inside

AXON separates result **storage** from result **consumption**:

```
┌─────────────────────────────────┐
│         Model Context           │
│                                  │
│  "search_code returned 47       │
│   matches across 12 files.      │
│   Top 3: auth.ts:42,            │
│   middleware.ts:15, login.ts:8"  │
│                                  │
│  [ref:ax_r_7f3a → full results] │
│                                  │
│  (~50 tokens vs 15,000 tokens)  │
└─────────────────────────────────┘
           │
           │ "zoom into auth.ts matches"
           ▼
┌─────────────────────────────────┐
│     Out-of-Context Result Store │
│                                  │
│  ax_r_7f3a: {                    │
│    full_results: [...47 items],  │
│    indexed_by: ["file","line"],  │
│    size: 15,000 tokens,          │
│    hash: "sha256:..."            │
│  }                               │
└─────────────────────────────────┘
```

### 7.3 Result Lifecycle

1. **Tool executes** → full result stored in OCRS with content hash
2. **Summary generated** → a compact summary (50-200 tokens) is created
3. **Summary + reference injected** into model context
4. **Model reasons** with the summary. If it needs more detail:
   - Sends a `DETAIL` request with the result reference + selector
   - E.g., `{ ref: "ax_r_7f3a", select: "file=auth.ts" }`
   - Receives targeted detail (200-500 tokens) instead of the full 15,000

### 7.4 Context Budget

The host enforces a **context budget** for tool results:

```typescript
type ContextBudget = {
  max_summary_tokens: number;     // Max tokens for any single summary (default: 200)
  max_total_result_tokens: number; // Max total tokens from results in context (default: 4000)
  eviction_policy: "lru" | "priority" | "relevance";
};
```

When the budget is exceeded, older summaries are evicted from context (but results remain in OCRS and can be re-accessed).

### 7.5 Summary Generation

Summaries are generated by the **host**, not the server, using one of:

1. **Schema-driven extraction**: If the tool has an `outputSchema`, extract key fields
2. **Server-provided summary**: The server can include a `summary` field in results
3. **Host-side compression**: A small, fast model generates a summary from the full result
4. **Truncation with structure**: First N items + count + key statistics

The model never sees raw, unsummarized tool output unless it explicitly requests it.

---

## 8. Capability-Based Security

### 8.1 The Problem with MCP Security

MCP's security model is fundamentally advisory:
- Tool annotations (`readOnlyHint`) are untrusted hints
- 43% of tested servers had injection vulnerabilities
- No structural enforcement of permissions
- Tools can silently change behavior after approval (rug-pull attacks)

### 8.2 AXON Capability Tokens

Every action in AXON requires an unforgeable **capability token**:

```typescript
type CapabilityToken = {
  id: string;                    // Unique token ID
  type: CapabilityType;          // "tool:call", "resource:read", "resource:write"
  scope: string;                 // Tool ID or resource pattern (glob)
  constraints: {
    max_calls?: number;          // Max invocations before expiry
    expires_at?: ISO8601;        // Absolute expiry
    ttl_seconds?: number;        // Time-to-live from first use
    parameter_constraints?: {    // Restrict specific parameters
      [param: string]: {
        allowed_values?: any[];
        pattern?: string;        // Regex for string params
        max_value?: number;
        min_value?: number;
      };
    };
  };
  signature: string;             // Ed25519 signature from Capability Authority
};
```

### 8.3 Capability Flow

```
┌──────────┐         ┌──────────────┐         ┌──────────┐
│  Model   │         │  Capability  │         │  Tool    │
│  Runtime │         │  Authority   │         │  Server  │
└────┬─────┘         └──────┬───────┘         └────┬─────┘
     │                      │                      │
     │ "I want to read      │                      │
     │  /project/src/*.ts"  │                      │
     │─────────────────────→│                      │
     │                      │                      │
     │  CapabilityToken {   │                      │
     │    type: "resource:  │                      │
     │      read",          │                      │
     │    scope: "/project/ │                      │
     │      src/*.ts",      │                      │
     │    max_calls: 50,    │                      │
     │    ttl: 300s         │                      │
     │  }                   │                      │
     │←─────────────────────│                      │
     │                      │                      │
     │  CALL read_file      │                      │
     │  + CapabilityToken   │                      │
     │─────────────────────────────────────────────→│
     │                      │                      │
     │                      │  Verify signature    │
     │                      │  Check scope match   │
     │                      │  Check constraints   │
     │                      │                      │
     │  RESULT              │                      │
     │←─────────────────────────────────────────────│
     │                      │                      │
```

### 8.4 Key Security Properties

1. **No Ambient Authority**: A tool call without a valid capability token is rejected. Period. The model cannot access anything it wasn't explicitly granted.

2. **Attenuation (Narrow, Never Widen)**: A capability can be narrowed before delegation:
   ```
   capability("resource:read", "/project/**")
     → attenuate → capability("resource:read", "/project/src/*.ts")
   ```
   But NEVER widened. This is enforced cryptographically — the signature covers the scope.

3. **Revocation**: The Capability Authority can revoke any token instantly. Active tool calls with revoked tokens are terminated.

4. **Anti-Rug-Pull**: Tool definitions are signed by the server's key. If a definition changes, the signature changes, and the host:
   - Pauses all calls to that tool
   - Notifies the user: "Tool X changed its definition. Review and re-approve?"
   - Only resumes after explicit approval

5. **Cross-Server Isolation**: Each server receives its own capability namespace. Server A's tokens are meaningless to Server B. No cross-server privilege escalation.

### 8.5 Capability Types

| Type | Grants | Example Scope |
|------|--------|--------------|
| `tool:call` | Invoke a specific tool | `"read_file"` |
| `tool:call:*` | Invoke any tool on a server | `"server:github"` |
| `resource:read` | Read a resource | `"/project/src/**"` |
| `resource:write` | Write a resource | `"/project/src/main.ts"` |
| `resource:delete` | Delete a resource | `"/tmp/**"` |
| `sampling:request` | Server can request LLM sampling | `"summarize"` |
| `result:detail` | Access detailed result data | `"ax_r_7f3a"` |

---

## 9. Multiplexed Execution

### 9.1 The Problem

MCP tool calls are inherently sequential: call → wait → result → call → wait → result. For 5 independent tool calls at 300ms each, that's 1.5 seconds of blocking latency.

### 9.2 AXON Streams

Every tool call gets its own **stream** (identified by stream ID). Multiple streams are multiplexed over a single connection:

```
Time →

Stream 1: ──CALL──────────────────RESULT(partial)──RESULT(fin)──
Stream 2: ──CALL────RESULT(fin)──
Stream 3: ──────────CALL(depends on S2)──────────RESULT(fin)──
Stream 4: ──CALL──────────CANCEL──
```

### 9.3 Dependency Graphs

The model can express dependencies between tool calls:

```typescript
type CallGraph = {
  calls: {
    id: string;
    tool: string;
    params: any;
    depends_on?: string[];     // IDs of calls that must complete first
    param_bindings?: {         // Bind params from dependency results
      [param: string]: {
        from_call: string;     // Dependency call ID
        select: string;        // JSONPath into that result
      };
    };
  }[];
};
```

**Example**: "Search for files, then read the top 3 results":

```json
{
  "calls": [
    { "id": "search", "tool": "search_code", "params": { "query": "auth" } },
    {
      "id": "read1", "tool": "read_file",
      "depends_on": ["search"],
      "param_bindings": { "path": { "from_call": "search", "select": "$.results[0].path" } }
    },
    {
      "id": "read2", "tool": "read_file",
      "depends_on": ["search"],
      "param_bindings": { "path": { "from_call": "search", "select": "$.results[1].path" } }
    },
    {
      "id": "read3", "tool": "read_file",
      "depends_on": ["search"],
      "param_bindings": { "path": { "from_call": "search", "select": "$.results[2].path" } }
    }
  ]
}
```

The multiplexer:
1. Executes `search` immediately
2. When `search` completes, executes `read1`, `read2`, `read3` **in parallel**
3. Returns all results as they complete

**Total latency**: `search_time + max(read1_time, read2_time, read3_time)` instead of MCP's `search_time + read1_time + read2_time + read3_time`.

### 9.4 Stream Priorities

Streams have priority levels (0-7, lower = higher priority):

| Priority | Use Case |
|----------|----------|
| 0 | Critical: security checks, capability validation |
| 1 | Interactive: user-facing, latency-sensitive |
| 2 | Standard: normal tool calls |
| 3 | Background: prefetching, caching |
| 7 | Idle: non-urgent maintenance |

The multiplexer services higher-priority streams first, preempting lower-priority ones.

### 9.5 Cancellation

Any in-flight tool call can be cancelled:

```
Client → CANCEL { stream: 4, reason: "no_longer_needed" }
Server → acknowledges, cleans up resources
```

This is critical for progressive results — the model may cancel a long-running query after receiving enough partial results.

---

## 10. Progressive Results

### 10.1 Three-Layer Result Delivery

Every tool result is delivered in up to three layers:

```
┌─────────────────────────────────────────────┐
│ Layer 0: STATUS (always delivered, ~5 tokens)│
│ { status: "ok", items: 47, time_ms: 120 }   │
├─────────────────────────────────────────────┤
│ Layer 1: SUMMARY (auto-delivered, ~50-200    │
│ tokens)                                      │
│ "47 matches in 12 files. Top: auth.ts:42,   │
│  middleware.ts:15, login.ts:8. Categories:   │
│  authentication (28), authorization (12),    │
│  audit (7)."                                 │
├─────────────────────────────────────────────┤
│ Layer 2: DETAIL (on demand, variable size)   │
│ Full results with all fields, filtered by    │
│ selector. Only fetched when model needs it.  │
└─────────────────────────────────────────────┘
```

### 10.2 Streaming Within Layers

Layer 2 supports streaming — results arrive incrementally:

```
Server → RESULT { stream: 1, layer: 2, index: 0, data: {...}, fin: false }
Server → RESULT { stream: 1, layer: 2, index: 1, data: {...}, fin: false }
Server → RESULT { stream: 1, layer: 2, index: 2, data: {...}, fin: false }
Model  → CANCEL { stream: 1, reason: "sufficient" }  // Got enough
```

### 10.3 Result Selectors

When requesting Layer 2 details, the model can use selectors to get exactly what it needs:

```typescript
type ResultSelector = {
  ref: string;                    // Result reference
  filter?: {                      // Filter criteria
    [field: string]: any;         // Field-value match
  };
  select?: string[];              // Only return these fields
  slice?: { offset: number; limit: number };  // Pagination
  sort?: { field: string; order: "asc" | "desc" };
};
```

**Example**: "Show me only the auth.ts matches, just the line numbers and content":

```json
{
  "ref": "ax_r_7f3a",
  "filter": { "file": "auth.ts" },
  "select": ["line", "content"],
  "slice": { "offset": 0, "limit": 5 }
}
```

This returns ~100 tokens instead of 15,000.

---

## 11. Delta-Encoded State

### 11.1 Content-Addressed Results

Every result in the OCRS is content-addressed:

```
result_hash = SHA256(tool_id + canonical(params) + canonical(result))
```

If the same tool is called with the same parameters and produces the same result, the hash matches and no new storage is needed.

### 11.2 Delta Updates

For tools that return evolving state (e.g., file contents, database snapshots), AXON supports delta encoding:

```
Call 1: read_file("/src/main.ts")
  → Result: full content, hash: abc123, 500 lines

Call 2: read_file("/src/main.ts")  (after user edited line 42)
  → Server detects: client has abc123
  → Delta: { base: "abc123", ops: [{ line: 42, old: "...", new: "..." }] }
  → Transmitted: ~20 tokens instead of 500 lines
```

### 11.3 State Snapshots

The host maintains a **state tree** — a Merkle DAG of all known results:

```
         root (hash: xyz)
        /        \
   filesystem    database
   (hash: aaa)  (hash: bbb)
    /      \
 src/      test/
 (hash: c) (hash: d)
```

On reconnection, the client sends the root hash. The server traverses the tree and only sends branches where hashes differ.

---

## 12. Session Lifecycle

### 12.1 Phases

```
┌──────────┐    ┌───────────┐    ┌───────────┐    ┌──────────┐
│ HANDSHAKE│───→│ DISCOVERY │───→│ OPERATION │───→│ SHUTDOWN │
│          │    │           │    │           │    │          │
│ Version  │    │ Manifests │    │ Tool calls│    │ Cleanup  │
│ Encoding │    │ Caps      │    │ Results   │    │ Revoke   │
│ Transport│    │ State sync│    │ Streaming │    │ Close    │
└──────────┘    └───────────┘    └───────────┘    └──────────┘
```

### 12.2 Handshake Phase

1. Client sends `AXON-HELLO` with version, encoding preferences, capabilities
2. Server responds with `AXON-WELCOME` with selected encoding, tool manifest, initial capabilities
3. Client sends `AXON-READY`

### 12.3 Discovery Phase

1. Host receives tool manifests from all connected servers
2. Host injects compact manifests into model context (~20 tokens/tool)
3. Host synchronizes state trees (if reconnecting)

### 12.4 Operation Phase

Normal tool calling:
1. Model selects a tool from manifests
2. Host fetches full schema (if not cached) via `SCHEMA` frame
3. Host requests capability token from Capability Authority
4. Host sends `CALL` frame with capability token
5. Server validates capability, executes tool
6. Server sends `RESULT` frame(s) — progressive layers
7. Host stores full result in OCRS
8. Host injects summary into model context
9. Model may request details via `DETAIL` frame

### 12.5 Shutdown Phase

1. Either side sends `AXON-CLOSE`
2. In-flight streams are cancelled
3. Capability tokens are revoked
4. OCRS is persisted or cleared (configurable)

---

## 13. Comparison with MCP

### 13.1 Context Consumption

| Scenario | MCP Tokens | AXON Tokens | Savings |
|----------|-----------|-------------|---------|
| 50 tools registered | ~30,000 | ~1,000 (manifests) | **97%** |
| 93 tools (GitHub MCP) | ~55,800 | ~1,860 | **97%** |
| 1 search result (large) | ~15,000 | ~150 (summary) | **99%** |
| 10 tool calls in session | ~80,000 | ~3,000 (summaries) | **96%** |
| Full session (50 tools, 20 calls) | ~190,000 | ~5,000 | **97%** |

### 13.2 Latency

| Scenario | MCP | AXON | Improvement |
|----------|-----|------|-------------|
| 5 independent tool calls | 1,500ms (sequential) | 300ms (parallel) | **5x** |
| Call with dependency chain | 1,200ms | 600ms | **2x** |
| Large result processing | 500ms (parse JSON) | 200ms (MessagePack) | **2.5x** |
| Schema fetch (cached) | N/A (always sent) | 0ms | **∞** |

### 13.3 Security

| Aspect | MCP | AXON |
|--------|-----|------|
| Permission model | Advisory hints | Enforced capability tokens |
| Cross-server isolation | None | Namespace isolation |
| Tool definition integrity | None | Cryptographic signatures |
| Rug-pull prevention | None | Signature change detection |
| Privilege escalation | Possible | Structurally impossible |
| Parameter validation | Server-side only | Capability constraints |

### 13.4 Wire Efficiency

| Metric | MCP (JSON-RPC) | AXON (MessagePack) |
|--------|----------------|-------------------|
| Envelope overhead | 80-120 bytes | 12-20 bytes |
| Tool call message | ~500 bytes | ~150 bytes |
| Compression | Transport-level only | Per-frame zstd |
| Duplicate results | Full retransmission | Delta encoded |

---

## 14. Migration Path from MCP

AXON is designed for incremental adoption. An MCP→AXON bridge enables existing MCP servers to work with AXON hosts:

### 14.1 AXON-MCP Bridge

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  AXON Host   │────→│  Bridge      │────→│  MCP Server  │
│              │     │              │     │  (existing)   │
│  Binary,     │     │  Translates: │     │  JSON-RPC,    │
│  Multiplexed │     │  Frames↔JSON │     │  Sequential   │
│  Cap tokens  │     │  Caps→pass   │     │  No caps      │
└──────────────┘     └──────────────┘     └──────────────┘
```

The bridge:
1. Converts AXON binary frames to MCP JSON-RPC messages
2. Converts MCP `tools/list` into AXON manifests
3. Wraps MCP results in AXON progressive layers (auto-generates summaries)
4. Applies capability checks on behalf of legacy MCP servers
5. Enables parallel execution by queuing MCP calls

### 14.2 Migration Levels

| Level | Description | Effort |
|-------|-------------|--------|
| L0 | AXON host + MCP bridge | Host-side only. No server changes. |
| L1 | Server adds AXON handshake + manifests | Minimal server change. Keep JSON-RPC for calls. |
| L2 | Server adopts binary encoding + progressive results | Moderate change. Major context savings. |
| L3 | Server implements capability validation | Full security model. |
| L4 | Native AXON server | Full protocol benefits. |

---

## Appendix A: Message Type Reference

### A.1 CALL

```typescript
{
  id: uint32;
  tool: string;
  params: Record<string, any>;
  capability: string;            // Base64 capability token
  graph?: CallGraph;             // Optional dependency graph for batch calls
  priority?: uint8;              // Stream priority (0-7)
  timeout_ms?: uint32;           // Per-call timeout
  context_hash?: string;         // For delta-encoded context
}
```

### A.2 RESULT

```typescript
{
  id: uint32;                    // Correlates to CALL id
  layer: 0 | 1 | 2;             // Progressive layer
  status: "ok" | "error" | "partial";
  ref: string;                   // OCRS reference for detail requests
  hash: string;                  // Content hash
  summary?: string;              // Layer 1: compact summary
  data?: any;                    // Layer 2: full/partial data
  delta?: DeltaOp[];             // Delta-encoded update
  streaming?: boolean;           // More frames coming for this layer
  capabilities?: CapabilityToken[];  // New capabilities granted by result
}
```

### A.3 DETAIL

```typescript
{
  ref: string;                   // OCRS reference
  selector: ResultSelector;      // What to fetch
  capability: string;            // Must have result:detail capability
}
```

---

## Appendix B: Capability Token Format

```
AXON-CAP-v1.<base64url(header)>.<base64url(payload)>.<base64url(signature)>
```

Header:
```json
{ "alg": "Ed25519", "kid": "authority-key-id" }
```

Payload:
```json
{
  "jti": "unique-token-id",
  "iss": "capability-authority-id",
  "sub": "session-id",
  "type": "tool:call",
  "scope": "read_file",
  "constraints": { "max_calls": 100, "ttl_seconds": 600 },
  "iat": 1710345600,
  "exp": 1710346200
}
```

Signature: Ed25519 over `header.payload` using the Capability Authority's private key.

---

## Appendix C: OCRS Reference Format

```
ax_r_<base58(sha256(result)[0:12])>
```

12-byte truncated SHA256, base58-encoded. Collision-resistant for practical use, compact for context injection.

---

*AXON Protocol — designed from first principles for the age of AI agents.*
