/**
 * AXON File System Manager — Core Implementation
 *
 * Provides safe file system operations scoped to a configurable root directory.
 * All path operations are validated to prevent path traversal attacks (../).
 *
 * Uses only Node.js built-in APIs: fs, path, os.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface FileSystemManagerConfig {
  /** Root directory — all operations are scoped to this path */
  rootDir: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  modified: string;
}

export interface FileInfo {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  created: string;
  modified: string;
  accessed: string;
  permissions: string;
  isReadable: boolean;
  isWritable: boolean;
}

export interface SearchResult {
  path: string;
  type: "file" | "directory";
}

export interface TextSearchMatch {
  file: string;
  line: number;
  content: string;
}

export interface TextSearchResult {
  pattern: string;
  matches: TextSearchMatch[];
  filesSearched: number;
  filesMatched: number;
}

// ============================================================================
// FileSystemManager
// ============================================================================

export class FileSystemManager {
  private readonly rootDir: string;

  constructor(config: FileSystemManagerConfig) {
    // Resolve to absolute path
    this.rootDir = path.resolve(config.rootDir);

    // Ensure root directory exists
    if (!fs.existsSync(this.rootDir)) {
      throw new Error(`Root directory does not exist: ${this.rootDir}`);
    }

    const stat = fs.statSync(this.rootDir);
    if (!stat.isDirectory()) {
      throw new Error(`Root path is not a directory: ${this.rootDir}`);
    }
  }

  /** Get the configured root directory */
  get root(): string {
    return this.rootDir;
  }

  // ==========================================================================
  // Path Security
  // ==========================================================================

  /**
   * Resolve a user-provided path relative to rootDir and validate
   * it doesn't escape via path traversal.
   * Returns the resolved absolute path.
   */
  resolveSafe(userPath: string): string {
    // If the path is absolute, use it directly; otherwise resolve relative to rootDir
    const resolved = path.isAbsolute(userPath)
      ? path.resolve(userPath)
      : path.resolve(this.rootDir, userPath);

    // Ensure the resolved path is within rootDir
    const relative = path.relative(this.rootDir, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(
        `Path traversal denied: "${userPath}" resolves outside root directory`
      );
    }

    return resolved;
  }

  /**
   * Get the path relative to rootDir for display purposes.
   */
  relativePath(absolutePath: string): string {
    return path.relative(this.rootDir, absolutePath);
  }

  // ==========================================================================
  // Operations
  // ==========================================================================

  /**
   * List directory contents with metadata.
   */
  async listDirectory(dirPath: string): Promise<DirectoryEntry[]> {
    const resolved = this.resolveSafe(dirPath);
    const entries = await fsp.readdir(resolved, { withFileTypes: true });

    const results: DirectoryEntry[] = [];

    for (const entry of entries) {
      const fullPath = path.join(resolved, entry.name);
      try {
        const stat = await fsp.stat(fullPath);
        let type: DirectoryEntry["type"] = "other";
        if (entry.isFile()) type = "file";
        else if (entry.isDirectory()) type = "directory";
        else if (entry.isSymbolicLink()) type = "symlink";

        results.push({
          name: entry.name,
          path: this.relativePath(fullPath),
          type,
          size: stat.size,
          modified: stat.mtime.toISOString(),
        });
      } catch {
        // Skip entries we can't stat (e.g., broken symlinks)
        results.push({
          name: entry.name,
          path: this.relativePath(fullPath),
          type: "other",
          size: 0,
          modified: "",
        });
      }
    }

    return results;
  }

  /**
   * Read file contents. Returns text or base64 for binary files.
   */
  async readFile(
    filePath: string,
    encoding?: string
  ): Promise<{ content: string; encoding: "utf-8" | "base64"; size: number }> {
    const resolved = this.resolveSafe(filePath);
    const stat = await fsp.stat(resolved);

    if (!stat.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }

    // Determine if file is likely binary
    const isBinary = await this.isBinaryFile(resolved);

    if (isBinary || encoding === "base64") {
      const buffer = await fsp.readFile(resolved);
      return {
        content: buffer.toString("base64"),
        encoding: "base64",
        size: stat.size,
      };
    }

    const content = await fsp.readFile(resolved, "utf-8");
    return {
      content,
      encoding: "utf-8",
      size: stat.size,
    };
  }

