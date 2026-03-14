/**
 * AXON History Analyzer — Chrome Browsing History Automation
 *
 * Automates Chrome's built-in history page (chrome://history)
 * via Puppeteer. Handles:
 *   - Chrome profile detection (macOS, Linux, Windows)
 *   - Shadow DOM piercing (Chrome history page uses nested shadow roots)
 *   - History search, browsing, date filtering, deletion, and analytics
 *
 * IMPORTANT: Chrome must be closed before launching — Puppeteer can't share
 * a profile directory with a running Chrome instance.
 */

import puppeteer, { type Browser, type Page, type ElementHandle } from "puppeteer";
import { platform, homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface HistoryEntry {
  title: string;
  url: string;
  timestamp?: string;
  domain?: string;
  index: number;
}

export interface MostVisitedSite {
  title: string;
  url: string;
  domain: string;
  visitCount: number;
}

export interface HistoryAnalyzerConfig {
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

  return undefined;
}

// ============================================================================
// Shadow DOM Utilities
// ============================================================================

/**
 * Pierce through nested shadow DOMs using a chain of selectors.
 *
 * Chrome history page uses deeply nested web components with shadow roots.
 *   pierceShadow(page, ["history-app", "history-list", ".history-item"])
 */
async function pierceShadow(
  page: Page,
  selectors: string[],
): Promise<ElementHandle | null> {
  if (selectors.length === 0) return null;

  return page.evaluateHandle((...sels: string[]) => {
    let current: Element | ShadowRoot | null = document.querySelector(sels[0]);
    if (!current) return null;

    for (let i = 1; i < sels.length; i++) {
      const sr: ShadowRoot | null = (current as Element).shadowRoot;
      if (sr) {
        current = sr.querySelector(sels[i]);
      } else {
        current = (current as Element).querySelector(sels[i]);
      }
      if (!current) return null;
    }
    return current;
  }, ...selectors) as Promise<ElementHandle | null>;
}

/**
 * Pierce shadow DOM and return all matches at the deepest level.
 */
async function pierceShadowAll(
  page: Page,
  selectors: string[],
): Promise<any[]> {
  if (selectors.length === 0) return [];

  return page.evaluate((...sels: string[]) => {
    let current: Element | ShadowRoot | null = document.querySelector(sels[0]);
    if (!current) return [];

    for (let i = 1; i < sels.length - 1; i++) {
      const sr: ShadowRoot | null = (current as Element).shadowRoot;
      if (sr) {
        current = sr.querySelector(sels[i]);
      } else {
        current = (current as Element).querySelector(sels[i]);
      }
      if (!current) return [];
    }

    const lastSelector = sels[sels.length - 1];
    const root = (current as Element).shadowRoot ?? current;
    const elements = root.querySelectorAll(lastSelector);
    return Array.from(elements).map((el) => ({
      tag: el.tagName.toLowerCase(),
      text: el.textContent?.trim() ?? "",
      id: el.id || undefined,
      className: el.className || undefined,
    }));
  }, ...selectors);
}

/**
 * Wait for an element to appear through shadow DOM chain.
 */
async function waitForShadowElement(
  page: Page,
  selectors: string[],
  timeout = 10000,
): Promise<ElementHandle> {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const el = await pierceShadow(page, selectors);
    if (el) {
      const isNull = await page.evaluate((e) => e === null, el);
      if (!isNull) return el as ElementHandle;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  throw new Error(
    `Timeout waiting for shadow element: ${selectors.join(" >>> ")} (${timeout}ms)`,
  );
}

// ============================================================================
// HistoryAnalyzer Class
// ============================================================================

export class HistoryAnalyzer {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private config: Required<
    Pick<HistoryAnalyzerConfig, "headless" | "profileName">
  > &
    HistoryAnalyzerConfig;

  constructor(config?: HistoryAnalyzerConfig) {
    this.config = {
      headless: false,
      profileName: "Default",
      viewport: { width: 1280, height: 900 },
      ...config,
    };
  }

  get isLaunched(): boolean {
    return this.browser !== null;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async launch(): Promise<void> {
    if (this.browser) return;

    const userDataDir =
      this.config.userDataDir ?? detectChromeDataDir();
    const executablePath =
      this.config.executablePath ?? detectChromePath();

    if (!existsSync(userDataDir)) {
      throw new Error(
        `Chrome profile directory not found: ${userDataDir}\n` +
          `Set AXON_CHROME_PROFILE_DIR or pass userDataDir in config.`,
      );
    }

    this.browser = await puppeteer.launch({
      headless: this.config.headless,
      executablePath,
      userDataDir,
      args: [
        `--profile-directory=${this.config.profileName}`,
        "--no-first-run",
        "--disable-default-apps",
        "--disable-popup-blocking",
      ],
      defaultViewport: this.config.viewport ?? { width: 1280, height: 900 },
    });

    const pages = await this.browser.pages();
    this.page = pages[0] ?? (await this.browser.newPage());
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }

  // --------------------------------------------------------------------------
  // Navigation
  // --------------------------------------------------------------------------

  private async ensurePage(): Promise<Page> {
    if (!this.page || this.page.isClosed()) {
      if (!this.browser) throw new Error("Browser not launched");
      this.page = await this.browser.newPage();
    }
    return this.page;
  }

  private async navigateToHistory(): Promise<Page> {
    const page = await this.ensurePage();
    const url = page.url();

    if (!url.startsWith("chrome://history")) {
      await page.goto("chrome://history", {
        waitUntil: "networkidle2",
        timeout: 15000,
      });
    }

    await page.waitForSelector("history-app", { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 500));
    return page;
  }

  // --------------------------------------------------------------------------
  // History Operations
  // --------------------------------------------------------------------------

  /**
   * Search browsing history by keyword or URL.
   */
  async searchHistory(query: string): Promise<HistoryEntry[]> {
    const page = await this.navigateToHistory();

    // Type in the search field
    const searched = await page.evaluate((searchQuery: string) => {
      const app = document.querySelector("history-app");
      if (!app?.shadowRoot) return false;

      function findSearchInput(root: Element | ShadowRoot, depth = 0): HTMLInputElement | null {
        if (depth > 10) return null;

        const inputs = root.querySelectorAll(
          'input[type="search"], input[aria-label*="search" i], #searchInput, cr-toolbar-search-field, cr-toolbar',
        );
        for (const input of inputs) {
          if (input instanceof HTMLInputElement) return input;
          if (input.shadowRoot) {
            const inner = findSearchInput(input.shadowRoot, depth + 1);
            if (inner) return inner;
          }
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            const found = findSearchInput(el.shadowRoot, depth + 1);
            if (found) return found;
          }
        }
        return null;
      }

      const searchInput = findSearchInput(app.shadowRoot);
      if (searchInput) {
        searchInput.value = searchQuery;
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
        searchInput.dispatchEvent(new Event("change", { bubbles: true }));
        // Also try pressing Enter to trigger search
        searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        return true;
      }
      return false;
    }, query);

    if (searched) {
      await new Promise((r) => setTimeout(r, 1500));
    }

    return this.extractHistoryEntries(page);
  }

  /**
   * Get the most recent N history entries.
   */
  async getRecentHistory(count: number = 50): Promise<HistoryEntry[]> {
    const page = await this.navigateToHistory();

    // Clear any search first
    await page.evaluate(() => {
      const app = document.querySelector("history-app");
      if (!app?.shadowRoot) return;

      function findSearchInput(root: Element | ShadowRoot, depth = 0): HTMLInputElement | null {
        if (depth > 10) return null;

        const inputs = root.querySelectorAll(
          'input[type="search"], input[aria-label*="search" i], cr-toolbar-search-field, cr-toolbar',
        );
        for (const input of inputs) {
          if (input instanceof HTMLInputElement) {
            return input;
          }
          if (input.shadowRoot) {
            const inner = findSearchInput(input.shadowRoot, depth + 1);
            if (inner) return inner;
          }
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            const found = findSearchInput(el.shadowRoot, depth + 1);
            if (found) return found;
          }
        }
        return null;
      }

      const searchInput = findSearchInput(app.shadowRoot);
      if (searchInput && searchInput.value) {
        searchInput.value = "";
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });

    await new Promise((r) => setTimeout(r, 1000));

    // Scroll to load more entries if needed
    for (let i = 0; i < Math.ceil(count / 50); i++) {
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
      await new Promise((r) => setTimeout(r, 500));
    }

    const entries = await this.extractHistoryEntries(page);
    return entries.slice(0, count);
  }

  /**
   * Get history entries for a specific date range.
   */
  async getHistoryByDate(startDate: string, endDate?: string): Promise<HistoryEntry[]> {
    const page = await this.navigateToHistory();

    // Use Chrome's history search with date-based URL parameters
    const start = new Date(startDate);
    const end = endDate ? new Date(endDate) : new Date();

    // Navigate to history with date query
    // Chrome history uses query parameters for search
    const searchQuery = `after:${start.toISOString().split("T")[0]}`;
    await page.evaluate((query: string) => {
      const app = document.querySelector("history-app");
      if (!app?.shadowRoot) return;

      function findSearchInput(root: Element | ShadowRoot, depth = 0): HTMLInputElement | null {
        if (depth > 10) return null;

        const inputs = root.querySelectorAll(
          'input[type="search"], input[aria-label*="search" i], cr-toolbar-search-field, cr-toolbar',
        );
        for (const input of inputs) {
          if (input instanceof HTMLInputElement) return input;
          if (input.shadowRoot) {
            const inner = findSearchInput(input.shadowRoot, depth + 1);
            if (inner) return inner;
          }
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            const found = findSearchInput(el.shadowRoot, depth + 1);
            if (found) return found;
          }
        }
        return null;
      }

      const searchInput = findSearchInput(app.shadowRoot);
      if (searchInput) {
        searchInput.value = query;
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
        searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      }
    }, searchQuery);

    await new Promise((r) => setTimeout(r, 1500));

    const entries = await this.extractHistoryEntries(page);

    // Filter by end date client-side
    if (endDate) {
      const endMs = end.getTime();
      return entries.filter((e) => {
        if (!e.timestamp) return true;
        return new Date(e.timestamp).getTime() <= endMs;
      });
    }

    return entries;
  }

  /**
   * Delete a specific history entry by title or URL.
   */
  async deleteHistoryEntry(titleOrUrl: string): Promise<boolean> {
    const page = await this.navigateToHistory();

    // First search for the entry
    await page.evaluate((query: string) => {
      const app = document.querySelector("history-app");
      if (!app?.shadowRoot) return;

      function findSearchInput(root: Element | ShadowRoot, depth = 0): HTMLInputElement | null {
        if (depth > 10) return null;

        const inputs = root.querySelectorAll(
          'input[type="search"], input[aria-label*="search" i], cr-toolbar-search-field, cr-toolbar',
        );
        for (const input of inputs) {
          if (input instanceof HTMLInputElement) return input;
          if (input.shadowRoot) {
            const inner = findSearchInput(input.shadowRoot, depth + 1);
            if (inner) return inner;
          }
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            const found = findSearchInput(el.shadowRoot, depth + 1);
            if (found) return found;
          }
        }
        return null;
      }

      const searchInput = findSearchInput(app.shadowRoot);
      if (searchInput) {
        searchInput.value = query;
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
        searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      }
    }, titleOrUrl);

    await new Promise((r) => setTimeout(r, 1500));

    // Find the entry and click its checkbox, then delete
    const deleted = await page.evaluate((target: string) => {
      const app = document.querySelector("history-app");
      if (!app?.shadowRoot) return false;

      function findHistoryItems(
        root: Element | ShadowRoot,
        depth = 0,
      ): Element[] {
        if (depth > 12) return [];
        const items: Element[] = [];

        const candidates = root.querySelectorAll(
          "history-item, .history-item, [is='history-item']",
        );
        items.push(...Array.from(candidates));

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            items.push(...findHistoryItems(el.shadowRoot, depth + 1));
          }
        }
        return items;
      }

      const items = findHistoryItems(app.shadowRoot);

      for (const item of items) {
        const text = item.shadowRoot?.textContent?.trim() ??
          item.textContent?.trim() ?? "";
        if (text.includes(target)) {
          // Click the checkbox
          const checkbox = item.shadowRoot?.querySelector(
            'cr-checkbox, input[type="checkbox"], .checkbox',
          ) ?? item.querySelector('cr-checkbox, input[type="checkbox"]');
          if (checkbox) {
            (checkbox as HTMLElement).click();
          }
          return true;
        }
      }
      return false;
    }, titleOrUrl);

    if (!deleted) return false;

    await new Promise((r) => setTimeout(r, 300));

    // Click the delete button
    await page.evaluate(() => {
      const app = document.querySelector("history-app");
      if (!app?.shadowRoot) return;

      function findDeleteButton(
        root: Element | ShadowRoot,
        depth = 0,
      ): Element | null {
        if (depth > 12) return null;

        const buttons = root.querySelectorAll("button, cr-button, #delete-button");
        for (const btn of buttons) {
          const text = btn.textContent?.toLowerCase() ?? "";
          const id = (btn as HTMLElement).id?.toLowerCase() ?? "";
          if (text.includes("delete") || text.includes("remove") ||
              id.includes("delete") || id.includes("remove")) {
            return btn;
          }
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            const found = findDeleteButton(el.shadowRoot, depth + 1);
            if (found) return found;
          }
        }
        return null;
      }

      const deleteBtn = findDeleteButton(app.shadowRoot);
      if (deleteBtn) {
        (deleteBtn as HTMLElement).click();
      }
    });

    await new Promise((r) => setTimeout(r, 500));

    // Confirm deletion if a dialog appears
    await page.evaluate(() => {
      const app = document.querySelector("history-app");
      if (!app?.shadowRoot) return;

      function findConfirmButton(
        root: Element | ShadowRoot,
        depth = 0,
      ): Element | null {
        if (depth > 12) return null;

        const buttons = root.querySelectorAll("button, cr-button, .action-button");
        for (const btn of buttons) {
          const text = btn.textContent?.toLowerCase() ?? "";
          if (text.includes("remove") || text.includes("delete") || text.includes("confirm")) {
            return btn;
          }
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            const found = findConfirmButton(el.shadowRoot, depth + 1);
            if (found) return found;
          }
        }
        return null;
      }

      const confirmBtn = findConfirmButton(app.shadowRoot);
      if (confirmBtn) {
        (confirmBtn as HTMLElement).click();
      }
    });

    await new Promise((r) => setTimeout(r, 500));
    return true;
  }

  /**
   * Clear browsing history for a date range.
   */
  async clearHistory(startDate?: string, endDate?: string): Promise<boolean> {
    const page = await this.ensurePage();

    // Navigate to clear browsing data settings
    await page.goto("chrome://settings/clearBrowserData", {
      waitUntil: "networkidle2",
      timeout: 15000,
    });

    await new Promise((r) => setTimeout(r, 1000));

    // Interact with clear browsing data dialog
    const cleared = await page.evaluate((start: string | undefined, end: string | undefined) => {
      // The settings page uses settings-ui > settings-main > settings-basic-page
      // with a nested clear browsing data dialog
      const settingsUi = document.querySelector("settings-ui");
      if (!settingsUi?.shadowRoot) return false;

      function findElement(
        root: Element | ShadowRoot,
        selectors: string[],
        depth = 0,
      ): Element | null {
        if (depth > 15) return null;

        for (const sel of selectors) {
          const el = root.querySelector(sel);
          if (el) return el;
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            const found = findElement(el.shadowRoot, selectors, depth + 1);
            if (found) return found;
          }
        }
        return null;
      }

      // Find and check the browsing history checkbox
      const historyCheckbox = findElement(settingsUi.shadowRoot, [
        '#browsingCheckbox',
        'cr-checkbox[id*="browsing"]',
        '[aria-label*="browsing history" i]',
      ]);

      if (historyCheckbox) {
        const isChecked = historyCheckbox.hasAttribute("checked") ||
          (historyCheckbox as HTMLInputElement).checked;
        if (!isChecked) {
          (historyCheckbox as HTMLElement).click();
        }
      }

      // Click the "Clear data" button
      const clearBtn = findElement(settingsUi.shadowRoot, [
        '#clearButton',
        '#clearBrowsingDataConfirm',
        'cr-button.action-button',
        '[aria-label*="clear data" i]',
      ]);

      if (clearBtn) {
        (clearBtn as HTMLElement).click();
        return true;
      }
      return false;
    }, startDate, endDate);

    await new Promise((r) => setTimeout(r, 2000));
    return cleared;
  }

  /**
   * Get the most frequently visited sites.
   */
  async getMostVisited(limit: number = 20): Promise<MostVisitedSite[]> {
    const page = await this.navigateToHistory();

    // Get all history entries and compute frequency
    // First scroll to load more entries
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
      await new Promise((r) => setTimeout(r, 500));
    }

    const entries = await this.extractHistoryEntries(page);

    // Aggregate by domain
    const domainMap = new Map<string, { title: string; url: string; domain: string; count: number }>();

    for (const entry of entries) {
      let domain = entry.domain ?? "";
      if (!domain && entry.url) {
        try {
          domain = new URL(entry.url).hostname;
        } catch {
          domain = entry.url;
        }
      }

      if (!domain) continue;

      const existing = domainMap.get(domain);
      if (existing) {
        existing.count++;
      } else {
        domainMap.set(domain, {
          title: entry.title,
          url: entry.url,
          domain,
          count: 1,
        });
      }
    }

    // Sort by visit count descending
    const sorted = Array.from(domainMap.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map((site) => ({
        title: site.title,
        url: site.url,
        domain: site.domain,
        visitCount: site.count,
      }));

    return sorted;
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private async extractHistoryEntries(page: Page): Promise<HistoryEntry[]> {
    return page.evaluate(() => {
      const results: Array<{
        title: string;
        url: string;
        timestamp?: string;
        domain?: string;
        index: number;
      }> = [];

      const app = document.querySelector("history-app");
      if (!app?.shadowRoot) return results;

      function findHistoryItems(
        root: Element | ShadowRoot,
        depth = 0,
      ): Element[] {
        if (depth > 12) return [];
        const items: Element[] = [];

        const candidates = root.querySelectorAll(
          "history-item, .history-item, [is='history-item'], [class*='history-entry']",
        );
        items.push(...Array.from(candidates));

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            items.push(...findHistoryItems(el.shadowRoot, depth + 1));
          }
        }
        return items;
      }

      const items = findHistoryItems(app.shadowRoot);

      items.forEach((item, index) => {
        const innerRoot = item.shadowRoot ?? item;

        // Extract title
        const titleEl = innerRoot.querySelector(
          ".title, #title, [id*='title'], a[href], .website-title",
        );
        const title = titleEl?.textContent?.trim() ?? "";

        // Extract URL
        const urlEl = innerRoot.querySelector(
          ".url, #url, [id*='domain'], .domain, a[href]",
        );
        const url = (urlEl as HTMLAnchorElement)?.href ??
          urlEl?.textContent?.trim() ?? "";

        // Extract timestamp
        const timeEl = innerRoot.querySelector(
          ".time, #time, [id*='time'], .timestamp, time",
        );
        const timestamp = timeEl?.textContent?.trim() ??
          (timeEl as HTMLTimeElement)?.dateTime ?? undefined;

        // Extract domain
        let domain: string | undefined;
        try {
          if (url) domain = new URL(url).hostname;
        } catch {
          domain = undefined;
        }

        if (title || url) {
          results.push({
            title: title || url,
            url,
            timestamp,
            domain,
            index,
          });
        }
      });

      // Fallback: if no items found via specific selectors, try generic text extraction
      if (results.length === 0) {
        const allText = app.shadowRoot.textContent ?? "";
        const lines = allText.split(/\n/).map((l) => l.trim()).filter(Boolean);

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Look for URL-like patterns
          if (line.match(/^https?:\/\//) || line.match(/\.\w{2,}$/)) {
            results.push({
              title: lines[i - 1] ?? line,
              url: line,
              index: results.length,
            });
          }
        }
      }

      return results;
    });
  }
}
