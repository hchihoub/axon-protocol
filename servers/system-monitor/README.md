# @axon-protocol/system-monitor-server

AXON System Monitor Server — Monitor system resources (CPU, memory, disk, processes, network) using Node.js os module and system commands.

## Features

- **CPU monitoring** — model, core count, load averages, per-core usage
- **Memory monitoring** — total, free, used RAM with percentages
- **Disk monitoring** — space usage per mount point / drive
- **Process management** — list and kill running processes
- **Network info** — interfaces, IPs, MAC addresses
- **Zero external dependencies** — uses only Node.js `os` module and system commands

## Platform Support

| Feature | macOS / Linux | Windows |
|---------|--------------|---------|
| System Info | `os` module | `os` module |
| CPU Usage | `os.cpus()`, `os.loadavg()` | `os.cpus()`, `os.loadavg()` |
| Memory | `os.totalmem()`, `os.freemem()` | `os.totalmem()`, `os.freemem()` |
| Disk Usage | `df -k` | PowerShell `Get-PSDrive` |
| Processes | `ps -axo pid,comm,%cpu,%mem` | PowerShell `Get-Process` |
| Network | `os.networkInterfaces()` | `os.networkInterfaces()` |
| Kill Process | `process.kill()` | `process.kill()` |

## Tools

| Tool | Description | Read-only |
|------|-------------|-----------|
| `get_system_info` | OS, CPU, memory, architecture, uptime | Yes |
| `get_cpu_usage` | CPU usage and load averages | Yes |
| `get_memory_usage` | RAM usage (total, free, used, percent) | Yes |
| `get_disk_usage` | Disk space per mount point | Yes |
| `list_processes` | List running processes | Yes |
| `get_network_info` | Network interfaces, IPs, MAC addresses | Yes |
| `kill_process` | Kill a process by PID | No |

## Usage

### As MCP Server (Claude Desktop, Cursor, etc.)

```json
{
  "mcpServers": {
    "system-monitor": {
      "command": "npx",
      "args": ["tsx", "src/mcp-stdio.ts"],
      "cwd": "/path/to/servers/system-monitor"
    }
  }
}
```

### Programmatic

```typescript
import { launchSystemMonitorServer } from "@axon-protocol/system-monitor-server";

const { server, sm } = await launchSystemMonitorServer();
console.log(`${server.toolCount} tools ready`);
```

## Development

```bash
npm run dev    # Watch mode
npm run build  # Compile TypeScript
npm run mcp    # Start MCP stdio server
```
