# @axon-protocol/env-vault-server

AXON ENV/Secrets Vault Server — Manage `.env` files across projects with secret detection and value masking.

## Overview

This server provides 7 tools for managing environment files across projects. It scans directories for `.env*` files, parses them, detects potential leaked secrets using known API key patterns, and compares env files across environments.

## Security

- **Values are MASKED by default** in all listings (shown as `****`)
- Only `get_env_value` returns actual values, stored in OCRS only
- Secret detection uses regex patterns for known API key formats (AWS, GitHub, Stripe, Google, Slack, JWT, database URLs)
- Summarizers NEVER include secret values
- Comparison results show masked values only

## Tools

| Tool | Description | Capabilities |
|------|-------------|-------------|
| `scan_env_files` | Scan a directory tree for all .env files | read |
| `read_env` | Read an .env file (values masked by default) | read |
| `get_env_value` | Get a specific env variable value | read |
| `set_env_value` | Set/update a variable in an .env file | write |
| `delete_env_value` | Remove a variable from an .env file | write |
| `detect_secrets` | Scan files for potential secrets | read |
| `compare_envs` | Compare two .env files | read |

## Usage

### As MCP Server (Claude Desktop, Cursor, etc.)

```json
{
  "mcpServers": {
    "env-vault": {
      "command": "npx",
      "args": ["tsx", "/path/to/servers/env-vault/src/mcp-stdio.ts"],
      "env": {
        "AXON_VAULT_ROOT": "/path/to/projects"
      }
    }
  }
}
```

### Programmatic

```typescript
import { launchEnvVaultServer } from "@axon-protocol/env-vault-server";

const { server, manager } = await launchEnvVaultServer({ rootDir: "/projects" });
console.log(`${server.toolCount} tools ready`);
```

## Secret Detection Patterns

The `detect_secrets` tool recognizes:

- **AWS**: Access keys (`AKIA...`), secret keys
- **GitHub**: Personal access tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`)
- **Stripe**: Secret keys (`sk_live_`, `sk_test_`), publishable keys (`pk_live_`)
- **Google**: API keys (`AIza...`)
- **Slack**: Tokens (`xox[bpors]-...`), webhooks
- **JWT**: JSON Web Tokens (`eyJ...`)
- **Database URLs**: PostgreSQL, MySQL, MongoDB, Redis connection strings
- **Generic**: API keys, secrets, passwords, tokens

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AXON_VAULT_ROOT` | Root directory for scanning | `cwd` |

## Development

```bash
npm run dev    # Watch mode
npm run build  # Compile TypeScript
npm run mcp    # Start MCP stdio server
```
