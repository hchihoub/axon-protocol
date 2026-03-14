/**
 * AXON System Monitor Server — Tool Definitions
 *
 * 7 system monitoring tools registered with AXON's 3-tier discovery:
 *   Tier 1: Compact manifests (~20 tokens/tool) — always in context
 *   Tier 2: Full schemas — fetched on demand when model calls a tool
 *
 * Results go through OCRS:
 *   - System info → stored in OCRS, summary shows key stats
 *   - Process lists → stored in OCRS, summary shows count and top processes
 *
 * Capabilities enforce access:
 *   - "resource:read" for system info, CPU, memory, disk, processes, network
 *   - "resource:write" for kill_process
 */

import { AxonServer, ResultStore, CapabilityAuthority } from "@axon-protocol/sdk";
import { SystemMonitor } from "./system-monitor.js";

export interface SystemMonitorServerConfig {
  /** Restrict to read-only operations */
  readOnly?: boolean;
}

export function createSystemMonitorServer(
  sm: SystemMonitor,
  config?: SystemMonitorServerConfig,
): {
  server: AxonServer;
  store: ResultStore;
  capAuthority: CapabilityAuthority;
} {
  const server = new AxonServer({ name: "axon-system-monitor", version: "0.1.0" });
  const store = new ResultStore({ max_summary_tokens: 300, max_total_result_tokens: 6000 });

  const key = Buffer.alloc(32);
  Buffer.from(Date.now().toString(16).padStart(32, "0"), "hex").copy(key);
  const capAuthority = new CapabilityAuthority("axon-system-monitor", key, key);

  // ==========================================================================
  // Get System Info
  // ==========================================================================

  server.tool({
    id: "get_system_info",
    summary: "Get OS, CPU, memory, architecture, uptime",
    description:
      "Get general system information including hostname, operating system, CPU model, core count, total and free memory, system uptime, and architecture. Uses Node.js os module.",
    category: "system",
    tags: ["system", "info", "os", "cpu", "memory", "uptime"],
    input: {
      type: "object",
      properties: {},
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 100,
      max_result_size_bytes: 2000,
    },
    handler: async () => {
      return sm.getSystemInfo();
    },
    summarizer: (info: any) => {
      return `${info.osType} ${info.osRelease} | ${info.cpuModel} (${info.cpuCores} cores) | ${info.totalMemoryMB} MB RAM | Uptime: ${info.uptimeFormatted}`;
    },
  });

  // ==========================================================================
  // Get CPU Usage
  // ==========================================================================

  server.tool({
    id: "get_cpu_usage",
    summary: "Get CPU usage and load averages",
    description:
      "Get current CPU usage including per-core timing breakdown (user, system, idle) and system load averages (1min, 5min, 15min). Uses Node.js os.cpus() and os.loadavg().",
    category: "system",
    tags: ["cpu", "usage", "load", "cores"],
    input: {
      type: "object",
      properties: {},
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 100,
      max_result_size_bytes: 20_000,
    },
    handler: async () => {
      return sm.getCpuUsage();
    },
    summarizer: (usage: any) => {
      const load = usage.loadAverage;
      return `${usage.cores} cores | Load: ${load["1min"]} (1m), ${load["5min"]} (5m), ${load["15min"]} (15m)`;
    },
  });

  // ==========================================================================
  // Get Memory Usage
  // ==========================================================================

  server.tool({
    id: "get_memory_usage",
    summary: "Get RAM usage (total, free, used, percent)",
    description:
      "Get current memory (RAM) usage including total, free, and used memory in megabytes, plus usage percentages. Uses Node.js os.totalmem() and os.freemem().",
    category: "system",
    tags: ["memory", "ram", "usage"],
    input: {
      type: "object",
      properties: {},
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 100,
      max_result_size_bytes: 500,
    },
    handler: async () => {
      return sm.getMemoryUsage();
    },
    summarizer: (mem: any) => {
      return `RAM: ${mem.usedMB} MB / ${mem.totalMB} MB (${mem.usedPercent}% used, ${mem.freeMB} MB free)`;
    },
  });

  // ==========================================================================
  // Get Disk Usage
  // ==========================================================================

  server.tool({
    id: "get_disk_usage",
    summary: "Get disk space per mount point",
    description:
      "Get disk space usage for each mount point / drive. Shows filesystem, total, used, and available space in gigabytes. On macOS/Linux uses df command, on Windows uses PowerShell Get-PSDrive.",
    category: "system",
    tags: ["disk", "storage", "space", "filesystem"],
    input: {
      type: "object",
      properties: {},
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 1000,
      max_result_size_bytes: 10_000,
    },
    handler: async () => {
      return sm.getDiskUsage();
    },
    summarizer: (result: any) => {
      if (!result || !result.mounts || result.mounts.length === 0) return "No disk information available";
      const parts = result.mounts
        .slice(0, 3)
        .map((m: any) => `${m.mountpoint}: ${m.usedGB}/${m.totalGB} GB (${m.usedPercent}%)`)
        .join(", ");
      return `${result.mounts.length} mount(s): ${parts}`;
    },
  });

  // ==========================================================================
  // List Processes
  // ==========================================================================

  server.tool({
    id: "list_processes",
    summary: "List running processes (PID, name, CPU%, memory%)",
    description:
      "List running processes with their PID, process name, CPU usage, and memory usage. Sorted by CPU usage by default. On macOS/Linux uses ps command, on Windows uses PowerShell Get-Process.",
    category: "system",
    tags: ["process", "list", "running", "pid", "cpu", "memory"],
    input: {
      type: "object",
      properties: {
        sortBy: {
          type: "string",
          description: "Sort processes by: 'cpu' (default), 'memory', 'pid', or 'name'",
          enum: ["cpu", "memory", "pid", "name"],
        },
        limit: {
          type: "number",
          description: "Maximum number of processes to return (default: 50)",
        },
      },
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 2000,
      max_result_size_bytes: 200_000,
    },
    handler: async ({ sortBy, limit }: any) => {
      return sm.listProcesses({
        sortBy: sortBy ?? "cpu",
        limit: Math.min(200, Math.max(1, limit ?? 50)),
      });
    },
    summarizer: (result: any) => {
      if (!result || result.total === 0) return "No processes found";
      const top = result.processes
        .slice(0, 5)
        .map((p: any) => `${p.name} (${p.cpu}%)`)
        .join(", ");
      return `${result.processes.length} of ${result.total} processes. Top CPU: ${top}`;
    },
  });

  // ==========================================================================
  // Get Network Info
  // ==========================================================================

  server.tool({
    id: "get_network_info",
    summary: "Get network interfaces, IPs, MAC addresses",
    description:
      "Get information about all network interfaces including IP addresses (IPv4 and IPv6), netmasks, MAC addresses, and whether the interface is internal (loopback). Uses Node.js os.networkInterfaces().",
    category: "system",
    tags: ["network", "interfaces", "ip", "mac", "address"],
    input: {
      type: "object",
      properties: {},
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 100,
      max_result_size_bytes: 20_000,
    },
    handler: async () => {
      return sm.getNetworkInfo();
    },
    summarizer: (result: any) => {
      if (!result || !result.interfaces || result.interfaces.length === 0) return "No network interfaces found";
      const external = result.interfaces
        .flatMap((i: any) => i.addresses)
        .filter((a: any) => !a.internal && a.family === "IPv4");
      const ips = external.map((a: any) => a.address).join(", ");
      return `${result.interfaces.length} interface(s)${ips ? `, External IPs: ${ips}` : ""}`;
    },
  });

  // ==========================================================================
  // Kill Process
  // ==========================================================================

  server.tool({
    id: "kill_process",
    summary: "Kill a process by PID",
    description:
      "Send a signal to terminate a process by its PID. Default signal is SIGTERM. Use SIGKILL for force-kill. Requires write capability. This action is irreversible.",
    category: "system",
    tags: ["process", "kill", "terminate", "signal"],
    input: {
      type: "object",
      properties: {
        pid: {
          type: "number",
          description: "Process ID (PID) of the process to kill",
        },
        signal: {
          type: "string",
          description: "Signal to send: 'SIGTERM' (default, graceful) or 'SIGKILL' (force)",
          enum: ["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"],
        },
      },
      required: ["pid"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: false,
      estimated_latency_ms: 500,
      max_result_size_bytes: 500,
    },
    handler: async ({ pid, signal }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return sm.killProcess(pid, signal);
    },
    summarizer: (result: any) => {
      return result.killed
        ? `Sent ${result.signal} to PID ${result.pid}`
        : `Failed to kill PID ${result.pid}`;
    },
  });

  return { server, store, capAuthority };
}
