# @axon-protocol/cookie-manager-server

AXON Cookie Manager Server — Manage browser cookies via Puppeteer CDP with Shadow DOM piercing.

## Features

- **CDP-Based Operations**: Uses Chrome DevTools Protocol for reliable cookie CRUD via `Network.getCookies`, `Network.setCookie`, `Network.deleteCookies`
- **Shadow DOM Piercing**: Can navigate `chrome://settings/cookies` through nested shadow roots
- **Security First**: Cookie values NEVER appear in OCRS summaries — only in full data
- **Chrome Profile Support**: Auto-detects Chrome profiles on macOS, Linux, and Windows
- **MCP Compatible**: Works with Claude Desktop, Cursor, Windsurf, and any MCP client

## Tools (7)

| Tool | Description | Read-Only |
|------|-------------|-----------|
| `list_cookies` | List all cookies (optionally filter by domain) | Yes |
| `search_cookies` | Search cookies by name/domain/value | Yes |
| `get_cookie` | Get a specific cookie by name and domain | Yes |
| `set_cookie` | Set/update a cookie | No |
| `delete_cookie` | Delete a specific cookie | No |
| `clear_cookies` | Clear all cookies for a domain | No |
| `export_cookies` | Export cookies as JSON | Yes |

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
    "axon-cookies": {
      "command": "npx",
      "args": ["tsx", "/path/to/servers/cookie-manager/src/mcp-stdio.ts"]
    }
  }
}
```

## Programmatic Usage

```typescript
import { launchCookieManagerServer } from "@axon-protocol/cookie-manager-server";

const { server, cm, shutdown } = await launchCookieManagerServer();

// List cookies for a domain
const result = await server.execute({
  id: 1,
  tool: "list_cookies",
  params: { domain: "github.com" },
  capability: "",
}, { sessionId: "demo", streamId: 1, reportProgress: () => {}, isCancelled: () => false });

await shutdown();
```

## Security

Cookie values are treated as sensitive data:
- Values are stored in OCRS data only
- Summarizers NEVER include cookie values
- The model's context window never sees raw cookie values

## Important

Chrome must be fully closed before launching. Puppeteer cannot share a profile directory with a running Chrome instance.

## License

MIT
