/**
 * AXON Network Scanner — Core Network Scanning Operations
 *
 * Scans local networks using Node.js net, dns, http/https modules
 * and system commands (arp, ping, traceroute).
 *
 * Uses child_process.execFile (not exec) for all system commands
 * to prevent shell injection attacks.
 */

import * as net from "node:net";
import * as dns from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { networkInterfaces } from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

// ============================================================================
// Types
// ============================================================================

export interface PortScanResult {
  host: string;
  port: number;
  state: "open" | "closed" | "filtered";
  service?: string;
}

export interface PortScanSummary {
  host: string;
  scannedRange: string;
  openPorts: PortScanResult[];
  closedCount: number;
  filteredCount: number;
  duration: number;
}

export interface LocalDevice {
  ip: string;
  mac: string;
  interface?: string;
  hostname?: string;
}

export interface DNSRecord {
  type: string;
  value: string;
  ttl?: number;
  priority?: number;
}

export interface DNSLookupResult {
  hostname: string;
  records: DNSRecord[];
  queryType: string;
}

export interface PingResult {
  host: string;
  alive: boolean;
  latency: number | null;
  packetLoss: string;
  output: string;
}

export interface NetworkInterface {
  name: string;
  addresses: {
    address: string;
    netmask: string;
    family: "IPv4" | "IPv6";
    mac: string;
    internal: boolean;
  }[];
}

export interface URLCheckResult {
  url: string;
  reachable: boolean;
  statusCode: number | null;
  statusMessage: string;
  headers: Record<string, string>;
  latency: number;
  redirectUrl?: string;
}

export interface TracerouteHop {
  hop: number;
  host: string;
  ip: string;
  rtt: string[];
}

export interface TracerouteResult {
  host: string;
  hops: TracerouteHop[];
  output: string;
}

export interface NetworkScannerConfig {
  /** Default timeout for port scans in ms (default: 2000) */
  portTimeout?: number;
  /** Default timeout for ping in seconds (default: 5) */
  pingTimeout?: number;
  /** Max concurrent port scans (default: 100) */
  maxConcurrentScans?: number;
}

// ============================================================================
// Well-known port services
// ============================================================================

const WELL_KNOWN_PORTS: Record<number, string> = {
  21: "FTP",
  22: "SSH",
  23: "Telnet",
  25: "SMTP",
  53: "DNS",
  80: "HTTP",
  110: "POP3",
  143: "IMAP",
  443: "HTTPS",
  465: "SMTPS",
  587: "SMTP Submission",
  993: "IMAPS",
  995: "POP3S",
  1433: "MSSQL",
  1521: "Oracle",
  3306: "MySQL",
  3389: "RDP",
  5432: "PostgreSQL",
  5672: "AMQP",
  5900: "VNC",
  6379: "Redis",
  8080: "HTTP Proxy",
  8443: "HTTPS Alt",
  9090: "Prometheus",
  9200: "Elasticsearch",
  27017: "MongoDB",
};

// ============================================================================
// Network Scanner
// ============================================================================

export class NetworkScanner {
  private readonly portTimeout: number;
  private readonly pingTimeout: number;
  private readonly maxConcurrentScans: number;

  constructor(config?: NetworkScannerConfig) {
    this.portTimeout = config?.portTimeout ?? 2000;
    this.pingTimeout = config?.pingTimeout ?? 5;
    this.maxConcurrentScans = config?.maxConcurrentScans ?? 100;
  }

  // --------------------------------------------------------------------------
  // Port Scanning
  // --------------------------------------------------------------------------

  /**
   * Scan a single port on a host.
   */
  private scanPort(host: string, port: number, timeout: number): Promise<PortScanResult> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let state: "open" | "closed" | "filtered" = "filtered";

      socket.setTimeout(timeout);

      socket.on("connect", () => {
        state = "open";
        socket.destroy();
      });

      socket.on("timeout", () => {
        state = "filtered";
        socket.destroy();
      });

