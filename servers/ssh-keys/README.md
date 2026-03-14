# @axon-protocol/ssh-keys-server

AXON SSH Key Manager Server — Manage SSH keys and `~/.ssh/config` with secure key operations.

## Overview

This server provides 7 tools for managing SSH keys and SSH config entries. It uses Node.js `fs` APIs and `ssh-keygen`/`ssh` system commands. All system commands use `execFile` (not `exec`) to prevent shell injection.

## Security

- **Private key contents are NEVER read or exposed** — only public keys are accessible
- All file operations are scoped to `~/.ssh/`
- Path traversal is blocked
- Summarizers never include key material
- Private key paths are referenced but content never read

## Tools

| Tool | Description | Capabilities |
|------|-------------|-------------|
| `list_keys` | List all SSH keys in ~/.ssh/ (public keys only) | read |
| `generate_key` | Generate a new SSH key pair using ssh-keygen | write |
| `get_public_key` | Read a public key file content | read |
| `delete_key` | Delete an SSH key pair | write |
| `list_hosts` | Parse and list hosts from ~/.ssh/config | read |
| `add_host` | Add a host entry to ~/.ssh/config | write |
| `test_connection` | Test SSH connection to a host | read |

## Usage

### As MCP Server (Claude Desktop, Cursor, etc.)

```json
{
  "mcpServers": {
    "ssh-keys": {
      "command": "npx",
      "args": ["tsx", "/path/to/servers/ssh-keys/src/mcp-stdio.ts"],
      "env": {
        "AXON_SSH_DIR": "~/.ssh"
      }
    }
  }
}
```

### Programmatic

```typescript
import { launchSSHKeyServer } from "@axon-protocol/ssh-keys-server";

const { server, manager } = await launchSSHKeyServer();
console.log(`${server.toolCount} tools ready`);
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AXON_SSH_DIR` | SSH directory path | `~/.ssh` |

## Development

```bash
npm run dev    # Watch mode
npm run build  # Compile TypeScript
npm run mcp    # Start MCP stdio server
```
