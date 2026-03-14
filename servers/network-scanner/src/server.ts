/**
 * AXON Network Scanner Server — Tool Definitions
 *
 * 7 network scanning tools registered with AXON's 3-tier discovery:
 *   Tier 1: Compact manifests (~20 tokens/tool) — always in context
 *   Tier 2: Full schemas — fetched on demand when model calls a tool
 *
 * Results go through OCRS:
 *   - Port scans → stored in OCRS, open port counts in context
 *   - Device lists → stored in OCRS, count in context
 *   - DNS records → stored in OCRS, record count in context
 *
 * Uses Node.js net module for port scanning, dns module for DNS,
 * and child_process.execFile for system commands (arp, ping, traceroute).
 *
 * All tools are read-only — no write capabilities needed.
 */

import { AxonServer, ResultStore, CapabilityAuthority } from "@axon-protocol/sdk";
import { NetworkScanner } from "./network-scanner.js";

export interface NetworkScannerServerConfig {
  /** No specific config needed — all tools are read-only */
}

export function createNetworkScannerServer(
  scanner: NetworkScanner,
  config?: NetworkScannerServerConfig,
): {
  server: AxonServer;
  store: ResultStore;
  capAuthority: CapabilityAuthority;
} {
  const server = new AxonServer({ name: "axon-network-scanner", version: "0.1.0" });
  const store = new ResultStore({ max_summary_tokens: 300, max_total_result_tokens: 6000 });

  const key = Buffer.alloc(32);
  Buffer.from(Date.now().toString(16).padStart(32, "0"), "hex").copy(key);
  const capAuthority = new CapabilityAuthority("axon-network-scanner", key, key);

  // ==========================================================================
  // Scan Ports
  // ==========================================================================

  server.tool({
    id: "scan_ports",
    summary: "Scan ports on a host (configurable range)",
    description:
      "Scan TCP ports on a host using Node.js net.Socket. Configurable port range (default: 1-1024). Returns open, closed, and filtered port states with service names for well-known ports. Maximum 10,000 ports per scan.",
    category: "network",
    tags: ["network", "ports", "scan", "security"],
    input: {
      type: "object",
      properties: {
        host: {
          type: "string",
          description: "Target host (IP address or hostname)",
        },
        startPort: {
          type: "number",
          description: "Start of port range (default: 1)",
        },
        endPort: {
          type: "number",
          description: "End of port range (default: 1024)",
        },
        timeout: {
          type: "number",
          description: "Timeout per port in ms (default: 2000)",
        },
      },
      required: ["host"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 30000,
      max_result_size_bytes: 200_000,
    },
    handler: async ({ host, startPort, endPort, timeout }: any) => {
      return scanner.scanPorts(host, startPort, endPort, timeout);
    },
    summarizer: (result: any) => {
      const open = result.openPorts?.length ?? 0;
      const services = (result.openPorts ?? [])
        .slice(0, 5)
        .map((p: any) => `${p.port}${p.service ? `/${p.service}` : ""}`)
        .join(", ");
      return `${open} open port(s) on ${result.host} (range ${result.scannedRange}, ${result.duration}ms)${open > 0 ? `: ${services}${open > 5 ? "..." : ""}` : ""}`;
    },
  });

  // ==========================================================================
  // Get Local Devices
  // ==========================================================================

  server.tool({
    id: "get_local_devices",
    summary: "List devices on local network using arp",
    description:
      "Discover devices on the local network by parsing the ARP table (`arp -a`). Returns IP addresses, MAC addresses, and hostnames of discovered devices.",
    category: "network",
    tags: ["network", "devices", "local", "arp", "discovery"],
    input: {
      type: "object",
      properties: {},
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 5000,
      max_result_size_bytes: 100_000,
    },
    handler: async () => {
      return scanner.getLocalDevices();
    },
    summarizer: (devices: any[]) => {
      if (!Array.isArray(devices)) return "No devices found";
      const count = devices.length;
      const sample = devices
        .slice(0, 5)
        .map((d: any) => `${d.ip}${d.hostname ? ` (${d.hostname})` : ""}`)
        .join(", ");
      return `${count} device(s) on local network${count > 0 ? `: ${sample}${count > 5 ? "..." : ""}` : ""}`;
    },
  });

  // ==========================================================================
  // DNS Lookup
  // ==========================================================================

  server.tool({
    id: "dns_lookup",
    summary: "DNS resolution (A, AAAA, MX, TXT, CNAME records)",
    description:
      "Perform DNS lookups for a hostname. Supports A, AAAA, MX, TXT, CNAME, NS, and SOA record types. Uses Node.js dns.promises for resolution.",
    category: "network",
    tags: ["network", "dns", "lookup", "resolve"],
    input: {
      type: "object",
      properties: {
        hostname: {
          type: "string",
          description: "Hostname to look up (e.g., 'example.com')",
        },
        type: {
          type: "string",
          description: "Record type: A (default), AAAA, MX, TXT, CNAME, NS, SOA",
          enum: ["A", "AAAA", "MX", "TXT", "CNAME", "NS", "SOA"],
        },
      },
      required: ["hostname"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 3000,
      max_result_size_bytes: 20_000,
    },
    handler: async ({ hostname, type }: any) => {
      return scanner.dnsLookup(hostname, type);
    },
    summarizer: (result: any) => {
      const count = result.records?.length ?? 0;
      if (count === 0) return `No ${result.queryType} records for ${result.hostname}`;
      const sample = result.records
        .slice(0, 3)
        .map((r: any) => r.value)
        .join(", ");
      return `${count} ${result.queryType} record(s) for ${result.hostname}: ${sample}${count > 3 ? "..." : ""}`;
    },
  });

  // ==========================================================================
  // Ping Host
  // ==========================================================================

  server.tool({
    id: "ping_host",
    summary: "Ping a host and report latency",
    description:
      "Ping a host to check connectivity and measure latency. Reports round-trip time, packet loss, and whether the host is alive.",
    category: "network",
    tags: ["network", "ping", "connectivity", "latency"],
    input: {
      type: "object",
      properties: {
        host: {
          type: "string",
          description: "Host to ping (IP address or hostname)",
        },
        count: {
          type: "number",
          description: "Number of ping packets (default: 4)",
        },
        timeout: {
          type: "number",
          description: "Timeout in seconds per packet (default: 5)",
        },
      },
      required: ["host"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 25000,
      max_result_size_bytes: 10_000,
    },
    handler: async ({ host, count, timeout }: any) => {
      return scanner.pingHost(host, count, timeout);
    },
    summarizer: (result: any) => {
      if (result.alive) {
        return `${result.host} is alive — ${result.latency}ms avg, ${result.packetLoss} loss`;
      }
      return `${result.host} is unreachable — ${result.packetLoss} loss`;
    },
  });

  // ==========================================================================
  // Get Network Interfaces
  // ==========================================================================

  server.tool({
    id: "get_network_interfaces",
    summary: "List local network interfaces with IPs",
    description:
      "List all network interfaces on this machine with their IP addresses, netmasks, MAC addresses, and whether they are internal (loopback) interfaces.",
    category: "network",
    tags: ["network", "interfaces", "local", "ip"],
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
      return scanner.getNetworkInterfaces();
    },
    summarizer: (interfaces: any[]) => {
      if (!Array.isArray(interfaces)) return "No network interfaces found";
      const external = interfaces.filter((i: any) =>
        i.addresses?.some((a: any) => !a.internal && a.family === "IPv4"),
      );
      const ips = external
        .flatMap((i: any) =>
          i.addresses
            .filter((a: any) => !a.internal && a.family === "IPv4")
            .map((a: any) => `${i.name}: ${a.address}`),
        )
        .join(", ");
      return `${interfaces.length} interface(s)${ips ? ` — ${ips}` : ""}`;
    },
  });

  // ==========================================================================
  // Check URL
  // ==========================================================================

  server.tool({
    id: "check_url",
    summary: "Check if a URL is reachable (HTTP HEAD)",
    description:
      "Check if a URL is reachable by performing an HTTP HEAD request. Reports status code, response headers, latency, and redirect URL if applicable.",
    category: "network",
    tags: ["network", "http", "url", "check", "connectivity"],
    input: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL to check (e.g., 'https://example.com')",
        },
        timeout: {
          type: "number",
          description: "Timeout in ms (default: 10000)",
        },
      },
      required: ["url"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 10000,
      max_result_size_bytes: 10_000,
    },
    handler: async ({ url, timeout }: any) => {
      return scanner.checkUrl(url, timeout);
    },
    summarizer: (result: any) => {
      if (result.reachable) {
        const redirect = result.redirectUrl ? ` → ${result.redirectUrl}` : "";
        return `${result.url} — ${result.statusCode} ${result.statusMessage} (${result.latency}ms)${redirect}`;
      }
      return `${result.url} — unreachable: ${result.statusMessage}`;
    },
  });

  // ==========================================================================
  // Traceroute
  // ==========================================================================

  server.tool({
    id: "traceroute",
    summary: "Run traceroute to a host",
    description:
      "Run traceroute to a host to trace the network path. Shows each hop with hostname, IP, and round-trip times. Uses the system traceroute command.",
    category: "network",
    tags: ["network", "traceroute", "path", "routing"],
    input: {
      type: "object",
      properties: {
        host: {
          type: "string",
          description: "Target host (IP address or hostname)",
        },
        maxHops: {
          type: "number",
          description: "Maximum number of hops (default: 30)",
        },
      },
      required: ["host"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 60000,
      max_result_size_bytes: 50_000,
    },
    handler: async ({ host, maxHops }: any) => {
      return scanner.traceroute(host, maxHops);
    },
    summarizer: (result: any) => {
      const hopCount = result.hops?.length ?? 0;
      if (hopCount === 0) return `Traceroute to ${result.host} — no hops recorded`;
      const lastHop = result.hops[hopCount - 1];
      return `Traceroute to ${result.host}: ${hopCount} hop(s), last: ${lastHop.host} (${lastHop.ip})`;
    },
  });

  return { server, store, capAuthority };
}