      socket.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ECONNREFUSED") {
          state = "closed";
        } else {
          state = "filtered";
        }
      });

      socket.on("close", () => {
        resolve({
          host,
          port,
          state,
          service: WELL_KNOWN_PORTS[port],
        });
      });

      socket.connect(port, host);
    });
  }

  /**
   * Scan ports on a host. Configurable range, concurrent scanning.
   */
  async scanPorts(
    host: string,
    startPort?: number,
    endPort?: number,
    timeout?: number,
  ): Promise<PortScanSummary> {
    const start = startPort ?? 1;
    const end = endPort ?? 1024;
    const timeoutMs = timeout ?? this.portTimeout;
    const startTime = Date.now();

    // Validate port range
    if (start < 1 || end > 65535 || start > end) {
      throw new Error(`Invalid port range: ${start}-${end}. Must be 1-65535.`);
    }

    if (end - start > 10000) {
      throw new Error(`Port range too large: ${end - start} ports. Maximum 10000 ports per scan.`);
    }

    const ports: number[] = [];
    for (let p = start; p <= end; p++) {
      ports.push(p);
    }

    // Scan in batches to limit concurrency
    const results: PortScanResult[] = [];
    for (let i = 0; i < ports.length; i += this.maxConcurrentScans) {
      const batch = ports.slice(i, i + this.maxConcurrentScans);
      const batchResults = await Promise.all(
        batch.map((port) => this.scanPort(host, port, timeoutMs)),
      );
      results.push(...batchResults);
    }

    const openPorts = results.filter((r) => r.state === "open");
    const closedCount = results.filter((r) => r.state === "closed").length;
    const filteredCount = results.filter((r) => r.state === "filtered").length;

    return {
      host,
      scannedRange: `${start}-${end}`,
      openPorts,
      closedCount,
      filteredCount,
      duration: Date.now() - startTime,
    };
  }

  // --------------------------------------------------------------------------
  // Local Network Discovery
  // --------------------------------------------------------------------------

  /**
   * List devices on local network using `arp -a`.
   */
  async getLocalDevices(): Promise<LocalDevice[]> {
    try {
      const { stdout } = await execFile("arp", ["-a"], { timeout: 10000 });
      const devices: LocalDevice[] = [];

      for (const line of stdout.split("\n")) {
        // macOS: hostname (ip) at mac on interface [ifscope ...]
        // Linux: hostname (ip) at mac [ether] on interface
        const match = line.match(/(\S+)\s+\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+(\S+)/);
        if (match && match[3] !== "(incomplete)") {
          const interfaceMatch = line.match(/on\s+(\S+)/);
          devices.push({
            hostname: match[1] === "?" ? undefined : match[1],
            ip: match[2],
            mac: match[3],
            interface: interfaceMatch?.[1],
          });
        }
      }

      return devices;
    } catch (err: any) {
      throw new Error(`Failed to run arp: ${err.message}`);
    }
  }

  // --------------------------------------------------------------------------
  // DNS Lookups
  // --------------------------------------------------------------------------

  /**
   * DNS resolution for various record types.
   */
  async dnsLookup(hostname: string, queryType?: string): Promise<DNSLookupResult> {
    const type = (queryType ?? "A").toUpperCase();
    const records: DNSRecord[] = [];

    try {
      switch (type) {
        case "A": {
          const addresses = await dns.resolve4(hostname, { ttl: true });
          for (const addr of addresses) {
            records.push({ type: "A", value: addr.address, ttl: addr.ttl });
          }
          break;
        }
        case "AAAA": {
          const addresses = await dns.resolve6(hostname, { ttl: true });
          for (const addr of addresses) {
            records.push({ type: "AAAA", value: addr.address, ttl: addr.ttl });
          }
          break;
        }
        case "MX": {
          const mxRecords = await dns.resolveMx(hostname);
          for (const mx of mxRecords) {
            records.push({ type: "MX", value: mx.exchange, priority: mx.priority });
          }
          break;
        }
        case "TXT": {
          const txtRecords = await dns.resolveTxt(hostname);
          for (const txt of txtRecords) {
            records.push({ type: "TXT", value: txt.join("") });
          }
          break;
        }
        case "CNAME": {
          const cnames = await dns.resolveCname(hostname);
          for (const cname of cnames) {
            records.push({ type: "CNAME", value: cname });
          }
          break;
        }
        case "NS": {
          const nsRecords = await dns.resolveNs(hostname);
          for (const ns of nsRecords) {
            records.push({ type: "NS", value: ns });
          }
          break;
        }
        case "SOA": {
          const soa = await dns.resolveSoa(hostname);
          records.push({
            type: "SOA",
            value: `${soa.nsname} ${soa.hostmaster} (serial: ${soa.serial}, refresh: ${soa.refresh}, retry: ${soa.retry}, expire: ${soa.expire}, minttl: ${soa.minttl})`,
          });
          break;
        }
        default:
          throw new Error(`Unsupported query type: ${type}. Supported: A, AAAA, MX, TXT, CNAME, NS, SOA`);
      }
    } catch (err: any) {
      if (err.code === "ENOTFOUND" || err.code === "ENODATA") {
        return { hostname, records: [], queryType: type };
      }
      throw err;
    }

    return { hostname, records, queryType: type };
  }

  // --------------------------------------------------------------------------
  // Ping
  // --------------------------------------------------------------------------

  /**
   * Ping a host and report latency.
   */
  async pingHost(host: string, count?: number, timeout?: number): Promise<PingResult> {
    const pingCount = count ?? 4;
    const pingTimeout = timeout ?? this.pingTimeout;

    try {
      const { stdout } = await execFile("ping", [
        "-c", pingCount.toString(),
        "-W", (pingTimeout * 1000).toString(),
        host,
      ], { timeout: (pingTimeout * pingCount + 5) * 1000 });

      // Parse ping output for latency
      const rttMatch = stdout.match(/rtt min\/avg\/max\/\w+\s*=\s*[\d.]+\/([\d.]+)/);
      const lossMatch = stdout.match(/([\d.]+)% packet loss/);

      return {
        host,
        alive: true,
        latency: rttMatch ? parseFloat(rttMatch[1]) : null,
        packetLoss: lossMatch ? `${lossMatch[1]}%` : "unknown",
        output: stdout.trim(),
      };
    } catch (err: any) {
      const output = err.stdout ?? err.stderr ?? err.message;
      const lossMatch = output.match(/([\d.]+)% packet loss/);

      return {
        host,
        alive: false,
        latency: null,
        packetLoss: lossMatch ? `${lossMatch[1]}%` : "100%",
        output: output.trim(),
      };
    }
  }

  // --------------------------------------------------------------------------
  // Network Interfaces
  // --------------------------------------------------------------------------

  /**
   * List local network interfaces with IPs.
   */
  getNetworkInterfaces(): NetworkInterface[] {
    const ifaces = networkInterfaces();
    const result: NetworkInterface[] = [];

    for (const [name, addrs] of Object.entries(ifaces)) {
      if (!addrs) continue;

      result.push({
        name,
        addresses: addrs.map((addr) => ({
          address: addr.address,
          netmask: addr.netmask,
          family: addr.family as "IPv4" | "IPv6",
          mac: addr.mac,
          internal: addr.internal,
        })),
      });
    }

    return result;
  }

  // --------------------------------------------------------------------------
  // URL Check
  // --------------------------------------------------------------------------

  /**
   * Check if a URL is reachable using HTTP HEAD.
   */
  async checkUrl(url: string, timeout?: number): Promise<URLCheckResult> {
    const timeoutMs = timeout ?? 10000;
    const startTime = Date.now();

    return new Promise((resolve) => {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        resolve({
          url,
          reachable: false,
          statusCode: null,
          statusMessage: "Invalid URL",
          headers: {},
          latency: 0,
        });
        return;
      }

      const client = parsedUrl.protocol === "https:" ? https : http;

      const req = client.request(
        parsedUrl,
        {
          method: "HEAD",
          timeout: timeoutMs,
          headers: {
            "User-Agent": "AXON-Network-Scanner/0.1.0",
          },
        },
        (res) => {
          const latency = Date.now() - startTime;
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === "string") {
              headers[key] = value;
            } else if (Array.isArray(value)) {
              headers[key] = value.join(", ");
            }
          }

          resolve({
            url,
            reachable: true,
            statusCode: res.statusCode ?? null,
            statusMessage: res.statusMessage ?? "",
            headers,
            latency,
            redirectUrl: res.headers.location,
          });

          res.resume();
        },
      );

      req.on("timeout", () => {
        req.destroy();
        resolve({
          url,
          reachable: false,
          statusCode: null,
          statusMessage: "Timeout",
          headers: {},
          latency: Date.now() - startTime,
        });
      });

      req.on("error", (err: any) => {
        resolve({
          url,
          reachable: false,
          statusCode: null,
          statusMessage: err.message,
          headers: {},
          latency: Date.now() - startTime,
        });
      });

      req.end();
    });
  }

  // --------------------------------------------------------------------------
  // Traceroute
  // --------------------------------------------------------------------------

  /**
   * Run traceroute to a host.
   */
  async traceroute(host: string, maxHops?: number): Promise<TracerouteResult> {
    const hops = maxHops ?? 30;

    try {
      const { stdout } = await execFile("traceroute", [
        "-m", hops.toString(),
        "-w", "3",
        host,
      ], { timeout: hops * 5000 });

      const parsedHops: TracerouteHop[] = [];

      for (const line of stdout.split("\n")) {
        // Match traceroute output lines: "  1  hostname (ip)  1.234 ms  1.567 ms  1.890 ms"
        const match = line.match(/^\s*(\d+)\s+(.+)$/);
        if (!match) continue;

        const hopNum = parseInt(match[1], 10);
        const rest = match[2];

        // Extract host/IP
        const hostMatch = rest.match(/(\S+)\s+\((\d+\.\d+\.\d+\.\d+)\)/);
        const rttMatches = rest.match(/[\d.]+\s*ms/g) ?? [];

        if (rest.trim() === "* * *") {
          parsedHops.push({
            hop: hopNum,
            host: "*",
            ip: "*",
            rtt: ["*", "*", "*"],
          });
        } else {
          parsedHops.push({
            hop: hopNum,
            host: hostMatch?.[1] ?? "*",
            ip: hostMatch?.[2] ?? "*",
            rtt: rttMatches.map((r) => r.trim()),
          });
        }
      }

      return {
        host,
        hops: parsedHops,
        output: stdout.trim(),
      };
    } catch (err: any) {
      const output = err.stdout ?? err.stderr ?? err.message;
      return {
        host,
        hops: [],
        output: output.trim(),
      };
    }
  }
}
