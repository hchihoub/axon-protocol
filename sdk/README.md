# @axon-protocol/sdk

**AXON Protocol SDK** — Core TypeScript SDK for building AI agent tool servers with out-of-context result storage, lazy discovery, and capability-based security.

[![npm](https://img.shields.io/npm/v/@axon-protocol/sdk)](https://www.npmjs.com/package/@axon-protocol/sdk)
[![license](https://img.shields.io/npm/l/@axon-protocol/sdk)](https://github.com/hchihoub/axon-protocol/blob/main/LICENSE)

## Why AXON?

MCP (Model Context Protocol) dumps every tool result directly into the model's context window. For browser automation, a single screenshot is ~92K tokens of base64. Three screenshots and the 200K context window overflows.

AXON fixes this at the protocol level:

| Metric | MCP | AXON | Improvement |
|--------|-----|------|-------------|
| Context tokens (26 calls) | 266,660 | 720 | 99.7% reduction |
| Context window fit? | NO (147%) | YES (0.6%) | Fits 165x over |
| Wire size | 1,024 KB | 4 KB | 99.6% reduction |
| Security checks | 0/8 | 8/8 | Full coverage |

## Install

```bash
npm install @axon-protocol/sdk
```

## What's Included

- **`AxonServer`** — Server SDK for registering tools with 3-tier lazy discovery
- **`ResultStore`** (OCRS) — Out-of-Context Result Store with content-addressed storage and automatic summarization
- **`CapabilityAuthority`** — Unforgeable capability tokens with scope globs, TTL expiry, and attenuation
- **`MCPToAxonBridge`** — Translate MCP tool definitions to AXON format for benchmarking and migration
- **`Multiplexer`** — Stream multiplexer for parallel tool execution
- **`encodeFrame` / `decodeFrame`** — Binary framing with 8-byte headers

## Quick Start

```typescript
import { AxonServer, ResultStore, CapabilityAuthority } from "@axon-protocol/sdk";

const server = new AxonServer({ name: "my-tools", version: "1.0.0" });

server.tool({
  id: "read_file",
  summary: "Read file contents",
  description: "Read the full contents of a file at the given path",
  category: "filesystem",
  tags: ["read", "io"],
  input: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute file path" },
    },
    required: ["path"],
  },
  annotations: { read_only: true, idempotent: true },
  handler: async ({ path }) => {
    const fs = await import("node:fs/promises");
    return fs.readFile(path, "utf-8");
  },
  summarizer: (content) => {
    const lines = content.split("\n").length;
    return `${lines} lines. First line: "${content.split("\n")[0]}"`;
  },
});
```

## Core Concepts

### Out-of-Context Result Store (OCRS)

Tool results are stored externally. The model gets a compact summary + reference handle (~23 tokens instead of ~92K for a screenshot). When it needs detail, it does a targeted drill-down.

```typescript
const store = new ResultStore({ max_summary_tokens: 300 });

// Store a large result — returns a compact reference
const ref = store.store("screenshot", params, largeBase64Data, "Screenshot 1280x800 of google.com");

// Later, retrieve the full data by reference
const full = store.retrieve(ref.handle);
```

### 3-Tier Lazy Discovery

Instead of dumping all tool schemas upfront (~4,918 tokens for 14 tools), AXON uses compact manifests (~401 tokens) with on-demand schema fetching.

```typescript
// Tier 1: Compact manifests — always in context (~29 tokens/tool)
server.getManifest();
// → [{ id: "screenshot", summary: "Take a screenshot", category: "capture", tags: [...] }]

// Tier 2: Full schema — fetched on demand when the model calls a tool
server.getSchema("screenshot");
// → { description: "...", input: { type: "object", properties: { ... } }, annotations: { ... } }
```

### Capability-Based Security

```typescript
const authority = new CapabilityAuthority("my-server", signingKey, verifyKey);

// Issue a scoped capability
const cap = authority.issue("session-1", "resource:write", "*.example.com", {
  ttl_seconds: 3600,
  constraints: { max_calls: 100 },
});

// Verify before executing
const valid = authority.verify(cap);
// → { valid: true, scope: "*.example.com", type: "resource:write" }
```

## API Reference

### `AxonServer`

| Method | Description |
|--------|-------------|
| `tool(def)` | Register a tool with handler, summarizer, and schema |
| `execute(call, context)` | Execute a tool call |
| `getManifest()` | Get Tier 1 compact manifests for all tools |
| `getSchema(id)` | Get Tier 2 full schema for a specific tool |
| `toolCount` | Number of registered tools |
| `estimateManifestTokens()` | Estimate context cost of manifests |

### `ResultStore`

| Method | Description |
|--------|-------------|
| `store(toolId, params, data, summary)` | Store result, return compact reference |
| `retrieve(handle)` | Retrieve full data by reference handle |
| `summarize(data, maxTokens)` | Auto-summarize large results |

### `CapabilityAuthority`

| Method | Description |
|--------|-------------|
| `issue(sessionId, type, scope, opts)` | Issue a new capability token |
| `verify(token)` | Verify and decode a capability |
| `revoke(capId)` | Revoke a capability by ID |

## Related Packages

- [`@axon-protocol/chrome-server`](https://www.npmjs.com/package/@axon-protocol/chrome-server) — 14 Puppeteer-powered browser automation tools with OCRS integration

## Links

- [GitHub](https://github.com/hchihoub/axon-protocol)
- [npm](https://www.npmjs.com/package/@axon-protocol/sdk)

## License

MIT
