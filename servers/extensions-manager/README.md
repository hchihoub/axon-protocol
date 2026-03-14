# @axon-protocol/extensions-manager-server

AXON Extensions Manager Server — Automate Chrome's extensions page (`chrome://extensions`) via Puppeteer with Shadow DOM piercing and OCRS integration.

## Tools

| Tool | Description | Write |
|------|-------------|-------|
| `list_extensions` | List all installed extensions with status | |
| `get_extension_details` | Get detailed info about an extension | |
| `toggle_extension` | Enable/disable an extension | Yes |
| `search_extensions` | Search installed extensions | |
| `get_extension_permissions` | View permissions for an extension | |
| `remove_extension` | Remove an extension | Yes |

## Usage

### MCP (Claude Desktop, Cursor, etc.)

```json
{
  "mcpServers": {
    "axon-extensions": {
      "command": "npx",
      "args": ["tsx", "src/mcp-stdio.ts"],
      "cwd": "/path/to/servers/extensions-manager",
      "env": {
        "AXON_HEADLESS": "false"
      }
    }
  }
}
```

### Programmatic

```typescript
import { launchExtensionsManagerServer } from "@axon-protocol/extensions-manager-server";

const { server, em, shutdown } = await launchExtensionsManagerServer();
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
