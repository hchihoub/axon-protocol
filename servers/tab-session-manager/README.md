# @axon-protocol/tab-session-manager-server

AXON Tab Session Manager Server — Manage browser tabs, tab groups, and saved sessions via Puppeteer.

## Features

- **Tab Management**: List, open, close, and switch browser tabs via Puppeteer's built-in APIs
- **Session Persistence**: Save and restore tab sessions to/from `~/.axon/tab-sessions.json`
- **Chrome Profile Support**: Auto-detects Chrome profiles on macOS, Linux, and Windows
- **MCP Compatible**: Works with Claude Desktop, Cursor, Windsurf, and any MCP client

## Tools (8)

| Tool | Description | Read-Only |
|------|-------------|-----------|
| `list_tabs` | List all open tabs with titles and URLs | Yes |
| `open_tab` | Open a new tab with optional URL | No |
| `close_tab` | Close a tab by index or URL match | No |
| `switch_tab` | Bring a tab to focus | No |
| `save_session` | Save current tabs as a named session | No |
| `restore_session` | Restore a saved session (open all tabs) | No |
| `list_sessions` | List all saved sessions | Yes |
| `delete_session` | Delete a saved session | No |

## Quick Start

```bash
# Install dependencies
npm install

# Run as MCP server (stdio)
npm run mcp

# Run directly
npm start
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AXON_CHROME_PROFILE_DIR` | Chrome user data directory | Auto-detected |
| `AXON_CHROME_PROFILE_NAME` | Chrome profile name | `Default` |
| `AXON_CHROME_PATH` | Chrome executable path | Auto-detected |
| `AXON_HEADLESS` | Run in headless mode | `false` |

## MCP Configuration

Add to your Claude Desktop or Cursor config:

```json
{
  "mcpServers": {
    "axon-tabs": {
      "command": "npx",
      "args": ["tsx", "/path/to/servers/tab-session-manager/src/mcp-stdio.ts"]
    }
  }
}
```

## Programmatic Usage

```typescript
import { launchTabSessionManagerServer } from "@axon-protocol/tab-session-manager-server";

const { server, tsm, shutdown } = await launchTabSessionManagerServer();

// List tabs
const result = await server.execute({
  id: 1,
  tool: "list_tabs",
  params: {},
  capability: "",
}, { sessionId: "demo", streamId: 1, reportProgress: () => {}, isCancelled: () => false });

await shutdown();
```

## Important

Chrome must be fully closed before launching. Puppeteer cannot share a profile directory with a running Chrome instance.

## License

MIT
