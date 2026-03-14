# @axon-protocol/bookmarks-manager-server

AXON Bookmarks Manager Server — Automate Chrome's built-in bookmarks page (`chrome://bookmarks`) via Puppeteer with Shadow DOM piercing and OCRS integration.

## Tools

| Tool | Description | Write |
|------|-------------|-------|
| `list_bookmarks` | List all bookmarks and folders | |
| `search_bookmarks` | Search bookmarks by title/URL | |
| `add_bookmark` | Add a new bookmark | Yes |
| `edit_bookmark` | Edit bookmark title/URL | Yes |
| `delete_bookmark` | Delete a bookmark | Yes |
| `create_folder` | Create a bookmark folder | Yes |
| `export_bookmarks` | Export as HTML/JSON | |

## Usage

### MCP (Claude Desktop, Cursor, etc.)

```json
{
  "mcpServers": {
    "axon-bookmarks": {
      "command": "npx",
      "args": ["tsx", "src/mcp-stdio.ts"],
      "cwd": "/path/to/servers/bookmarks-manager",
      "env": {
        "AXON_HEADLESS": "false"
      }
    }
  }
}
```

### Programmatic

```typescript
import { launchBookmarksManagerServer } from "@axon-protocol/bookmarks-manager-server";

const { server, bm, shutdown } = await launchBookmarksManagerServer();
console.log(`${server.toolCount} tools ready`);

await shutdown();
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AXON_CHROME_PROFILE_DIR` | Chrome user data directory | Auto-detected |
| `AXON_CHROME_PROFILE_NAME` | Chrome profile name | `Default` |
| `AXON_CHROME_PATH` | Chrome executable path | Auto-detected |
| `AXON_HEADLESS` | Run headlessly | `false` |

## Prerequisites

- Chrome must be fully closed before launching
- Node.js 18+
- `@axon-protocol/sdk` peer dependency
