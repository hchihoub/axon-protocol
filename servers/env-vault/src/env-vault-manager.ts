/**
 * AXON ENV/Secrets Vault Manager — Core .env File Operations
 *
 * Manages .env files across projects: scanning, reading, writing,
 * comparing, and detecting potential leaked secrets.
 *
 * SECURITY:
 *   - Values are MASKED by default (shown as ****) in all listings
 *   - Only explicit get_env_value calls return actual values
 *   - Secret detection uses regex patterns for known API key formats
 *   - Summarizers NEVER include secret values
 */

import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative, basename } from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface EnvFile {
  path: string;
  relativePath: string;
  name: string;
  size: number;
  variableCount: number;
  lastModified: string;
}

export interface EnvVariable {
  key: string;
  value: string;
  masked: string;
  line: number;
}

export interface EnvReadResult {
  path: string;
  variables: EnvVariable[];
  count: number;
}

export interface SecretMatch {
  file: string;
  key: string;
  pattern: string;
  line: number;
  severity: "high" | "medium" | "low";
}

export interface EnvComparison {
  fileA: string;
  fileB: string;
  onlyInA: string[];
  onlyInB: string[];
  different: { key: string; inA: string; inB: string }[];
  same: string[];
}

export interface EnvVaultConfig {
  /** Root directory for scanning (default: cwd or AXON_VAULT_ROOT) */
  rootDir?: string;
  /** Max directory depth for scanning (default: 5) */
  maxDepth?: number;
}

// ============================================================================
// Secret Detection Patterns
// ============================================================================

interface SecretPattern {
  name: string;
  regex: RegExp;
  severity: "high" | "medium" | "low";
}

