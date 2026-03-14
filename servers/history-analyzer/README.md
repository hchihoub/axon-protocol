# @axon-protocol/history-analyzer-server

AXON History Analyzer Server — Automate Chrome's browsing history page (`chrome://history`) via Puppeteer with Shadow DOM piercing and OCRS integration.

## Tools

| Tool | Description | Write |
|------|-------------|-------|
| `search_history` | Search browsing history by keyword/URL | |
| `get_recent_history` | Get recent N entries | |
| `get_history_by_date` | Get history for a specific date range | |
| `delete_history_entry` | Delete a specific history entry | Yes |
| `clear_history` | Clear history for a date range | Yes |
| `get_most_visited` | Get most frequently visited sites | |

## Usage

### MCP (Claude Desktop, Cursor, etc.)

```json
{
  "mcpServers": {
    "axon-history": {
      "command": "npx",
      "args": ["tsx", "src/mcp-stdio.ts"],
      "cwd": "/path/to/servers/history-analyzer",
      "env": {
        "AXON_HEADLESS": "false"
      }
    }
  }
}
```

### Programmatic

```typescript
import { launchHistoryAnalyzerServer } from "@axon-protocol/history-analyzer-server";

const { server, ha, shutdown } = await launchHistoryAnalyzerServer();
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
