# @axon-protocol/filesystem-server

AXON File System Server -- safe file system operations via Node.js `fs` and `path` with configurable root directory and path traversal protection.

## Tools (10)

| Tool | Description | Capabilities |
|------|-------------|-------------|
| `list_directory` | List files/dirs with metadata (size, modified, type) | read |
| `read_file` | Read file contents (text or binary as base64) | read |
| `write_file` | Write content to a file | write |
| `create_directory` | Create a directory (recursive) | write |
| `move` | Move or rename a file or directory | write |
| `copy` | Copy a file or directory | write |
| `delete` | Delete a file or directory | write |
| `search_files` | Search files by glob pattern | read |
| `get_file_info` | Get detailed metadata (size, permissions, timestamps) | read |
| `find_text` | Search for text content within files (grep-like) | read |

## Security

- All paths are validated against a configurable root directory
- Path traversal via `../` is blocked
- Binary file contents are stored in OCRS; summaries show only file size
- Read file summaries show a preview (first 100 chars), not full content

## Configuration

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `AXON_FS_ROOT` | Root directory for all operations | Home directory |

## Usage

### MCP Server (stdio)

```bash
AXON_FS_ROOT=/home/user/projects npx tsx src/mcp-stdio.ts
```

### Programmatic

```typescript
import { launchFileSystemServer } from "@axon-protocol/filesystem-server";

const { server, fsm } = await launchFileSystemServer({
  rootDir: "/home/user/projects",
});

console.log(`${server.toolCount} tools ready`);
```

## Development

```bash
npm install
npm run build
npm run dev
```