const SECRET_PATTERNS: SecretPattern[] = [
  // AWS
  { name: "AWS Access Key", regex: /AKIA[0-9A-Z]{16}/, severity: "high" },
  { name: "AWS Secret Key", regex: /[0-9a-zA-Z/+=]{40}/, severity: "medium" },

  // GitHub
  { name: "GitHub Token (ghp)", regex: /ghp_[0-9a-zA-Z]{36}/, severity: "high" },
  { name: "GitHub Token (gho)", regex: /gho_[0-9a-zA-Z]{36}/, severity: "high" },
  { name: "GitHub Token (ghu)", regex: /ghu_[0-9a-zA-Z]{36}/, severity: "high" },
  { name: "GitHub Token (ghs)", regex: /ghs_[0-9a-zA-Z]{36}/, severity: "high" },
  { name: "GitHub Token (ghr)", regex: /ghr_[0-9a-zA-Z]{36}/, severity: "high" },

  // Stripe
  { name: "Stripe Secret Key", regex: /sk_live_[0-9a-zA-Z]{24,}/, severity: "high" },
  { name: "Stripe Publishable Key", regex: /pk_live_[0-9a-zA-Z]{24,}/, severity: "medium" },
  { name: "Stripe Test Key", regex: /sk_test_[0-9a-zA-Z]{24,}/, severity: "low" },

  // Google
  { name: "Google API Key", regex: /AIza[0-9A-Za-z\-_]{35}/, severity: "high" },

  // Slack
  { name: "Slack Token", regex: /xox[bpors]-[0-9a-zA-Z-]{10,}/, severity: "high" },
  { name: "Slack Webhook", regex: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[a-zA-Z0-9]+/, severity: "high" },

  // Generic patterns
  { name: "Private Key", regex: /-----BEGIN\s+(RSA|EC|DSA|OPENSSH)\s+PRIVATE KEY-----/, severity: "high" },
  { name: "Generic API Key", regex: /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?[0-9a-zA-Z]{20,}['"]?/i, severity: "medium" },
  { name: "Generic Secret", regex: /(?:secret|password|passwd|pwd)\s*[:=]\s*['"]?[^\s'"]{8,}['"]?/i, severity: "medium" },
  { name: "Generic Token", regex: /(?:token|access_token|auth_token)\s*[:=]\s*['"]?[0-9a-zA-Z\-_.]{20,}['"]?/i, severity: "medium" },
  { name: "JWT Token", regex: /eyJ[0-9a-zA-Z_-]{10,}\.eyJ[0-9a-zA-Z_-]{10,}\.[0-9a-zA-Z_-]+/, severity: "high" },

  // Database URLs
  { name: "Database URL", regex: /(?:postgres|mysql|mongodb|redis):\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/, severity: "high" },
];

// ============================================================================
// ENV Vault Manager
// ============================================================================

export class EnvVaultManager {
  private readonly rootDir: string;
  private readonly maxDepth: number;

  constructor(config?: EnvVaultConfig) {
    this.rootDir = config?.rootDir ?? process.env.AXON_VAULT_ROOT ?? process.cwd();
    this.maxDepth = config?.maxDepth ?? 5;
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /**
   * Resolve a file path relative to rootDir.
   * Absolute paths pass through; relative paths resolve from rootDir.
   */
  private resolvePath(filePath: string): string {
    if (filePath.startsWith("/")) return filePath;
    return join(this.rootDir, filePath);
  }

  /**
   * Mask a value for display: show first/last char if long enough, else all ****
   */
  private maskValue(value: string): string {
    if (value.length <= 4) return "****";
    return `${value[0]}${"*".repeat(Math.min(value.length - 2, 10))}${value[value.length - 1]}`;
  }

  /**
   * Parse a .env file into key-value pairs.
   */
  private parseEnvContent(content: string): { key: string; value: string; line: number }[] {
    const results: { key: string; value: string; line: number }[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith("#")) continue;

      // Match KEY=VALUE (with optional quotes)
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (match) {
        let value = match[2].trim();
        // Remove surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        results.push({ key: match[1], value, line: i + 1 });
      }
    }

    return results;
  }

  /**
   * Recursively scan for .env files in a directory.
   */
  private async scanDirectory(dir: string, depth: number): Promise<string[]> {
    if (depth > this.maxDepth) return [];

    const envFiles: string[] = [];

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          // Skip common non-project directories
          const skip = ["node_modules", ".git", "dist", "build", ".next", "__pycache__", "venv", ".venv", ".tox", "vendor"];
          if (skip.includes(entry.name)) continue;
          const subFiles = await this.scanDirectory(fullPath, depth + 1);
          envFiles.push(...subFiles);
        } else if (entry.isFile() && /^\.env(\..+)?$/.test(entry.name)) {
          envFiles.push(fullPath);
        }
      }
    } catch {
      // Permission denied or other read errors — skip
    }

    return envFiles;
  }

  // --------------------------------------------------------------------------
  // Public Operations
  // --------------------------------------------------------------------------

  /**
   * Scan a directory tree for all .env files.
   */
  async scanEnvFiles(directory?: string): Promise<EnvFile[]> {
    const scanDir = directory ? resolve(directory) : this.rootDir;
    const files = await this.scanDirectory(scanDir, 0);
    const results: EnvFile[] = [];

    for (const filePath of files) {
      try {
        const content = await readFile(filePath, "utf-8");
        const fileStat = await stat(filePath);
        const parsed = this.parseEnvContent(content);

        results.push({
          path: filePath,
          relativePath: relative(scanDir, filePath),
          name: basename(filePath),
          size: fileStat.size,
          variableCount: parsed.length,
          lastModified: fileStat.mtime.toISOString(),
        });
      } catch {
        // Skip unreadable files
      }
    }

    return results;
  }

  /**
   * Read an .env file. Values are masked by default.
   */
  async readEnv(filePath: string, showValues?: boolean): Promise<EnvReadResult> {
    const resolved = this.resolvePath(filePath);

    if (!existsSync(resolved)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const content = await readFile(resolved, "utf-8");
    const parsed = this.parseEnvContent(content);

    const variables: EnvVariable[] = parsed.map((p) => ({
      key: p.key,
      value: showValues ? p.value : "",
      masked: this.maskValue(p.value),
      line: p.line,
    }));

    return {
      path: resolved,
      variables,
      count: variables.length,
    };
  }

  /**
   * Get a specific env variable value from a file.
   * This is the ONLY method that returns actual values.
   */
  async getEnvValue(filePath: string, key: string): Promise<{ key: string; value: string; path: string; line: number }> {
    const resolved = this.resolvePath(filePath);

    if (!existsSync(resolved)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const content = await readFile(resolved, "utf-8");
    const parsed = this.parseEnvContent(content);
    const entry = parsed.find((p) => p.key === key);

    if (!entry) {
      throw new Error(`Variable "${key}" not found in ${filePath}`);
    }

    return {
      key: entry.key,
      value: entry.value,
      path: resolved,
      line: entry.line,
    };
  }

  /**
   * Set or update a variable in an .env file.
   */
  async setEnvValue(filePath: string, key: string, value: string): Promise<{ key: string; path: string; action: "created" | "updated" }> {
    const resolved = this.resolvePath(filePath);

    let content = "";
    let action: "created" | "updated" = "created";

    if (existsSync(resolved)) {
      content = await readFile(resolved, "utf-8");
    }

    // Check if key already exists
    const lines = content.split("\n");
    let found = false;
    const newLines = lines.map((line) => {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (match && match[1] === key) {
        found = true;
        action = "updated";
        // Determine if we need quotes
        const needsQuotes = /[\s#"']/.test(value) || value.length === 0;
        return `${key}=${needsQuotes ? `"${value}"` : value}`;
      }
      return line;
    });

    if (!found) {
      // Append new variable
      const needsQuotes = /[\s#"']/.test(value) || value.length === 0;
      const newLine = `${key}=${needsQuotes ? `"${value}"` : value}`;
      if (content.length > 0 && !content.endsWith("\n")) {
        newLines.push("");
      }
      newLines.push(newLine);
    }

    await writeFile(resolved, newLines.join("\n"), "utf-8");

    return { key, path: resolved, action };
  }

  /**
   * Remove a variable from an .env file.
   */
  async deleteEnvValue(filePath: string, key: string): Promise<{ key: string; path: string; deleted: boolean }> {
    const resolved = this.resolvePath(filePath);

    if (!existsSync(resolved)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const content = await readFile(resolved, "utf-8");
    const lines = content.split("\n");
    let deleted = false;

    const newLines = lines.filter((line) => {
      const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (match && match[1] === key) {
        deleted = true;
        return false;
      }
      return true;
    });

    if (!deleted) {
      throw new Error(`Variable "${key}" not found in ${filePath}`);
    }

    await writeFile(resolved, newLines.join("\n"), "utf-8");

    return { key, path: resolved, deleted: true };
  }

  /**
   * Scan files for potential secrets using known patterns.
   */
  async detectSecrets(directory?: string, fileGlobs?: string[]): Promise<SecretMatch[]> {
    const scanDir = directory ? resolve(directory) : this.rootDir;
    const envFiles = await this.scanDirectory(scanDir, 0);
    const matches: SecretMatch[] = [];

    for (const filePath of envFiles) {
      try {
        const content = await readFile(filePath, "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line || line.startsWith("#")) continue;

          // Extract value from KEY=VALUE
          const envMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
          if (!envMatch) continue;

          const envKey = envMatch[1];
          const envValue = envMatch[2].replace(/^['"]|['"]$/g, "");

          for (const pattern of SECRET_PATTERNS) {
            if (pattern.regex.test(envValue)) {
              matches.push({
                file: relative(scanDir, filePath),
                key: envKey,
                pattern: pattern.name,
                line: i + 1,
                severity: pattern.severity,
              });
              break; // One match per variable is enough
            }
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Sort by severity (high first)
    const severityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    matches.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    return matches;
  }

  /**
   * Compare two .env files (show missing/different keys).
   */
  async compareEnvs(fileA: string, fileB: string): Promise<EnvComparison> {
    const resolvedA = this.resolvePath(fileA);
    const resolvedB = this.resolvePath(fileB);

    if (!existsSync(resolvedA)) throw new Error(`File not found: ${fileA}`);
    if (!existsSync(resolvedB)) throw new Error(`File not found: ${fileB}`);

    const contentA = await readFile(resolvedA, "utf-8");
    const contentB = await readFile(resolvedB, "utf-8");

    const parsedA = this.parseEnvContent(contentA);
    const parsedB = this.parseEnvContent(contentB);

    const mapA = new Map(parsedA.map((p) => [p.key, p.value]));
    const mapB = new Map(parsedB.map((p) => [p.key, p.value]));

    const onlyInA: string[] = [];
    const onlyInB: string[] = [];
    const different: { key: string; inA: string; inB: string }[] = [];
    const same: string[] = [];

    for (const [key, value] of mapA) {
      if (!mapB.has(key)) {
        onlyInA.push(key);
      } else if (mapB.get(key) !== value) {
        different.push({
          key,
          inA: this.maskValue(value),
          inB: this.maskValue(mapB.get(key)!),
        });
      } else {
        same.push(key);
      }
    }

    for (const key of mapB.keys()) {
      if (!mapA.has(key)) {
        onlyInB.push(key);
      }
    }

    return {
      fileA: resolvedA,
      fileB: resolvedB,
      onlyInA,
      onlyInB,
      different,
      same,
    };
  }
}
