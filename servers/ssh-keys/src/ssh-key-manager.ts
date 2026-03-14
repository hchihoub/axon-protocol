/**
 * AXON SSH Key Manager — Core SSH Key & Config Operations
 *
 * Manages SSH keys and ~/.ssh/config using Node.js fs APIs and
 * ssh-keygen / ssh system commands.
 *
 * SECURITY:
 *   - NEVER reads or exposes private key file contents
 *   - Only public key contents are accessible
 *   - All file operations scoped to ~/.ssh/
 *   - Uses execFile (not exec) to prevent shell injection
 */

import { readdir, readFile, writeFile, unlink, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, basename } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

// ============================================================================
// Types
// ============================================================================

export interface SSHKeyInfo {
  name: string;
  type: string;
  bits: number | null;
  fingerprint: string;
  publicKeyPath: string;
  privateKeyPath: string;
  comment: string;
  createdAt: string;
}

export interface SSHHostEntry {
  host: string;
  hostname?: string;
  user?: string;
  port?: string;
  identityFile?: string;
  forwardAgent?: string;
  proxyJump?: string;
  [key: string]: string | undefined;
}

export interface GenerateKeyOptions {
  name: string;
  type?: "ed25519" | "rsa" | "ecdsa";
  bits?: number;
  comment?: string;
  passphrase?: string;
}

export interface SSHKeyManagerConfig {
  /** Override SSH directory (default: ~/.ssh) */
  sshDir?: string;
}

// ============================================================================
// SSH Key Manager
// ============================================================================

export class SSHKeyManager {
  private readonly sshDir: string;

  constructor(config?: SSHKeyManagerConfig) {
    this.sshDir = config?.sshDir ?? join(homedir(), ".ssh");
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /**
   * Ensure a path is within ~/.ssh/ to prevent path traversal.
   */
  private assertScopedPath(filePath: string): string {
    const resolved = resolve(this.sshDir, filePath);
    if (!resolved.startsWith(this.sshDir)) {
      throw new Error(`Path traversal blocked: ${filePath} resolves outside ${this.sshDir}`);
    }
    return resolved;
  }

  /**
   * Ensure the ~/.ssh directory exists with proper permissions.
   */
  private async ensureSshDir(): Promise<void> {
    if (!existsSync(this.sshDir)) {
      await mkdir(this.sshDir, { mode: 0o700, recursive: true });
    }
  }

  /**
   * Parse ssh-keygen -l output to extract key info.
   */
  private parseKeyFingerprint(output: string): { bits: number | null; fingerprint: string; comment: string; type: string } {
    // Format: "256 SHA256:xxxx comment (ED25519)"
    const match = output.match(/^(\d+)\s+(SHA256:\S+)\s+(.*?)\s+\((\w+)\)\s*$/);
    if (match) {
      return {
        bits: parseInt(match[1], 10),
        fingerprint: match[2],
        comment: match[3],
        type: match[4].toLowerCase(),
      };
    }
    return { bits: null, fingerprint: "unknown", comment: "", type: "unknown" };
  }

  // --------------------------------------------------------------------------
  // Key Operations
  // --------------------------------------------------------------------------

  /**
   * List all SSH keys in ~/.ssh/ (public keys only, NEVER private).
   */
  async listKeys(): Promise<SSHKeyInfo[]> {
    await this.ensureSshDir();

    const files = await readdir(this.sshDir);
    const pubFiles = files.filter((f) => f.endsWith(".pub"));
    const keys: SSHKeyInfo[] = [];

    for (const pubFile of pubFiles) {
      const pubPath = join(this.sshDir, pubFile);
      const privPath = join(this.sshDir, pubFile.replace(/\.pub$/, ""));
      const keyName = pubFile.replace(/\.pub$/, "");

      try {
        const { stdout } = await execFile("ssh-keygen", ["-l", "-f", pubPath]);
        const info = this.parseKeyFingerprint(stdout.trim());
        const fileStat = await stat(pubPath);

        keys.push({
          name: keyName,
          type: info.type,
          bits: info.bits,
          fingerprint: info.fingerprint,
          publicKeyPath: pubPath,
          privateKeyPath: privPath,
          comment: info.comment,
          createdAt: fileStat.birthtime.toISOString(),
        });
      } catch {
        // Skip files that aren't valid SSH keys
        keys.push({
          name: keyName,
          type: "unknown",
          bits: null,
          fingerprint: "unreadable",
          publicKeyPath: pubPath,
          privateKeyPath: privPath,
          comment: "",
          createdAt: "",
        });
      }
    }

    return keys;
  }

  /**
   * Generate a new SSH key pair using ssh-keygen.
   */
  async generateKey(options: GenerateKeyOptions): Promise<SSHKeyInfo> {
    await this.ensureSshDir();

    const keyType = options.type ?? "ed25519";
    const keyPath = this.assertScopedPath(options.name);
    const comment = options.comment ?? `${options.name}@axon`;
    const passphrase = options.passphrase ?? "";

    // Prevent overwriting existing keys
    if (existsSync(keyPath)) {
      throw new Error(`Key already exists: ${options.name}. Delete it first or choose a different name.`);
    }

    const args: string[] = [
      "-t", keyType,
      "-f", keyPath,
      "-C", comment,
      "-N", passphrase,
    ];

    // Add bits for RSA
    if (keyType === "rsa") {
      const bits = options.bits ?? 4096;
      args.push("-b", bits.toString());
    }

    await execFile("ssh-keygen", args);

    // Read back the key info
    const pubPath = `${keyPath}.pub`;
    const { stdout } = await execFile("ssh-keygen", ["-l", "-f", pubPath]);
    const info = this.parseKeyFingerprint(stdout.trim());
    const fileStat = await stat(pubPath);

    return {
      name: options.name,
      type: info.type,
      bits: info.bits,
      fingerprint: info.fingerprint,
      publicKeyPath: pubPath,
      privateKeyPath: keyPath,
      comment: info.comment,
      createdAt: fileStat.birthtime.toISOString(),
    };
  }

  /**
   * Read a public key file content. NEVER reads private keys.
   */
  async getPublicKey(name: string): Promise<{ name: string; publicKey: string; path: string }> {
    const pubPath = this.assertScopedPath(`${name}.pub`);

    if (!existsSync(pubPath)) {
      throw new Error(`Public key not found: ${name}.pub`);
    }

    const content = await readFile(pubPath, "utf-8");
    return {
      name,
      publicKey: content.trim(),
      path: pubPath,
    };
  }

  /**
   * Delete an SSH key pair (both public and private).
   */
  async deleteKey(name: string): Promise<{ deleted: string[]; name: string }> {
    const privPath = this.assertScopedPath(name);
    const pubPath = this.assertScopedPath(`${name}.pub`);
    const deleted: string[] = [];

    if (existsSync(privPath)) {
      await unlink(privPath);
      deleted.push(basename(privPath));
    }

    if (existsSync(pubPath)) {
      await unlink(pubPath);
      deleted.push(basename(pubPath));
    }

    if (deleted.length === 0) {
      throw new Error(`Key not found: ${name}`);
    }

    return { deleted, name };
  }

  // --------------------------------------------------------------------------
  // SSH Config Operations
  // --------------------------------------------------------------------------

  /**
   * Parse ~/.ssh/config and return all host entries.
   */
  async listHosts(): Promise<SSHHostEntry[]> {
    const configPath = join(this.sshDir, "config");

    if (!existsSync(configPath)) {
      return [];
    }

    const content = await readFile(configPath, "utf-8");
    const hosts: SSHHostEntry[] = [];
    let currentHost: SSHHostEntry | null = null;

    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      const match = line.match(/^(\S+)\s+(.+)$/);
      if (!match) continue;

      const key = match[1].toLowerCase();
      const value = match[2].trim();

      if (key === "host") {
        if (currentHost) hosts.push(currentHost);
        currentHost = { host: value };
      } else if (currentHost) {
        // Map common SSH config directives
        const keyMap: Record<string, string> = {
          hostname: "hostname",
          user: "user",
          port: "port",
          identityfile: "identityFile",
          forwardagent: "forwardAgent",
          proxyjump: "proxyJump",
        };
        const mappedKey = keyMap[key] ?? key;
        (currentHost as any)[mappedKey] = value;
      }
    }

    if (currentHost) hosts.push(currentHost);
    return hosts;
  }

