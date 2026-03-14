# @axon-protocol/password-manager-server

**AXON Password Manager Server** — 9 tools for automating Chrome's built-in password manager via Puppeteer with Shadow DOM piercing and OCRS integration.

[![npm](https://img.shields.io/npm/v/@axon-protocol/password-manager-server)](https://www.npmjs.com/package/@axon-protocol/password-manager-server)
[![license](https://img.shields.io/npm/l/@axon-protocol/password-manager-server)](https://github.com/hchihoub/axon-protocol/blob/main/LICENSE)

## Why?

Chrome's password manager (`chrome://password-manager`) stores credentials securely but offers no programmatic API. This server automates the password manager UI via Puppeteer, piercing Chrome's nested Shadow DOM to expose 9 tools for listing, searching, adding, editing, deleting, generating, checking, and exporting passwords.

All results go through AXON's Out-of-Context Result Store (OCRS). **Passwords NEVER appear in the model's context window** — they're stored externally and only accessible via targeted retrieval.

## Prerequisites

- **Chrome must be closed** before launching. Puppeteer cannot share a profile directory with a running Chrome instance.
- Chrome/Chromium installed (auto-detected on macOS, Linux, Windows)
- Node.js 18+

## Install

```bash
npm install @axon-protocol/password-manager-server
```

**Peer dependency:** `@axon-protocol/sdk` (installed automatically with npm 7+)

## Quick Start

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "axon-passwords": {
      "command": "npx",
      "args": ["tsx", "node_modules/@axon-protocol/password-manager-server/src/mcp-stdio.ts"],
      "env": {
        "AXON_HEADLESS": "false"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add axon-passwords -- npx tsx node_modules/@axon-protocol/password-manager-server/src/mcp-stdio.ts
```

### Cursor / Windsurf / Any MCP Client

```bash
npx tsx node_modules/@axon-protocol/password-manager-server/src/mcp-stdio.ts
```

### Programmatic Usage

```typescript
import { launchPasswordManagerServer } from "@axon-protocol/password-manager-server";

const { server, pm, shutdown } = await launchPasswordManagerServer({
  headless: false,
  profileName: "Default",
});

console.log(`${server.toolCount} tools ready`);

// List all saved passwords (no password values in response)
const result = await server.execute({
  id: 1,
  tool: "list_passwords",
  params: {},
  capability: "",
}, { sessionId: "demo", streamId: 1, reportProgress: () => {}, isCancelled: () => false });

await shutdown();
```

## Tools (9)

### Reading
| Tool | Description |
|------|-------------|
| `list_passwords` | List all saved passwords (site + username only, never passwords) |
| `search_passwords` | Search by site URL or username |
| `get_password` | Retrieve a specific password (may trigger OS auth) |
| `check_compromised` | Run Chrome's security checkup (compromised, reused, weak) |
| `export_passwords` | Export all passwords as CSV or JSON |

### Writing
| Tool | Description |
|------|-------------|
| `add_password` | Add a new password entry |
| `edit_password` | Modify an existing entry (username, password, note) |
| `delete_password` | Delete a password entry permanently |

### Utility
| Tool | Description |
|------|-------------|
| `generate_password` | Generate a cryptographically strong random password |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AXON_CHROME_PROFILE_DIR` | Chrome user data directory | Auto-detect |
| `AXON_CHROME_PROFILE_NAME` | Chrome profile name | `Default` |
| `AXON_CHROME_PATH` | Custom Chrome executable path | Auto-detect |
| `AXON_HEADLESS` | Run Chrome in headless mode | `false` |

## Security

### Password Protection
- **Summaries NEVER contain passwords.** Password values only exist in OCRS data, never in the model's context window.
- `get_password` and `generate_password` store values in OCRS with redacted summaries.
- `export_passwords` stores the full export in OCRS — summary shows entry count only.

### Capability-Based Access
- Read operations (`list_passwords`, `search_passwords`, etc.) require `resource:read`
- Write operations (`add_password`, `edit_password`, `delete_password`) require `resource:write`
- Capabilities expire after 1 hour (configurable)
- Optional `readOnly` mode disables all write operations

### Chrome Profile
- Launches Chrome with `--user-data-dir` pointing to your actual Chrome profile
- Saved passwords, cookies, and settings are available
- `--password-store=basic` reduces OS keychain prompts where possible
- Some operations (reveal password, export) may still trigger OS authentication

## How It Works

1. **Puppeteer launches Chrome** with your actual profile directory
2. **Navigates to `chrome://password-manager/passwords`** (Chrome's built-in password manager)
3. **Pierces Shadow DOM** — Chrome settings pages use deeply nested Web Components with shadow roots
4. **Extracts data** — recursively traverses shadow roots to find password entries, buttons, and forms
5. **OCRS integration** — large results stored externally, model gets compact summaries

### Shadow DOM Piercing

Chrome's internal pages use Polymer/Lit web components with nested shadow roots:

```
password-manager-app
  └── #shadowRoot
       └── passwords-section
            └── #shadowRoot
                 └── password-list-item (×N)
                      └── #shadowRoot
                           └── site, username, actions
```

The server uses recursive shadow root traversal to find elements regardless of nesting depth.

## Limitations

- **Chrome must be closed** — Puppeteer can't share a profile directory with a running instance
- **Shadow DOM selectors** — Chrome updates may change internal element structure. The server uses flexible matching strategies but may need updates for major Chrome releases.
- **OS authentication** — Revealing passwords or exporting may trigger Touch ID / system password prompts
- **Headless mode** — Some password manager operations may not work in headless mode

## Related Packages

- [`@axon-protocol/sdk`](https://www.npmjs.com/package/@axon-protocol/sdk) — Core protocol SDK
- [`@axon-protocol/chrome-server`](https://www.npmjs.com/package/@axon-protocol/chrome-server) — General browser automation tools

## Links

- [GitHub](https://github.com/hchihoub/axon-protocol)
- [npm](https://www.npmjs.com/package/@axon-protocol/password-manager-server)

## License

MIT
