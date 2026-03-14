/**
 * AXON System Monitor — Core Implementation
 *
 * Monitors system resources using Node.js `os` module and system commands:
 *   - CPU: os.cpus(), os.loadavg()
 *   - Memory: os.freemem(), os.totalmem()
 *   - Disk: df (macOS/Linux), wmic (Windows)
 *   - Processes: ps (macOS/Linux), tasklist (Windows)
 *   - Network: os.networkInterfaces()
 *
 * No external npm dependencies — uses only Node.js built-ins and system commands.
 */

import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ============================================================================
// Types
// ============================================================================

export interface SystemInfo {
  hostname: string;
  platform: string;
  arch: string;
  osType: string;
  osRelease: string;
  cpuModel: string;
  cpuCores: number;
  totalMemoryMB: number;
  freeMemoryMB: number;
  uptimeSeconds: number;
  uptimeFormatted: string;
  nodeVersion: string;
}

export interface CpuUsage {
  model: string;
  cores: number;
  loadAverage: {
    "1min": number;
    "5min": number;
    "15min": number;
  };
  perCore: Array<{
    core: number;
    user: number;
    nice: number;
    sys: number;
    idle: number;
    irq: number;
  }>;
}

export interface MemoryUsage {
  totalMB: number;
  freeMB: number;
  usedMB: number;
  usedPercent: number;
  freePercent: number;
}

export interface DiskUsage {
  mounts: Array<{
    filesystem: string;
    mountpoint: string;
    totalGB: number;
    usedGB: number;
    availableGB: number;
    usedPercent: number;
  }>;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cpu: string;
  memory: string;
}

export interface ProcessList {
  processes: ProcessInfo[];
  total: number;
}

export interface NetworkInfo {
  interfaces: Array<{
    name: string;
    addresses: Array<{
      address: string;
      netmask: string;
      family: string;
      mac: string;
      internal: boolean;
    }>;
  }>;
}

// ============================================================================
// SystemMonitor
// ============================================================================

export class SystemMonitor {
  // --------------------------------------------------------------------------
  // System Info
  // --------------------------------------------------------------------------

  /**
   * Get general system information: OS, CPU, memory, architecture, uptime.
   */
  getSystemInfo(): SystemInfo {
    const cpus = os.cpus();
    const uptimeSeconds = os.uptime();

    return {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      osType: os.type(),
      osRelease: os.release(),
      cpuModel: cpus.length > 0 ? cpus[0].model : "Unknown",
      cpuCores: cpus.length,
      totalMemoryMB: Math.round(os.totalmem() / (1024 * 1024)),
      freeMemoryMB: Math.round(os.freemem() / (1024 * 1024)),
      uptimeSeconds,
      uptimeFormatted: this.formatUptime(uptimeSeconds),
      nodeVersion: process.version,
    };
  }

  // --------------------------------------------------------------------------
  // CPU Usage
  // --------------------------------------------------------------------------

  /**
   * Get current CPU usage and load averages.
   */
  getCpuUsage(): CpuUsage {
    const cpus = os.cpus();
    const loadavg = os.loadavg();

    const perCore = cpus.map((cpu, i) => ({
      core: i,
      user: cpu.times.user,
      nice: cpu.times.nice,
      sys: cpu.times.sys,
      idle: cpu.times.idle,
      irq: cpu.times.irq,
    }));

    return {
      model: cpus.length > 0 ? cpus[0].model : "Unknown",
      cores: cpus.length,
      loadAverage: {
        "1min": Math.round(loadavg[0] * 100) / 100,
        "5min": Math.round(loadavg[1] * 100) / 100,
        "15min": Math.round(loadavg[2] * 100) / 100,
      },
      perCore,
    };
  }

  // --------------------------------------------------------------------------
  // Memory Usage
  // --------------------------------------------------------------------------

  /**
   * Get RAM usage (total, free, used, percent).
   */
  getMemoryUsage(): MemoryUsage {
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const usedBytes = totalBytes - freeBytes;

    const totalMB = Math.round(totalBytes / (1024 * 1024));
    const freeMB = Math.round(freeBytes / (1024 * 1024));
    const usedMB = Math.round(usedBytes / (1024 * 1024));

    return {
      totalMB,
      freeMB,
      usedMB,
      usedPercent: Math.round((usedBytes / totalBytes) * 10000) / 100,
      freePercent: Math.round((freeBytes / totalBytes) * 10000) / 100,
    };
  }

  // --------------------------------------------------------------------------
  // Disk Usage
  // --------------------------------------------------------------------------

  /**
   * Get disk space per mount point.
   */
  async getDiskUsage(): Promise<DiskUsage> {
    const platform = process.platform;

    if (platform === "darwin" || platform === "linux") {
      return this.getDiskUsageUnix();
    }

    if (platform === "win32") {
      return this.getDiskUsageWindows();
    }

    throw new Error(`Unsupported platform: ${platform}`);
  }

  private async getDiskUsageUnix(): Promise<DiskUsage> {
    const { stdout } = await execFileAsync("df", ["-k"]);
    const lines = stdout.trim().split("\n").slice(1); // Skip header

    const mounts = lines
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 6) return null;

        const filesystem = parts[0];
        const totalKB = parseInt(parts[1], 10);
        const usedKB = parseInt(parts[2], 10);
        const availableKB = parseInt(parts[3], 10);
        const usedPercentStr = parts[4];
        const mountpoint = parts.slice(5).join(" ");

