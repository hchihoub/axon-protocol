# @axon-protocol/screenshot-server

AXON Screenshot Server — Cross-platform screen capture with screenshot management and base64 encoding.

## Features

- **Cross-platform** screen capture (macOS, Linux, Windows)
- **Full screen** and **region** capture
- **Window capture** by title
- **Screenshot management** — list, retrieve, delete
- **Base64 encoding** for MCP image content
- **Zero external dependencies** — uses only Node.js built-ins and system commands

## Platform Support

| Platform | Full Screen | Region | Window |
|----------|------------|--------|--------|
| macOS | `screencapture -x` | `screencapture -R` | `screencapture -l` |
| Linux | `import` / `gnome-screenshot` / `scrot` | `import -crop` / `scrot -a` | `xdotool` + `import` |
| Windows | PowerShell `CopyFromScreen` | PowerShell `CopyFromScreen` | PowerShell `FindWindow` |

## Tools

| Tool | Description | Read-only |
|------|-------------|-----------|
| `take_screenshot` | Capture full screen or region | No |
| `list_screenshots` | List saved screenshots | Yes |
| `get_screenshot` | Read a screenshot as base64 | Yes |
| `delete_screenshot` | Delete a saved screenshot | No |
| `capture_window` | Capture a specific window by title | No |

## Usage

### As MCP Server (Claude Desktop, Cursor, etc.)

```json
{
  "mcpServers": {
    "screenshot": {
      "command": "npx",
      "args": ["tsx", "src/mcp-stdio.ts"],
      "cwd": "/path/to/servers/screenshot"
    }
  }
}
```

### Programmatic

```typescript
import { launchScreenshotServer } from "@axon-protocol/screenshot-server";

const { server, sm } = await launchScreenshotServer({
  screenshotDir: "/tmp/screenshots",
});

console.log(`${server.toolCount} tools ready`);
```

## Storage

Screenshots are saved as PNG files in `~/.axon/screenshots/` by default. Each file is named with the capture type, timestamp, and a random suffix to prevent collisions.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AXON_SCREENSHOT_DIR` | Custom screenshot storage directory | `~/.axon/screenshots/` |

## Development

```bash
npm run dev    # Watch mode
npm run build  # Compile TypeScript
npm run mcp    # Start MCP stdio server
```