  /**
   * Write content to a file. Creates parent directories if needed.
   */
  async writeFile(
    filePath: string,
    content: string,
    encoding?: "utf-8" | "base64"
  ): Promise<{ path: string; size: number }> {
    const resolved = this.resolveSafe(filePath);

    // Ensure parent directory exists
    await fsp.mkdir(path.dirname(resolved), { recursive: true });

    if (encoding === "base64") {
      const buffer = Buffer.from(content, "base64");
      await fsp.writeFile(resolved, buffer);
      return { path: this.relativePath(resolved), size: buffer.length };
    }

    await fsp.writeFile(resolved, content, "utf-8");
    const stat = await fsp.stat(resolved);
    return { path: this.relativePath(resolved), size: stat.size };
  }

  /**
   * Create a directory (recursive by default).
   */
  async createDirectory(dirPath: string): Promise<{ path: string }> {
    const resolved = this.resolveSafe(dirPath);
    await fsp.mkdir(resolved, { recursive: true });
    return { path: this.relativePath(resolved) };
  }

  /**
   * Move/rename a file or directory.
   */
  async move(
    sourcePath: string,
    destPath: string
  ): Promise<{ source: string; destination: string }> {
    const resolvedSource = this.resolveSafe(sourcePath);
    const resolvedDest = this.resolveSafe(destPath);

    // Ensure source exists
    await fsp.access(resolvedSource);

    // Ensure destination parent directory exists
    await fsp.mkdir(path.dirname(resolvedDest), { recursive: true });

    await fsp.rename(resolvedSource, resolvedDest);
    return {
      source: this.relativePath(resolvedSource),
      destination: this.relativePath(resolvedDest),
    };
  }

  /**
   * Copy a file or directory.
   */
  async copy(
    sourcePath: string,
    destPath: string
  ): Promise<{ source: string; destination: string }> {
    const resolvedSource = this.resolveSafe(sourcePath);
    const resolvedDest = this.resolveSafe(destPath);

    // Ensure source exists
    await fsp.access(resolvedSource);

    // Ensure destination parent directory exists
    await fsp.mkdir(path.dirname(resolvedDest), { recursive: true });

    const stat = await fsp.stat(resolvedSource);
    if (stat.isDirectory()) {
      await this.copyDirRecursive(resolvedSource, resolvedDest);
    } else {
      await fsp.copyFile(resolvedSource, resolvedDest);
    }

    return {
      source: this.relativePath(resolvedSource),
      destination: this.relativePath(resolvedDest),
    };
  }

  /**
   * Delete a file or directory.
   */
  async delete(targetPath: string): Promise<{ path: string; type: string }> {
    const resolved = this.resolveSafe(targetPath);
    const stat = await fsp.stat(resolved);

    if (stat.isDirectory()) {
      await fsp.rm(resolved, { recursive: true, force: true });
      return { path: this.relativePath(resolved), type: "directory" };
    }

    await fsp.unlink(resolved);
    return { path: this.relativePath(resolved), type: "file" };
  }

  /**
   * Search files by glob-like pattern using recursive directory traversal.
   * Supports * and ** wildcards.
   */
  async searchFiles(
    pattern: string,
    searchPath?: string
  ): Promise<SearchResult[]> {
    const baseDir = searchPath
      ? this.resolveSafe(searchPath)
      : this.rootDir;
    const results: SearchResult[] = [];
    const regex = this.globToRegex(pattern);

    await this.walkDirectory(baseDir, (filePath, isDir) => {
      const rel = this.relativePath(filePath);
      if (regex.test(rel) || regex.test(path.basename(filePath))) {
        results.push({
          path: rel,
          type: isDir ? "directory" : "file",
        });
      }
    });

    return results;
  }

  /**
   * Get detailed file/directory metadata.
   */
  async getFileInfo(filePath: string): Promise<FileInfo> {
    const resolved = this.resolveSafe(filePath);
    const stat = await fsp.stat(resolved);
    const lstat = await fsp.lstat(resolved);

    let type: FileInfo["type"] = "other";
    if (stat.isFile()) type = "file";
    else if (stat.isDirectory()) type = "directory";
    else if (lstat.isSymbolicLink()) type = "symlink";

    // Format permissions as octal string
    const permissions = "0" + (stat.mode & 0o777).toString(8);

    // Check read/write access
    let isReadable = false;
    let isWritable = false;
    try {
      await fsp.access(resolved, fs.constants.R_OK);
      isReadable = true;
    } catch {}
    try {
      await fsp.access(resolved, fs.constants.W_OK);
      isWritable = true;
    } catch {}

    return {
      name: path.basename(resolved),
      path: this.relativePath(resolved),
      type,
      size: stat.size,
      created: stat.birthtime.toISOString(),
      modified: stat.mtime.toISOString(),
      accessed: stat.atime.toISOString(),
      permissions,
      isReadable,
      isWritable,
    };
  }