        // Skip pseudo-filesystems
        if (filesystem.startsWith("/dev/") || mountpoint === "/") {
          return {
            filesystem,
            mountpoint,
            totalGB: Math.round((totalKB / (1024 * 1024)) * 100) / 100,
            usedGB: Math.round((usedKB / (1024 * 1024)) * 100) / 100,
            availableGB: Math.round((availableKB / (1024 * 1024)) * 100) / 100,
            usedPercent: parseInt(usedPercentStr.replace("%", ""), 10) || 0,
          };
        }
        return null;
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);

    return { mounts };
  }

  private async getDiskUsageWindows(): Promise<DiskUsage> {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{N='TotalGB';E={[math]::Round($_.Used/1GB + $_.Free/1GB, 2)}}, @{N='UsedGB';E={[math]::Round($_.Used/1GB, 2)}}, @{N='FreeGB';E={[math]::Round($_.Free/1GB, 2)}} | ConvertTo-Json",
    ]);

    const drives = JSON.parse(stdout);
    const drivesArr = Array.isArray(drives) ? drives : [drives];

    const mounts = drivesArr.map((d: any) => ({
      filesystem: `${d.Name}:`,
      mountpoint: `${d.Name}:\\`,
      totalGB: d.TotalGB ?? 0,
      usedGB: d.UsedGB ?? 0,
      availableGB: d.FreeGB ?? 0,
      usedPercent:
        d.TotalGB > 0
          ? Math.round((d.UsedGB / d.TotalGB) * 100)
          : 0,
    }));

    return { mounts };
  }

  // --------------------------------------------------------------------------
  // Process Listing
  // --------------------------------------------------------------------------

  /**
   * List running processes (PID, name, CPU%, memory%).
   */
  async listProcesses(options?: {
    sortBy?: "cpu" | "memory" | "pid" | "name";
    limit?: number;
  }): Promise<ProcessList> {
    const platform = process.platform;

    let processes: ProcessInfo[];

    if (platform === "darwin" || platform === "linux") {
      processes = await this.listProcessesUnix();
    } else if (platform === "win32") {
      processes = await this.listProcessesWindows();
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    // Sort
    const sortBy = options?.sortBy ?? "cpu";
    processes.sort((a, b) => {
      switch (sortBy) {
        case "cpu":
          return parseFloat(b.cpu) - parseFloat(a.cpu);
        case "memory":
          return parseFloat(b.memory) - parseFloat(a.memory);
        case "pid":
          return a.pid - b.pid;
        case "name":
          return a.name.localeCompare(b.name);
        default:
          return 0;
      }
    });

    const limit = options?.limit ?? 50;
    const total = processes.length;
    processes = processes.slice(0, limit);

    return { processes, total };
  }

  private async listProcessesUnix(): Promise<ProcessInfo[]> {
    const { stdout } = await execFileAsync("ps", [
      "-axo",
      "pid,comm,%cpu,%mem",
    ]);

    const lines = stdout.trim().split("\n").slice(1); // Skip header

    return lines
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) return null;

        const pid = parseInt(parts[0], 10);
        const cpu = parts[parts.length - 2];
        const memory = parts[parts.length - 1];
        // Command name can contain spaces, so join middle parts
        const name = parts.slice(1, parts.length - 2).join(" ");

        if (isNaN(pid)) return null;

        return { pid, name, cpu, memory };
      })
      .filter((p): p is ProcessInfo => p !== null);
  }

  private async listProcessesWindows(): Promise<ProcessInfo[]> {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-Process | Select-Object Id, ProcessName, @{N='CPU';E={[math]::Round($_.CPU, 1)}}, @{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB, 1)}} | ConvertTo-Json",
    ]);

    const procs = JSON.parse(stdout);
    const procsArr = Array.isArray(procs) ? procs : [procs];

    return procsArr.map((p: any) => ({
      pid: p.Id,
      name: p.ProcessName,
      cpu: String(p.CPU ?? 0),
      memory: String(p.MemMB ?? 0),
    }));
  }

  // --------------------------------------------------------------------------
  // Network Info
  // --------------------------------------------------------------------------

  /**
   * Get network interfaces, IPs, and MAC addresses.
   */
  getNetworkInfo(): NetworkInfo {
    const ifaces = os.networkInterfaces();
    const interfaces: NetworkInfo["interfaces"] = [];

    for (const [name, addrs] of Object.entries(ifaces)) {
      if (!addrs) continue;

      interfaces.push({
        name,
        addresses: addrs.map((addr) => ({
          address: addr.address,
          netmask: addr.netmask,
          family: addr.family,
          mac: addr.mac,
          internal: addr.internal,
        })),
      });
    }

    return { interfaces };
  }

  // --------------------------------------------------------------------------
  // Kill Process
  // --------------------------------------------------------------------------

  /**
   * Kill a process by PID.
   */
  async killProcess(pid: number, signal?: string): Promise<{ killed: boolean; pid: number; signal: string }> {
    const sig = signal ?? "SIGTERM";

    try {
      process.kill(pid, sig as NodeJS.Signals);
      return { killed: true, pid, signal: sig };
    } catch (err: any) {
      if (err.code === "ESRCH") {
        throw new Error(`Process not found: PID ${pid}`);
      }
      if (err.code === "EPERM") {
        throw new Error(`Permission denied: cannot kill PID ${pid}`);
      }
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (mins > 0) parts.push(`${mins}m`);
    if (parts.length === 0) parts.push(`${Math.floor(seconds)}s`);

    return parts.join(" ");
  }
}
