# @axon-protocol/network-scanner-server

AXON Network Scanner Server — Scan local networks, ports, DNS, and connectivity using Node.js built-in modules.

## Overview

This server provides 7 tools for network scanning and diagnostics. It uses Node.js `net` module for port scanning, `dns` module for DNS lookups, `http`/`https` for URL checks, and system commands (`arp`, `ping`, `traceroute`) for network discovery and diagnostics.

All system commands use `execFile` (not `exec`) to prevent shell injection attacks. All tools are read-only.

## Tools

| Tool | Description |
|------|-------------|
| `scan_ports` | Scan TCP ports on a host (configurable range, max 10k ports) |
| `get_local_devices` | List devices on local network using ARP table |
| `dns_lookup` | DNS resolution (A, AAAA, MX, TXT, CNAME, NS, SOA) |
| `ping_host` | Ping a host and report latency/packet loss |
| `get_network_interfaces` | List local network interfaces with IPs |
| `check_url` | Check if a URL is reachable (HTTP HEAD) |
| `traceroute` | Trace network path to a host |

## Usage

### As MCP Server (Claude Desktop, Cursor, etc.)

```json
{
  "mcpServers": {
    "network-scanner": {
      "command": "npx",
      "args": ["tsx", "/path/to/servers/network-scanner/src/mcp-stdio.ts"]
    }
  }
}
```

### Programmatic

```typescript
import { launchNetworkScannerServer } from "@axon-protocol/network-scanner-server";

const { server, scanner } = await launchNetworkScannerServer();
console.log(`${server.toolCount} tools ready`);
```

## Implementation Details

- **Port scanning**: Uses `net.Socket` with configurable timeout and concurrency (default 100 concurrent connections). Reports open/closed/filtered states with well-known service names.
- **DNS lookups**: Uses `dns.promises` for async resolution. Supports A, AAAA, MX, TXT, CNAME, NS, SOA record types.
- **URL checks**: Uses `http`/`https` HEAD requests with configurable timeout. Reports status, headers, latency, and redirects.
- **Local devices**: Parses `arp -a` output for IP/MAC/hostname discovery.
- **Ping**: Uses system `ping` command with configurable count and timeout.
- **Traceroute**: Uses system `traceroute` with configurable max hops.

## Development

```bash
npm run dev    # Watch mode
npm run build  # Compile TypeScript
npm run mcp    # Start MCP stdio server
```
