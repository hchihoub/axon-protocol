# @axon-protocol/clipboard-server

AXON Clipboard History Server — Cross-platform clipboard management with history, search, and pinning.

## Features

- **Cross-platform** clipboard access (macOS, Linux, Windows)
- **Persistent history** stored at `~/.axon/clipboard-history.json`
- **Pin entries** to prevent eviction when history reaches max size
- **Search** through clipboard history with text matching
- **Zero external dependencies** — uses only Node.js built-ins and system commands

## Platform Support

| Platform | Read Command | Write Command |
|----------|-------------|---------------|
| macOS | `pbpaste` | `pbcopy` |
| Linux | `xclip -selection clipboard -o` | `xclip -selection clipboard` |
| Windows | `Get-Clipboard` (PowerShell) | `Set-Clipboard` (PowerShell) |

## Tools

| Tool | Description | Read-only |
|------|-------------|-----------|
| `get_clipboard` | Get current clipboard content | Yes |
| `set_clipboard` | Set clipboard content | No |
| `get_history` | Get clipboard history (most recent N) | Yes |
| `search_history` | Search clipboard history by text | Yes |
| `pin_entry` | Pin/unpin a clipboard entry | No |
| `clear_history` | Clear clipboard history | No |

## Usage

### As MCP Server (Claude Desktop, Cursor, etc.)

```json
{
  "mcpServers": {
    "clipboard": {
      "command": "npx",
      "args": ["tsx", "src/mcp-stdio.ts"],
      "cwd": "/path/to/servers/clipboard"
    }
  }
}
```

### Programmatic

```typescript
import { launchClipboardServer } from "@axon-protocol/clipboard-server";

const { server, cm } = await launchClipboardServer({
  maxHistory: 200,
});

console.log(`${server.toolCount} tools ready`);
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AXON_CLIPBOARD_MAX_HISTORY` | Maximum history entries | `100` |
| `AXON_CLIPBOARD_HISTORY_PATH` | Custom history file path | `~/.axon/clipboard-history.json` |

## Development

```bash
npm run dev    # Watch mode
npm run build  # Compile TypeScript
npm run mcp    # Start MCP stdio server
```
