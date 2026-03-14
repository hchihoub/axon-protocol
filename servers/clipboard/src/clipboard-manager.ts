/**
 * AXON Clipboard Manager — Core Implementation
 *
 * Cross-platform clipboard management with persistent history.
 * Uses system commands for clipboard access:
 *   - macOS: pbcopy / pbpaste
 *   - Linux: xclip -selection clipboard
 *   - Windows: PowerShell Get-Clipboard / Set-Clipboard
 *
 * History is stored in memory and persisted to ~/.axon/clipboard-history.json.
 * Entries can be pinned to prevent eviction when the history reaches max size.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const execFileAsync = promisify(execFile);

// ============================================================================
// Types
// ============================================================================

export interface ClipboardEntry {
  /** Unique ID for the entry */
  id: string;
  /** The clipboard text content */
  content: string;
  /** Timestamp when the entry was captured (ISO 8601) */
  timestamp: string;
  /** Whether this entry is pinned (won't be evicted) */
  pinned: boolean;
  /** Character count */
  length: number;
}

export interface ClipboardManagerConfig {
  /** Maximum number of history entries to keep (default: 100) */
  maxHistory?: number;
  /** Path to the history persistence file (default: ~/.axon/clipboard-history.json) */
  historyPath?: string;
}

interface PlatformCommands {
  getClipboard: () => Promise<string>;
  setClipboard: (text: string) => Promise<void>;
}

// ============================================================================
// ClipboardManager
// ============================================================================

export class ClipboardManager {
  private history: ClipboardEntry[] = [];
  private maxHistory: number;
  private historyPath: string;
  private platform: PlatformCommands;
  private idCounter = 0;

  constructor(config?: ClipboardManagerConfig) {
    this.maxHistory = config?.maxHistory ?? 100;

    const axonDir = path.join(os.homedir(), ".axon");
    this.historyPath = config?.historyPath ?? path.join(axonDir, "clipboard-history.json");

    this.platform = this.detectPlatform();

    // Ensure the .axon directory exists
    const dir = path.dirname(this.historyPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Load persisted history
    this.loadHistory();
  }

  // --------------------------------------------------------------------------
  // Platform Detection
  // --------------------------------------------------------------------------

  private detectPlatform(): PlatformCommands {
    const platform = process.platform;

    if (platform === "darwin") {
      return {
        getClipboard: async () => {
          const { stdout } = await execFileAsync("pbpaste", []);
          return stdout;
        },
        setClipboard: async (text: string) => {
          await new Promise<void>((resolve, reject) => {
            const proc = execFile("pbcopy", [], (err) => {
              if (err) reject(err);
              else resolve();
            });
            proc.stdin?.write(text);
            proc.stdin?.end();
          });
        },
      };
    }

    if (platform === "linux") {
      return {
        getClipboard: async () => {
          const { stdout } = await execFileAsync("xclip", ["-selection", "clipboard", "-o"]);
          return stdout;
        },
        setClipboard: async (text: string) => {
          await new Promise<void>((resolve, reject) => {
            const proc = execFile("xclip", ["-selection", "clipboard"], (err) => {
              if (err) reject(err);
              else resolve();
            });
            proc.stdin?.write(text);
            proc.stdin?.end();
          });
        },
      };
    }

    if (platform === "win32") {
      return {
        getClipboard: async () => {
          const { stdout } = await execFileAsync("powershell.exe", [
            "-NoProfile",
            "-Command",
            "Get-Clipboard",
          ]);
          return stdout;
        },
        setClipboard: async (text: string) => {
          // Escape single quotes for PowerShell
          const escaped = text.replace(/'/g, "''");
          await execFileAsync("powershell.exe", [
            "-NoProfile",
            "-Command",
            `Set-Clipboard -Value '${escaped}'`,
          ]);
        },
      };
    }

    throw new Error(`Unsupported platform: ${platform}`);
  }

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  private loadHistory(): void {
    try {
      if (fs.existsSync(this.historyPath)) {
        const raw = fs.readFileSync(this.historyPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.history = parsed;
          // Restore ID counter from existing entries
          for (const entry of this.history) {
            const num = parseInt(entry.id.replace("clip_", ""), 10);
            if (!isNaN(num) && num >= this.idCounter) {
              this.idCounter = num + 1;
            }
          }
        }
      }
    } catch {
      // If the file is corrupted, start fresh
      this.history = [];
    }
  }

  private saveHistory(): void {
    try {
      fs.writeFileSync(this.historyPath, JSON.stringify(this.history, null, 2), "utf-8");
    } catch {
      // Silently fail — history is still in memory
    }
  }

  private generateId(): string {
    return `clip_${this.idCounter++}`;
  }

  // --------------------------------------------------------------------------
  // Core Operations
  // --------------------------------------------------------------------------

  /**
   * Get the current system clipboard content.
   */
  async getClipboard(): Promise<{ content: string; length: number }> {
    const content = await this.platform.getClipboard();
    return { content, length: content.length };
  }

  /**
   * Set the system clipboard content and add to history.
   */
  async setClipboard(text: string): Promise<ClipboardEntry> {
    await this.platform.setClipboard(text);

    const entry: ClipboardEntry = {
      id: this.generateId(),
      content: text,
      timestamp: new Date().toISOString(),
      pinned: false,
      length: text.length,
    };

    this.addToHistory(entry);
    return entry;
  }

  /**
   * Get clipboard history (most recent N entries).
   */
  getHistory(limit?: number): { entries: ClipboardEntry[]; total: number } {
    const max = limit ?? 20;
    const entries = this.history.slice(0, max);
    return { entries, total: this.history.length };
  }

  /**
   * Search clipboard history by text content.
   */
  searchHistory(query: string): { entries: ClipboardEntry[]; total: number; query: string } {
    const lower = query.toLowerCase();
    const entries = this.history.filter((e) => e.content.toLowerCase().includes(lower));
    return { entries, total: entries.length, query };
  }

  /**
   * Pin a clipboard entry to prevent it from being evicted.
   */
  pinEntry(id: string, pinned?: boolean): ClipboardEntry {
    const entry = this.history.find((e) => e.id === id);
    if (!entry) {
      throw new Error(`Clipboard entry not found: ${id}`);
    }
    entry.pinned = pinned ?? true;
    this.saveHistory();
    return entry;
  }

  /**
   * Clear clipboard history. Optionally keep pinned entries.
   */
  clearHistory(keepPinned?: boolean): { cleared: number; remaining: number } {
    const before = this.history.length;
    if (keepPinned) {
      this.history = this.history.filter((e) => e.pinned);
    } else {
      this.history = [];
    }
    this.saveHistory();
    return { cleared: before - this.history.length, remaining: this.history.length };
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private addToHistory(entry: ClipboardEntry): void {
    // Prepend (most recent first)
    this.history.unshift(entry);

    // Evict oldest unpinned entries if over limit
    while (this.history.length > this.maxHistory) {
      const lastUnpinnedIdx = this.findLastUnpinnedIndex();
      if (lastUnpinnedIdx === -1) break; // All pinned, can't evict
      this.history.splice(lastUnpinnedIdx, 1);
    }

    this.saveHistory();
  }

  private findLastUnpinnedIndex(): number {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (!this.history[i].pinned) return i;
    }
    return -1;
  }
}