  /**
   * Add a host entry to ~/.ssh/config.
   */
  async addHost(entry: SSHHostEntry): Promise<SSHHostEntry> {
    await this.ensureSshDir();
    const configPath = join(this.sshDir, "config");

    // Check for duplicate host
    const existing = await this.listHosts();
    if (existing.some((h) => h.host === entry.host)) {
      throw new Error(`Host "${entry.host}" already exists in SSH config. Remove it first or use a different name.`);
    }

    // Build config block
    const lines: string[] = [
      "",
      `Host ${entry.host}`,
    ];

    const fieldOrder = ["hostname", "user", "port", "identityFile", "forwardAgent", "proxyJump"];
    for (const field of fieldOrder) {
      const value = entry[field];
      if (value !== undefined) {
        // Capitalize first letter for SSH config format
        const configKey = field.charAt(0).toUpperCase() + field.slice(1);
        lines.push(`  ${configKey} ${value}`);
      }
    }

    // Append any remaining non-standard fields
    for (const [key, value] of Object.entries(entry)) {
      if (key === "host" || fieldOrder.includes(key) || value === undefined) continue;
      const configKey = key.charAt(0).toUpperCase() + key.slice(1);
      lines.push(`  ${configKey} ${value}`);
    }

    lines.push("");

    let existingContent = "";
    if (existsSync(configPath)) {
      existingContent = await readFile(configPath, "utf-8");
    }

    await writeFile(configPath, existingContent + lines.join("\n"), { mode: 0o600 });

    return entry;
  }

  /**
   * Test SSH connection to a host using `ssh -T`.
   */
  async testConnection(host: string, timeoutSeconds?: number): Promise<{ host: string; success: boolean; output: string; exitCode: number }> {
    const timeout = timeoutSeconds ?? 10;

    try {
      const { stdout, stderr } = await execFile("ssh", [
        "-T",
        "-o", `ConnectTimeout=${timeout}`,
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "BatchMode=yes",
        host,
      ], { timeout: (timeout + 5) * 1000 });

      return {
        host,
        success: true,
        output: (stdout || stderr).trim(),
        exitCode: 0,
      };
    } catch (err: any) {
      // ssh -T returns non-zero for many valid connections (e.g., GitHub returns 1)
      const output = (err.stdout || err.stderr || err.message).trim();
      const exitCode = err.code ?? 1;

      // GitHub, GitLab, etc. return exit code 1 with a success message
      const isActuallySuccess = /successfully authenticated|welcome|hi /i.test(output);

      return {
        host,
        success: isActuallySuccess,
        output,
        exitCode: typeof exitCode === "number" ? exitCode : 1,
      };
    }
  }
}
