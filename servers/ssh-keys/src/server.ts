/**
 * AXON SSH Key Manager Server — Tool Definitions
 *
 * 7 SSH key management tools registered with AXON's 3-tier discovery:
 *   Tier 1: Compact manifests (~20 tokens/tool) — always in context
 *   Tier 2: Full schemas — fetched on demand when model calls a tool
 *
 * Results go through OCRS:
 *   - Key lists → stored in OCRS, summary in context
 *   - Public keys → stored in OCRS, fingerprint in summary
 *
 * SECURITY: Summarizers NEVER include key material.
 * Private key contents are NEVER read or exposed.
 * Only public key contents are accessible via get_public_key.
 *
 * Capabilities enforce access:
 *   - "resource:read" for listing, reading, testing
 *   - "resource:write" for generate, delete, add host
 */

import { AxonServer, ResultStore, CapabilityAuthority } from "@axon-protocol/sdk";
import { SSHKeyManager } from "./ssh-key-manager.js";

export interface SSHKeyServerConfig {
  /** Restrict to read-only operations */
  readOnly?: boolean;
}

export function createSSHKeyServer(
  manager: SSHKeyManager,
  config?: SSHKeyServerConfig,
): {
  server: AxonServer;
  store: ResultStore;
  capAuthority: CapabilityAuthority;
} {
  const server = new AxonServer({ name: "axon-ssh-keys", version: "0.1.0" });
  const store = new ResultStore({ max_summary_tokens: 300, max_total_result_tokens: 6000 });

  const key = Buffer.alloc(32);
  Buffer.from(Date.now().toString(16).padStart(32, "0"), "hex").copy(key);
  const capAuthority = new CapabilityAuthority("axon-ssh-keys", key, key);

  // ==========================================================================
  // List Keys
  // ==========================================================================

  server.tool({
    id: "list_keys",
    summary: "List all SSH keys in ~/.ssh/",
    description:
      "List all SSH key pairs found in ~/.ssh/. Returns public key metadata only (name, type, fingerprint, comment). NEVER exposes private key contents. Use get_public_key to read a specific public key.",
    category: "ssh-keys",
    tags: ["ssh", "keys", "list", "browse"],
    input: {
      type: "object",
      properties: {},
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 1000,
      max_result_size_bytes: 50_000,
    },
    handler: async () => {
      return manager.listKeys();
    },
    summarizer: (keys: any[]) => {
      if (!Array.isArray(keys)) return "No SSH keys found";
      const count = keys.length;
      const sample = keys
        .slice(0, 5)
        .map((k: any) => `${k.name} (${k.type})`)
        .join(", ");
      return `${count} SSH key(s)${count > 0 ? `: ${sample}${count > 5 ? "..." : ""}` : ""}`;
    },
  });

  // ==========================================================================
  // Generate Key
  // ==========================================================================

  server.tool({
    id: "generate_key",
    summary: "Generate a new SSH key pair",
    description:
      "Generate a new SSH key pair using ssh-keygen. Supports ed25519 (default, recommended), rsa, and ecdsa key types. The key pair is saved to ~/.ssh/. Returns public key metadata — private key content is NEVER exposed.",
    category: "ssh-keys",
    tags: ["ssh", "keys", "generate", "create"],
    input: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Key name (file name in ~/.ssh/, e.g., 'id_github')",
        },
        type: {
          type: "string",
          description: "Key type: 'ed25519' (default, recommended), 'rsa', or 'ecdsa'",
          enum: ["ed25519", "rsa", "ecdsa"],
        },
        bits: {
          type: "number",
          description: "Key size in bits (only for RSA, default: 4096)",
        },
        comment: {
          type: "string",
          description: "Key comment (default: name@axon)",
        },
        passphrase: {
          type: "string",
          description: "Passphrase for the key (default: empty — no passphrase)",
        },
      },
      required: ["name"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: false,
      estimated_latency_ms: 3000,
      max_result_size_bytes: 2000,
    },
    handler: async ({ name, type, bits, comment, passphrase }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return manager.generateKey({ name, type, bits, comment, passphrase });
    },
    // SECURITY: Never include key material in summary
    summarizer: (result: any) => {
      return `Generated ${result.type} key "${result.name}" (${result.fingerprint})`;
    },
  });

  // ==========================================================================
  // Get Public Key
  // ==========================================================================

  server.tool({
    id: "get_public_key",
    summary: "Read a public key file content",
    description:
      "Read the contents of a public key file (.pub) from ~/.ssh/. Returns the full public key string suitable for pasting into authorized_keys or service settings. NEVER reads private key files.",
    category: "ssh-keys",
    tags: ["ssh", "keys", "public", "read", "get"],
    input: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Key name (without .pub extension, e.g., 'id_ed25519')",
        },
      },
      required: ["name"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 500,
      max_result_size_bytes: 5000,
    },
    handler: async ({ name }: any) => {
      return manager.getPublicKey(name);
    },
    // Store full public key in OCRS, summary just shows metadata
    summarizer: (result: any) => {
      return `Public key for "${result.name}" — stored in OCRS (${result.publicKey.length} chars)`;
    },
  });

  // ==========================================================================
  // Delete Key
  // ==========================================================================

  server.tool({
    id: "delete_key",
    summary: "Delete an SSH key pair",
    description:
      "Delete an SSH key pair (both public and private key files) from ~/.ssh/. This action is permanent and cannot be undone.",
    category: "ssh-keys",
    tags: ["ssh", "keys", "delete", "remove"],
    input: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Key name to delete (e.g., 'id_old_key')",
        },
      },
      required: ["name"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: true,
      estimated_latency_ms: 500,
      max_result_size_bytes: 500,
    },
    handler: async ({ name }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return manager.deleteKey(name);
    },
    summarizer: (result: any) => {
      return `Deleted key "${result.name}" (${result.deleted.join(", ")})`;
    },
  });

  // ==========================================================================
  // List Hosts
  // ==========================================================================

  server.tool({
    id: "list_hosts",
    summary: "List hosts from ~/.ssh/config",
    description:
      "Parse and list all host entries from ~/.ssh/config. Shows Host alias, Hostname, User, Port, IdentityFile, and other directives.",
    category: "ssh-config",
    tags: ["ssh", "config", "hosts", "list"],
    input: {
      type: "object",
      properties: {},
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 500,
      max_result_size_bytes: 50_000,
    },
    handler: async () => {
      return manager.listHosts();
    },
    summarizer: (hosts: any[]) => {
      if (!Array.isArray(hosts)) return "No SSH config found";
      const count = hosts.length;
      const sample = hosts
        .slice(0, 5)
        .map((h: any) => h.host)
        .join(", ");
      return `${count} host(s) in SSH config${count > 0 ? `: ${sample}${count > 5 ? "..." : ""}` : ""}`;
    },
  });

  // ==========================================================================
  // Add Host
  // ==========================================================================

  server.tool({
    id: "add_host",
    summary: "Add a host entry to ~/.ssh/config",
    description:
      "Add a new host entry to ~/.ssh/config. Specify the Host alias and connection details (Hostname, User, Port, IdentityFile, etc.). Fails if the host alias already exists.",
    category: "ssh-config",
    tags: ["ssh", "config", "hosts", "add", "create"],
    input: {
      type: "object",
      properties: {
        host: {
          type: "string",
          description: "Host alias (e.g., 'my-server', 'github')",
        },
        hostname: {
          type: "string",
          description: "Actual hostname or IP address",
        },
        user: {
          type: "string",
          description: "SSH username",
        },
        port: {
          type: "string",
          description: "SSH port (default: 22)",
        },
        identityFile: {
          type: "string",
          description: "Path to identity file (e.g., '~/.ssh/id_ed25519')",
        },
        forwardAgent: {
          type: "string",
          description: "Enable agent forwarding ('yes' or 'no')",
        },
        proxyJump: {
          type: "string",
          description: "Proxy jump host for multi-hop SSH",
        },
      },
      required: ["host"],
    },
    capabilities_required: ["resource:write"],
    annotations: {
      read_only: false,
      idempotent: false,
      estimated_latency_ms: 500,
      max_result_size_bytes: 2000,
    },
    handler: async ({ host, hostname, user, port, identityFile, forwardAgent, proxyJump }: any) => {
      if (config?.readOnly) throw new Error("Server is in read-only mode");
      return manager.addHost({ host, hostname, user, port, identityFile, forwardAgent, proxyJump });
    },
    summarizer: (result: any) => {
      const parts = [`Added host "${result.host}"`];
      if (result.hostname) parts.push(`→ ${result.hostname}`);
      if (result.user) parts.push(`as ${result.user}`);
      return parts.join(" ");
    },
  });

  // ==========================================================================
  // Test Connection
  // ==========================================================================

  server.tool({
    id: "test_connection",
    summary: "Test SSH connection to a host",
    description:
      "Test SSH connectivity to a host using `ssh -T`. Uses BatchMode to avoid interactive prompts. Reports success/failure and any output from the server.",
    category: "ssh-config",
    tags: ["ssh", "test", "connection", "verify"],
    input: {
      type: "object",
      properties: {
        host: {
          type: "string",
          description: "Host to test (alias from SSH config or hostname)",
        },
        timeout: {
          type: "number",
          description: "Connection timeout in seconds (default: 10)",
        },
      },
      required: ["host"],
    },
    annotations: {
      read_only: true,
      idempotent: true,
      estimated_latency_ms: 15000,
      max_result_size_bytes: 5000,
    },
    handler: async ({ host, timeout }: any) => {
      return manager.testConnection(host, timeout);
    },
    summarizer: (result: any) => {
      return result.success
        ? `SSH connection to "${result.host}" succeeded`
        : `SSH connection to "${result.host}" failed (exit ${result.exitCode})`;
    },
  });

  return { server, store, capAuthority };
}
