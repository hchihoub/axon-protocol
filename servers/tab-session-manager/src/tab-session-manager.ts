/**
 * AXON Tab Session Manager — Browser Tab & Session Management
 *
 * Manages Chrome tabs and saved sessions via Puppeteer. Handles:
 *   - Chrome profile detection (macOS, Linux, Windows)
 *   - Tab listing, opening, closing, and switching
 *   - Session persistence to ~/.axon/tab-sessions.json
 *
 * IMPORTANT: Chrome must be closed before launching — Puppeteer can't share
 * a profile directory with a running Chrome instance.
 */

import puppeteer, { type Browser, type Page } from "puppeteer";
import { platform, homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface TabInfo {
  index: number;
  title: string;
  url: string;
}

export interface SavedSession {
  name: string;
  tabs: { title: string; url: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface SessionsFile {
  sessions: SavedSession[];
}

export interface TabSessionManagerConfig {
  /** Chrome user data directory (auto-detected if not set) */
  userDataDir?: string;
  /** Chrome profile name within the data dir (default: "Default") */
  profileName?: string;
  /** Path to Chrome/Chromium executable (auto-detected if not set) */
  executablePath?: string;
  /** Run in headless mode (default: false) */
  headless?: boolean;
  /** Viewport dimensions */
  viewport?: { width: number; height: number };
  /** Path to sessions JSON file (default: ~/.axon/tab-sessions.json) */
  sessionsFile?: string;
}

// ============================================================================
// Platform Detection
// ============================================================================

function detectChromeDataDir(): string {
  const home = homedir();
  const os = platform();

  if (os === "darwin") {
    return join(home, "Library", "Application Support", "Google", "Chrome");
  }
  if (os === "linux") {
    return join(home, ".config", "google-chrome");
  }
  if (os === "win32") {
    return join(home, "AppData", "Local", "Google", "Chrome", "User Data");
  }

  throw new Error(`Unsupported platform: ${os}. Set userDataDir manually.`);
}

function detectChromePath(): string | undefined {
  const os = platform();

  const candidates: string[] = [];

  if (os === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else if (os === "linux") {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/snap/bin/chromium",
    );
  } else if (os === "win32") {
    const programFiles = process.env["PROGRAMFILES"] ?? "C:\\Program Files";
    const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
    const localAppData = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
    candidates.push(
      join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    );
  }

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }

  // Let Puppeteer try its bundled Chromium
  return undefined;
}

// ============================================================================
// Tab Session Manager
// ============================================================================

export class TabSessionManager {
  private browser: Browser | null = null;
  private config: TabSessionManagerConfig;
  private sessionsFilePath: string;

  constructor(config: TabSessionManagerConfig = {}) {
    this.config = config;
    this.sessionsFilePath =
      config.sessionsFile ?? join(homedir(), ".axon", "tab-sessions.json");
  }

  get isLaunched(): boolean {
    return this.browser !== null;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async launch(): Promise<void> {
    if (this.browser) return;

    const userDataDir = this.config.userDataDir ?? detectChromeDataDir();
    const profileName = this.config.profileName ?? "Default";
    const profileDir = join(userDataDir, profileName);

    if (!existsSync(profileDir)) {
      throw new Error(
        `Chrome profile not found: ${profileDir}\n` +
          `Available profiles are in: ${userDataDir}\n` +
          `Set AXON_CHROME_PROFILE_NAME or AXON_CHROME_PROFILE_DIR.`,
      );
    }

    const executablePath = this.config.executablePath ?? detectChromePath();
    const viewport = this.config.viewport ?? { width: 1280, height: 900 };

    this.browser = await puppeteer.launch({
      headless: this.config.headless ?? false,
      executablePath,
      userDataDir,
      args: [
        `--profile-directory=${profileName}`,
        `--window-size=${viewport.width},${viewport.height}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
      ],
      defaultViewport: viewport,
    });
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  private ensureBrowser(): Browser {
    if (!this.browser) {
      throw new Error("Browser not launched. Call launch() first.");
    }
    return this.browser;
  }

  // --------------------------------------------------------------------------
  // Tab Operations
  // --------------------------------------------------------------------------

  /**
   * List all open tabs with titles and URLs.
   */
  async listTabs(): Promise<TabInfo[]> {
    const browser = this.ensureBrowser();
    const pages = await browser.pages();

    const tabs: TabInfo[] = [];
    for (let i = 0; i < pages.length; i++) {
      tabs.push({
        index: i,
        title: await pages[i].title(),
        url: pages[i].url(),
      });
    }
    return tabs;
  }

  /**
   * Open a new tab with an optional URL.
   * Returns info about the newly opened tab.
   */
  async openTab(url?: string): Promise<TabInfo> {
    const browser = this.ensureBrowser();
    const page = await browser.newPage();

    if (url) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    }

    const pages = await browser.pages();
    const index = pages.indexOf(page);

    return {
      index: index >= 0 ? index : pages.length - 1,
      title: await page.title(),
      url: page.url(),
    };
  }

  /**
   * Close a tab by index or URL match.
   * Returns true if a tab was closed.
   */
  async closeTab(options: { index?: number; url?: string }): Promise<{ closed: boolean; tab?: TabInfo }> {
    const browser = this.ensureBrowser();
    const pages = await browser.pages();

    let targetPage: Page | undefined;
    let targetIndex = -1;

    if (options.index !== undefined) {
      if (options.index < 0 || options.index >= pages.length) {
        throw new Error(
          `Tab index ${options.index} out of range. Open tabs: 0-${pages.length - 1}`,
        );
      }
      targetPage = pages[options.index];
      targetIndex = options.index;
    } else if (options.url) {
      const query = options.url.toLowerCase();
      for (let i = 0; i < pages.length; i++) {
        if (pages[i].url().toLowerCase().includes(query)) {
          targetPage = pages[i];
          targetIndex = i;
          break;
        }
      }
    }

    if (!targetPage) {
      return { closed: false };
    }

    // Don't close the last tab — it would close the browser
    if (pages.length <= 1) {
      throw new Error("Cannot close the last remaining tab. Use close() to shut down the browser.");
    }

    const tabInfo: TabInfo = {
      index: targetIndex,
      title: await targetPage.title(),
      url: targetPage.url(),
    };

    await targetPage.close();
    return { closed: true, tab: tabInfo };
  }

  /**
   * Bring a tab to focus by index.
   */
  async switchTab(index: number): Promise<TabInfo> {
    const browser = this.ensureBrowser();
    const pages = await browser.pages();

    if (index < 0 || index >= pages.length) {
      throw new Error(
        `Tab index ${index} out of range. Open tabs: 0-${pages.length - 1}`,
      );
    }

    const page = pages[index];
    await page.bringToFront();

    return {
      index,
      title: await page.title(),
      url: page.url(),
    };
  }

  // --------------------------------------------------------------------------
  // Session Persistence
  // --------------------------------------------------------------------------

  private loadSessionsFile(): SessionsFile {
    if (!existsSync(this.sessionsFilePath)) {
      return { sessions: [] };
    }
    try {
      const raw = readFileSync(this.sessionsFilePath, "utf-8");
      return JSON.parse(raw) as SessionsFile;
    } catch {
      return { sessions: [] };
    }
  }

  private saveSessionsFile(data: SessionsFile): void {
    const dir = dirname(this.sessionsFilePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.sessionsFilePath, JSON.stringify(data, null, 2), "utf-8");
  }

  /**
   * Save current open tabs as a named session.
   */
  async saveSession(name: string): Promise<SavedSession> {
    const tabs = await this.listTabs();
    const now = new Date().toISOString();

    const session: SavedSession = {
      name,
      tabs: tabs.map((t) => ({ title: t.title, url: t.url })),
      createdAt: now,
      updatedAt: now,
    };

    const data = this.loadSessionsFile();

    // Replace if session with same name exists
    const existingIndex = data.sessions.findIndex((s) => s.name === name);
    if (existingIndex >= 0) {
      session.createdAt = data.sessions[existingIndex].createdAt;
      data.sessions[existingIndex] = session;
    } else {
      data.sessions.push(session);
    }

    this.saveSessionsFile(data);
    return session;
  }

  /**
   * Restore a saved session by opening all its tabs.
   */
  async restoreSession(name: string): Promise<{ session: SavedSession; openedTabs: TabInfo[] }> {
    const data = this.loadSessionsFile();
    const session = data.sessions.find((s) => s.name === name);

    if (!session) {
      throw new Error(
        `Session "${name}" not found. Available sessions: ${data.sessions.map((s) => s.name).join(", ") || "(none)"}`,
      );
    }

    const openedTabs: TabInfo[] = [];
    for (const tab of session.tabs) {
      // Skip about:blank or empty URLs
      if (!tab.url || tab.url === "about:blank") continue;
      try {
        const opened = await this.openTab(tab.url);
        openedTabs.push(opened);
      } catch (err: any) {
        // Continue opening other tabs even if one fails
        openedTabs.push({
          index: -1,
          title: `[FAILED] ${tab.title}`,
          url: tab.url,
        });
      }
    }

    return { session, openedTabs };
  }

  /**
   * List all saved sessions.
   */
  listSessions(): SavedSession[] {
    const data = this.loadSessionsFile();
    return data.sessions;
  }

  /**
   * Delete a saved session by name.
   */
  deleteSession(name: string): boolean {
    const data = this.loadSessionsFile();
    const initialLength = data.sessions.length;
    data.sessions = data.sessions.filter((s) => s.name !== name);

    if (data.sessions.length === initialLength) {
      return false;
    }

    this.saveSessionsFile(data);
    return true;
  }
}