  /**
   * Search for text content within files (grep-like).
   */
  async findText(
    pattern: string,
    searchPath?: string,
    options?: { caseSensitive?: boolean; maxResults?: number; filePattern?: string }
  ): Promise<TextSearchResult> {
    const baseDir = searchPath
      ? this.resolveSafe(searchPath)
      : this.rootDir;

    const caseSensitive = options?.caseSensitive ?? false;
    const maxResults = options?.maxResults ?? 500;
    const filePattern = options?.filePattern;
    const fileRegex = filePattern ? this.globToRegex(filePattern) : null;

    const flags = caseSensitive ? "g" : "gi";
    const regex = new RegExp(this.escapeRegex(pattern), flags);

    const matches: TextSearchMatch[] = [];
    let filesSearched = 0;
    const matchedFiles = new Set<string>();

    await this.walkDirectory(baseDir, async (filePath, isDir) => {
      if (isDir) return;
      if (matches.length >= maxResults) return;

      // Apply file pattern filter
      if (fileRegex) {
        const rel = this.relativePath(filePath);
        const baseName = path.basename(filePath);
        if (!fileRegex.test(rel) && !fileRegex.test(baseName)) return;
      }

      // Skip binary files
      const isBin = await this.isBinaryFile(filePath);
      if (isBin) return;

      filesSearched++;

      try {
        const content = await fsp.readFile(filePath, "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= maxResults) break;
          if (regex.test(lines[i])) {
            matchedFiles.add(filePath);
            matches.push({
              file: this.relativePath(filePath),
              line: i + 1,
              content: lines[i].substring(0, 500), // Truncate long lines
            });
          }
          // Reset regex lastIndex for global flag
          regex.lastIndex = 0;
        }
      } catch {
        // Skip files we can't read
      }
    });

    return {
      pattern,
      matches,
      filesSearched,
      filesMatched: matchedFiles.size,
    };
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /**
   * Check if a file is likely binary by reading its first few bytes.
   */
  private async isBinaryFile(filePath: string): Promise<boolean> {
    try {
      const fd = await fsp.open(filePath, "r");
      const buffer = Buffer.alloc(512);
      const { bytesRead } = await fd.read(buffer, 0, 512, 0);
      await fd.close();

      if (bytesRead === 0) return false;

      // Check for null bytes — a strong indicator of binary content
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0) return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Recursively walk a directory, calling the callback for each entry.
   */
  private async walkDirectory(
    dir: string,
    callback: (filePath: string, isDir: boolean) => void | Promise<void>
  ): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      // Skip common large/irrelevant directories
      if (
        entry.isDirectory() &&
        (entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === "dist" ||
          entry.name === ".next" ||
          entry.name === "__pycache__")
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        await callback(fullPath, true);
        await this.walkDirectory(fullPath, callback);
      } else if (entry.isFile()) {
        await callback(fullPath, false);
      }
    }
  }

  /**
   * Recursively copy a directory.
   */
  private async copyDirRecursive(src: string, dest: string): Promise<void> {
    await fsp.mkdir(dest, { recursive: true });
    const entries = await fsp.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await this.copyDirRecursive(srcPath, destPath);
      } else {
        await fsp.copyFile(srcPath, destPath);
      }
    }
  }

  /**
   * Convert a simple glob pattern to a RegExp.
   * Supports * (any chars except /) and ** (any chars including /).
   */
  private globToRegex(pattern: string): RegExp {
    let regexStr = "";
    let i = 0;

    while (i < pattern.length) {
      const char = pattern[i];

      if (char === "*") {
        if (pattern[i + 1] === "*") {
          // ** matches everything including /
          regexStr += ".*";
          i += 2;
          // Skip optional trailing /
          if (pattern[i] === "/") i++;
        } else {
          // * matches everything except /
          regexStr += "[^/]*";
          i++;
        }
      } else if (char === "?") {
        regexStr += "[^/]";
        i++;
      } else if (char === ".") {
        regexStr += "\\.";
        i++;
      } else {
        regexStr += char;
        i++;
      }
    }

    return new RegExp(regexStr, "i");
  }

  /**
   * Escape a string for use in a RegExp.
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
