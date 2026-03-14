# @axon-protocol/chrome-server

**AXON Chrome Server** — 14 Puppeteer-powered browser automation tools with out-of-context result storage. Drop-in MCP compatibility for Claude Desktop, Cursor, and any MCP client.

[![npm](https://img.shields.io/npm/v/@axon-protocol/chrome-server)](https://www.npmjs.com/package/@axon-protocol/chrome-server)
[![license](https://img.shields.io/npm/l/@axon-protocol/chrome-server)](https://github.com/hchihoub/axon-protocol/blob/main/LICENSE)

## Why?

MCP browser tools dump raw screenshots (~92K tokens of base64) directly into the model's context window. Three screenshots overflow the 200K context limit. The model loses all collected data and can't answer the user's question.

AXON Chrome Server stores results externally via OCRS. The model gets compact summaries (~23 tokens per screenshot) and can drill down on demand.

## Install

```bash
npm install @axon-protocol/chrome-server
```

**Peer dependency:** `@axon-protocol/sdk` (installed automatically with npm 7+)

## Quick Start

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "axon-chrome": {
      "command": "npx",
      "args": ["tsx", "node_modules/@axon-protocol/chrome-server/src/mcp-stdio.ts"],
      "env": {
        "AXON_HEADLESS": "false"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add axon-chrome -- npx tsx node_modules/@axon-protocol/chrome-server/src/mcp-stdio.ts
```

### Cursor / Windsurf / Any MCP Client

Point your MCP client at the stdio wrapper:

```bash
npx tsx node_modules/@axon-protocol/chrome-server/src/mcp-stdio.ts
```

### Programmatic Usage

```typescript
import { launchChromeServer } from "@axon-protocol/chrome-server";

const { server, browser, store, shutdown } = await launchChromeServer({
  headless: true,
  viewport: { width: 1280, height: 800 },
  allowedDomains: ["*.example.com", "wikipedia.org"],
});

console.log(`${server.toolCount} tools ready`);

// Execute a tool call
const result = await server.execute({
  id: 1,
  tool: "navigate",
  params: { tabId: 0, url: "https://example.com" },
  capability: "",
}, { sessionId: "demo", streamId: 1, reportProgress: () => {}, isCancelled: () => false });

await shutdown();
```

## Tools (14)

### Tab Management
| Tool | Description |
|------|-------------|
| `tabs_list` | List all open browser tabs with IDs, URLs, and titles |
| `tab_create` | Open a new browser tab, optionally navigating to a URL |
| `tab_close` | Close a browser tab by ID |

### Navigation
| Tool | Description |
|------|-------------|
| `navigate` | Navigate to a URL, or use `back`/`forward` for history |

### Capture
| Tool | Description |
|------|-------------|
| `screenshot` | Take a PNG screenshot (full page or element). Stored in OCRS — context gets a ~23 token summary |

### Content Extraction
| Tool | Description |
|------|-------------|
| `get_text` | Extract main text content from the page. Stored in OCRS |
| `read_page` | Get structured accessibility tree (elements, roles, labels) |
| `find` | Find elements by CSS selector or text content |

### Interaction
| Tool | Description |
|------|-------------|
| `click` | Click an element by selector or coordinates |
| `type_text` | Type text into an input element |
| `press_key` | Press a keyboard key (Enter, Tab, Escape, etc.) |
| `scroll` | Scroll the page in any direction |

### Execution
| Tool | Description |
|------|-------------|
| `execute_js` | Execute JavaScript in the page context |

### Viewport
| Tool | Description |
|------|-------------|
| `set_viewport` | Resize viewport (presets: mobile, tablet, desktop) |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AXON_HEADLESS` | Run Chrome in headless mode | `false` |
| `AXON_CHROME_PATH` | Custom Chrome/Chromium executable path | Auto-detect |

## How OCRS Works

When a tool produces a large result (screenshot, page text, DOM tree), it's stored in the Out-of-Context Result Store instead of being injected into the model's context:

```
MCP:  screenshot → 91,800 tokens of raw base64 injected into context
AXON: screenshot → 23 tokens: "Screenshot 1280x800 (359KB) of 'Wikipedia' [ref:ax_r_1]"
```

The model can drill into any reference when it needs the full data. Context stays clean. No overflow.

## Benchmark

Real measurements — 26 tool calls against live public websites (example.com, Wikipedia, httpbin.org):

| Metric | MCP | AXON | Improvement |
|--------|-----|------|-------------|
| Context tokens | 266,660 | 720 | 99.7% reduction |
| Context window | 147% (overflow) | 0.6% | Fits 165x over |
| Wire size | 1,024 KB | 4 KB | 99.6% reduction |

Run the benchmark yourself:

```bash
cd servers/chrome
npx tsx benchmark-real.ts
```

## Security

AXON enforces capability-based security at the tool level:

- **Domain scoping** — restrict navigation to allowed domains via glob patterns
- **Write protection** — `click`, `type_text`, `navigate` require `resource:write` capability
- **TTL expiry** — capabilities auto-expire after a configurable duration
- **Scope attenuation** — capabilities can only be narrowed, never widened

## Related Packages

- [`@axon-protocol/sdk`](https://www.npmjs.com/package/@axon-protocol/sdk) — Core protocol SDK (OCRS, capabilities, server framework, MCP bridge)

## Links

- [GitHub](https://github.com/hchihoub/axon-protocol)
- [npm](https://www.npmjs.com/package/@axon-protocol/chrome-server)

## License

MIT
