# AXON Protocol

**Agent eXchange Over Network** — A next-generation tool protocol for AI agents.

MCP (Model Context Protocol) dumps every tool result into the model's context window. For browser automation, a single screenshot is ~60K tokens of base64. Three screenshots and the 200K context window overflows. The model loses everything.

AXON fixes this at the protocol level.

## Key Innovations

### 1. Out-of-Context Result Store (OCRS)
Tool results are stored externally in a content-addressed store. The model gets a compact summary + reference handle (~17 tokens instead of ~61K for a screenshot). When it needs detail, it does a targeted drill-down.

### 2. 3-Tier Lazy Discovery
Instead of dumping all tool schemas upfront (~4,900 tokens for 18 Chrome tools), AXON uses compact manifests (~400 tokens) with on-demand schema fetching. This eliminates a real class of bugs where the model "forgets" tool parameters in long sessions.

### 3. Capability-Based Security
Unforgeable tokens with scope globs, TTL expiry, and attenuation. MCP has no tool-level auth.

## Benchmark Results

Real measurements against live public websites (example.com, Wikipedia, httpbin.org):

| Metric | MCP | AXON | Improvement |
|--------|-----|------|-------------|
| Context tokens | ~495K | ~1.6K | 99.7% reduction |
| Wire size | ~1.9MB | ~8KB | 99.6% reduction |
| Security checks | 0/8 | 8/8 | Full coverage |

## Quick Start

```bash
# Install the SDK
npm install @axon-protocol/sdk

# Use as MCP server with Claude Desktop
npx @axon-protocol/chrome-server
```

### Claude Desktop Configuration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "axon-chrome": {
      "command": "npx",
      "args": ["tsx", "/path/to/axon-protocol/servers/chrome/src/mcp-stdio.ts"],
      "env": {
        "AXON_HEADLESS": "false"
      }
    }
  }
}
```

### Claude Code Configuration

```bash
claude mcp add axon-chrome -- npx tsx /path/to/axon-protocol/servers/chrome/src/mcp-stdio.ts
```

## Project Structure

```
axon-protocol/
  sdk/                      # Core AXON Protocol SDK
    src/
      types.ts              # Protocol type definitions
      frame.ts              # Binary framing (8-byte header)
      capability.ts         # Capability-based security
      ocrs.ts               # Out-of-Context Result Store
      server.ts             # Server SDK
      multiplexer.ts        # Stream multiplexer
      bridge.ts             # MCP-to-AXON bridge
      mcp-simulator.ts      # MCP protocol simulator for benchmarks
  servers/
    chrome/                 # Chrome browser automation server
      src/
        browser.ts          # Puppeteer browser management
        server.ts           # 15 Chrome tools with OCRS integration
        mcp-stdio.ts        # MCP-compatible stdio wrapper
        index.ts            # Entry point
      benchmark-real.ts     # Real-world benchmark against live sites
  blog/                     # Technical blog with visualizations
  tests/                    # Benchmark suite
```

## SDK Usage

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

## Running Benchmarks

```bash
# Real-world benchmark (requires Chrome/Chromium)
cd servers/chrome
npx tsx benchmark-real.ts
```

## MCP Compatibility

AXON ships with an MCP-compatible stdio wrapper. You can use it as a drop-in replacement with any MCP client (Claude Desktop, Cursor, etc.) with zero migration. The wrapper translates JSON-RPC stdio to AXON internally while giving you the full benefits of OCRS and capability-based security.

## Status

**v0.1.0** — Early release. The protocol design is stable but the implementation is actively evolving. We welcome feedback and contributions.

## License

MIT
