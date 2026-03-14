/**
 * AXON Bookmarks Manager — Chrome Bookmarks Automation
 *
 * Automates Chrome's built-in bookmarks page (chrome://bookmarks)
 * via Puppeteer. Handles:
 *   - Chrome profile detection (macOS, Linux, Windows)
 *   - Shadow DOM piercing (Chrome bookmarks page uses nested shadow roots)
 *   - Bookmark CRUD, folder management, search, and export
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

export interface BookmarkEntry {
  title: string;
  url: string;
  id?: string;
  parentFolder?: string;
  dateAdded?: string;
  index: number;
}

export interface BookmarkFolder {
  title: string;
  id?: string;
  children: number;
  index: number;
}

export interface BookmarkTreeNode {
  title: string;
  url?: string;
  id?: string;
  type: "bookmark" | "folder";
  children?: BookmarkTreeNode[];
}

export interface BookmarksManagerConfig {
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

  // Let Puppeteer try its bundled Chromium
  return undefined;
}

// ============================================================================
// Shadow DOM Utilities
// ============================================================================

/**
 * Pierce through nested shadow DOMs using a chain of selectors.
 *
 * Chrome bookmarks page uses deeply nested web components with shadow roots.
 *   pierceShadow(page, ["bookmarks-app", "bookmarks-list", ".bookmark-item"])
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
// BookmarksManager Class
// ============================================================================

export class BookmarksManager {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private config: Required<
    Pick<BookmarksManagerConfig, "headless" | "profileName">
  > &
    BookmarksManagerConfig;

  constructor(config?: BookmarksManagerConfig) {
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

  private async navigateToBookmarks(): Promise<Page> {
    const page = await this.ensurePage();
    const url = page.url();

    if (!url.startsWith("chrome://bookmarks")) {
      await page.goto("chrome://bookmarks", {
        waitUntil: "networkidle2",
        timeout: 15000,
      });
    }

    await page.waitForSelector("bookmarks-app", { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 500));
    return page;
  }

  // --------------------------------------------------------------------------
  // Bookmark Operations
  // --------------------------------------------------------------------------

  /**
   * List all bookmarks and folders.
   * Returns bookmark titles, URLs, and folder structure.
   */
  async listBookmarks(): Promise<BookmarkTreeNode[]> {
    const page = await this.navigateToBookmarks();

    const tree: BookmarkTreeNode[] = await page.evaluate(() => {
      const results: Array<{
        title: string;
        url?: string;
        type: "bookmark" | "folder";
        children?: any[];
      }> = [];

      const app = document.querySelector("bookmarks-app");
      if (!app?.shadowRoot) return results;

      // Recursively search shadow DOM for bookmark items
      function findBookmarkItems(
        root: Element | ShadowRoot,
        depth = 0,
      ): Array<{ title: string; url?: string; type: "bookmark" | "folder" }> {
        if (depth > 12) return [];
        const items: Array<{ title: string; url?: string; type: "bookmark" | "folder" }> = [];

        // Look for bookmark list items
        const bookmarkItems = root.querySelectorAll(
          "bookmarks-item, .bookmark-item, [role='treeitem'], [role='listitem']",
        );

        for (const item of bookmarkItems) {
          const titleEl = item.shadowRoot?.querySelector(".title, .label, [class*='title']") ??
            item.querySelector(".title, .label, [class*='title']");
          const urlEl = item.shadowRoot?.querySelector(".url, .subtitle, [class*='url']") ??
            item.querySelector(".url, .subtitle, [class*='url']");

          const title = titleEl?.textContent?.trim() ?? item.textContent?.trim() ?? "";
          const url = urlEl?.textContent?.trim() ??
            (item as HTMLElement).getAttribute("href") ??
            undefined;

          if (title) {
            const isFolder = item.hasAttribute("is-folder") ||
              item.classList.contains("folder") ||
              item.getAttribute("role") === "treeitem" ||
              !url;
            items.push({
              title,
              url: isFolder ? undefined : url,
              type: isFolder ? "folder" : "bookmark",
            });
          }
        }

        // Recurse into shadow roots
        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            items.push(...findBookmarkItems(el.shadowRoot, depth + 1));
          }
        }
        return items;
      }

      const items = findBookmarkItems(app.shadowRoot);
      return items.map((item, index) => ({
        ...item,
        children: item.type === "folder" ? [] : undefined,
      }));
    });

    return tree;
  }

  /**
   * Search bookmarks by title or URL.
   */
  async searchBookmarks(query: string): Promise<BookmarkEntry[]> {
    const page = await this.navigateToBookmarks();

    // Type in the search field
    const searched = await page.evaluate((searchQuery: string) => {
      const app = document.querySelector("bookmarks-app");
      if (!app?.shadowRoot) return false;

      function findSearchInput(root: Element | ShadowRoot, depth = 0): HTMLInputElement | null {
        if (depth > 10) return null;

        const inputs = root.querySelectorAll(
          'input[type="search"], input[aria-label*="search" i], #searchInput, cr-toolbar-search-field, .search-field input, cr-toolbar',
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
        return true;
      }
      return false;
    }, query);

    if (searched) {
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Extract search results
    const entries: BookmarkEntry[] = await page.evaluate(() => {
      const results: Array<{
        title: string;
        url: string;
        parentFolder?: string;
        index: number;
      }> = [];

      const app = document.querySelector("bookmarks-app");
      if (!app?.shadowRoot) return results;

      function findResultItems(
        root: Element | ShadowRoot,
        depth = 0,
      ): Element[] {
        if (depth > 12) return [];
        const items: Element[] = [];

        const candidates = root.querySelectorAll(
          "bookmarks-item, .bookmark-item, [role='listitem']",
        );
        items.push(...Array.from(candidates));

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            items.push(...findResultItems(el.shadowRoot, depth + 1));
          }
        }
        return items;
      }

      const items = findResultItems(app.shadowRoot);
      items.forEach((item, index) => {
        const shadowText = item.shadowRoot?.textContent?.trim() ??
          item.textContent?.trim() ?? "";
        const lines = shadowText.split(/\n/).map((l) => l.trim()).filter(Boolean);

        const title = lines[0] ?? "";
        const url = lines[1] ?? "";

        if (title) {
          results.push({ title, url, index });
        }
      });

      return results;
    });

    return entries;
  }

  /**
   * Add a new bookmark.
   */
  async addBookmark(title: string, url: string, folder?: string): Promise<BookmarkEntry> {
    const page = await this.navigateToBookmarks();

    // Use Chrome's keyboard shortcut or menu to add a bookmark
    // Open the add dialog through the organize menu or keyboard shortcut
    await page.evaluate((bookmarkTitle: string, bookmarkUrl: string) => {
      const app = document.querySelector("bookmarks-app");
      if (!app?.shadowRoot) return;

      // Try to find the "Add new bookmark" button or menu item
      function findElement(
        root: Element | ShadowRoot,
        selectors: string[],
        depth = 0,
      ): Element | null {
        if (depth > 10) return null;

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

      // Click the "organize" dropdown or "more actions" menu
      const menuButton = findElement(app.shadowRoot, [
        "#menuButton",
        "[id*='menu']",
        "cr-icon-button[iron-icon='cr:more-vert']",
        "cr-icon-button[icon='cr:more-vert']",
        ".more-actions-button",
        "[aria-label*='organize' i]",
        "[aria-label*='menu' i]",
      ]);

      if (menuButton) {
        (menuButton as HTMLElement).click();
      }
    }, title, url);

    await new Promise((r) => setTimeout(r, 500));

    // Try to click "Add new bookmark" in the opened menu
    await page.evaluate(() => {
      const app = document.querySelector("bookmarks-app");
      if (!app?.shadowRoot) return;

      function findMenuItem(
        root: Element | ShadowRoot,
        depth = 0,
      ): Element | null {
        if (depth > 10) return null;

        const items = root.querySelectorAll(
          "button, [role='menuitem'], cr-button",
        );
        for (const item of items) {
          const text = item.textContent?.toLowerCase() ?? "";
          if (text.includes("add new bookmark") || text.includes("add bookmark")) {
            return item;
          }
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            const found = findMenuItem(el.shadowRoot, depth + 1);
            if (found) return found;
          }
        }
        return null;
      }

      const menuItem = findMenuItem(app.shadowRoot);
      if (menuItem) {
        (menuItem as HTMLElement).click();
      }
    });

    await new Promise((r) => setTimeout(r, 500));

    // Fill in the add bookmark dialog
    await page.evaluate((bookmarkTitle: string, bookmarkUrl: string) => {
      const app = document.querySelector("bookmarks-app");
      if (!app?.shadowRoot) return;

      function findDialog(
        root: Element | ShadowRoot,
        depth = 0,
      ): Element | null {
        if (depth > 10) return null;

        const dialogs = root.querySelectorAll(
          "bookmarks-edit-dialog, cr-dialog, dialog, [role='dialog']",
        );
        for (const dialog of dialogs) return dialog;

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            const found = findDialog(el.shadowRoot, depth + 1);
            if (found) return found;
          }
        }
        return null;
      }

      const dialog = findDialog(app.shadowRoot);
      if (!dialog) return;

      const dialogRoot = dialog.shadowRoot ?? dialog;

      // Find and fill name/title input
      function findInputs(root: Element | ShadowRoot): HTMLInputElement[] {
        const inputs: HTMLInputElement[] = [];
        const inputEls = root.querySelectorAll("input, cr-input");
        for (const el of inputEls) {
          if (el instanceof HTMLInputElement) {
            inputs.push(el);
          } else if (el.shadowRoot) {
            const inner = el.shadowRoot.querySelector("input");
            if (inner instanceof HTMLInputElement) inputs.push(inner);
          }
        }
        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            inputs.push(...findInputs(el.shadowRoot));
          }
        }
        return inputs;
      }

      const inputs = findInputs(dialogRoot);
      if (inputs.length >= 1) {
        inputs[0].value = bookmarkTitle;
        inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (inputs.length >= 2) {
        inputs[1].value = bookmarkUrl;
        inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
      }
    }, title, url);

    await new Promise((r) => setTimeout(r, 300));

    // Click save/confirm button
    await page.evaluate(() => {
      const app = document.querySelector("bookmarks-app");
      if (!app?.shadowRoot) return;

      function findSaveButton(
        root: Element | ShadowRoot,
        depth = 0,
      ): Element | null {
        if (depth > 12) return null;

        const buttons = root.querySelectorAll("button, cr-button, .action-button");
        for (const btn of buttons) {
          const text = btn.textContent?.toLowerCase() ?? "";
          if (text.includes("save") || text.includes("done") || text.includes("add")) {
            return btn;
          }
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            const found = findSaveButton(el.shadowRoot, depth + 1);
            if (found) return found;
          }
        }
        return null;
      }

      const saveBtn = findSaveButton(app.shadowRoot);
      if (saveBtn) {
        (saveBtn as HTMLElement).click();
      }
    });

    await new Promise((r) => setTimeout(r, 500));

    return { title, url, index: -1 };
  }

  /**
   * Edit a bookmark's title and/or URL.
   */
  async editBookmark(
    currentTitle: string,
    newTitle?: string,
    newUrl?: string,
  ): Promise<BookmarkEntry> {
    const page = await this.navigateToBookmarks();

    // First find and right-click the target bookmark to get the context menu
    await page.evaluate((targetTitle: string) => {
      const app = document.querySelector("bookmarks-app");
      if (!app?.shadowRoot) return;

      function findBookmarkByTitle(
        root: Element | ShadowRoot,
        depth = 0,
      ): Element | null {
        if (depth > 12) return null;

        const items = root.querySelectorAll(
          "bookmarks-item, .bookmark-item, [role='listitem']",
        );
        for (const item of items) {
          const text = item.shadowRoot?.textContent?.trim() ??
            item.textContent?.trim() ?? "";
          if (text.includes(targetTitle)) return item;
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            const found = findBookmarkByTitle(el.shadowRoot, depth + 1);
            if (found) return found;
          }
        }
        return null;
      }

      const bookmark = findBookmarkByTitle(app.shadowRoot);
      if (bookmark) {
        // Click the 3-dot menu on the bookmark item
        const menuBtn = bookmark.shadowRoot?.querySelector(
          "cr-icon-button, [icon*='more'], .more-vert-button, button[aria-label*='more' i]",
        ) ?? bookmark.querySelector(
          "cr-icon-button, [icon*='more'], .more-vert-button",
        );
        if (menuBtn) {
          (menuBtn as HTMLElement).click();
        } else {
          // Fallback: dispatch context menu event
          bookmark.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
        }
      }
    }, currentTitle);

    await new Promise((r) => setTimeout(r, 500));

    // Click "Edit" in the context/dropdown menu
    await page.evaluate(() => {
      const app = document.querySelector("bookmarks-app");
      if (!app?.shadowRoot) return;

      function findEditMenuItem(
        root: Element | ShadowRoot,
        depth = 0,
      ): Element | null {
        if (depth > 12) return null;

        const items = root.querySelectorAll(
          "button, [role='menuitem'], cr-button",
        );
        for (const item of items) {
          const text = item.textContent?.toLowerCase() ?? "";
          if (text.includes("edit")) return item;
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            const found = findEditMenuItem(el.shadowRoot, depth + 1);
            if (found) return found;
          }
        }
        return null;
      }

      const editItem = findEditMenuItem(app.shadowRoot);
      if (editItem) {
        (editItem as HTMLElement).click();
      }
    });

    await new Promise((r) => setTimeout(r, 500));

    // Fill in the edit dialog
    await page.evaluate((editTitle: string | undefined, editUrl: string | undefined) => {
      const app = document.querySelector("bookmarks-app");
      if (!app?.shadowRoot) return;

      function findInputs(
        root: Element | ShadowRoot,
        depth = 0,
      ): HTMLInputElement[] {
        if (depth > 12) return [];
        const inputs: HTMLInputElement[] = [];

        const inputEls = root.querySelectorAll("input, cr-input");
        for (const el of inputEls) {
          if (el instanceof HTMLInputElement) {
            inputs.push(el);
          } else if (el.shadowRoot) {
            const inner = el.shadowRoot.querySelector("input");
            if (inner instanceof HTMLInputElement) inputs.push(inner);
          }
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            inputs.push(...findInputs(el.shadowRoot, depth + 1));
          }
        }
        return inputs;
      }

      const inputs = findInputs(app.shadowRoot);
      if (editTitle && inputs.length >= 1) {
        inputs[0].value = editTitle;
        inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (editUrl && inputs.length >= 2) {
        inputs[1].value = editUrl;
        inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
      }
    }, newTitle, newUrl);

    await new Promise((r) => setTimeout(r, 300));

    // Click save
    await page.evaluate(() => {
      const app = document.querySelector("bookmarks-app");
      if (!app?.shadowRoot) return;

      function findSaveButton(
        root: Element | ShadowRoot,
        depth = 0,
      ): Element | null {
        if (depth > 12) return null;

        const buttons = root.querySelectorAll("button, cr-button, .action-button");
        for (const btn of buttons) {
          const text = btn.textContent?.toLowerCase() ?? "";
          if (text.includes("save") || text.includes("done")) return btn;
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            const found = findSaveButton(el.shadowRoot, depth + 1);
            if (found) return found;
          }
        }
        return null;
      }

      const saveBtn = findSaveButton(app.shadowRoot);
      if (saveBtn) {
        (saveBtn as HTMLElement).click();
      }
    });

    await new Promise((r) => setTimeout(r, 500));

    return {
      title: newTitle ?? currentTitle,
      url: newUrl ?? "",
      index: -1,
    };
  }

  /**
   * Delete a bookmark by title.
   */
  async deleteBookmark(title: string): Promise<boolean> {
    const page = await this.navigateToBookmarks();

    // Find and right-click the target bookmark
    await page.evaluate((targetTitle: string) => {
      const app = document.querySelector("bookmarks-app");
      if (!app?.shadowRoot) return;

      function findBookmarkByTitle(
        root: Element | ShadowRoot,
        depth = 0,
      ): Element | null {
        if (depth > 12) return null;

        const items = root.querySelectorAll(
          "bookmarks-item, .bookmark-item, [role='listitem']",
        );
        for (const item of items) {
          const text = item.shadowRoot?.textContent?.trim() ??
            item.textContent?.trim() ?? "";
          if (text.includes(targetTitle)) return item;
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            const found = findBookmarkByTitle(el.shadowRoot, depth + 1);
            if (found) return found;
          }
        }
        return null;
      }

      const bookmark = findBookmarkByTitle(app.shadowRoot);
      if (bookmark) {
        const menuBtn = bookmark.shadowRoot?.querySelector(
          "cr-icon-button, [icon*='more'], .more-vert-button, button[aria-label*='more' i]",
        ) ?? bookmark.querySelector("cr-icon-button, [icon*='more']");
        if (menuBtn) {
          (menuBtn as HTMLElement).click();
        } else {
          bookmark.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
        }
      }
    }, title);

    await new Promise((r) => setTimeout(r, 500));

    // Click "Delete" in the context menu
    const deleted = await page.evaluate(() => {
      const app = document.querySelector("bookmarks-app");
      if (!app?.shadowRoot) return false;

      function findDeleteMenuItem(
        root: Element | ShadowRoot,
        depth = 0,
      ): Element | null {
        if (depth > 12) return null;

        const items = root.querySelectorAll(
          "button, [role='menuitem'], cr-button",
        );
        for (const item of items) {
          const text = item.textContent?.toLowerCase() ?? "";
          if (text.includes("delete") || text.includes("remove")) return item;
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            const found = findDeleteMenuItem(el.shadowRoot, depth + 1);
            if (found) return found;
          }
        }
        return null;
      }

      const deleteItem = findDeleteMenuItem(app.shadowRoot);
      if (deleteItem) {
        (deleteItem as HTMLElement).click();
        return true;
      }
      return false;
    });

    await new Promise((r) => setTimeout(r, 500));
    return deleted;
  }

  /**
   * Create a bookmark folder.
   */
  async createFolder(name: string, parentFolder?: string): Promise<BookmarkFolder> {
    const page = await this.navigateToBookmarks();

    // Open the organize menu
    await page.evaluate(() => {
      const app = document.querySelector("bookmarks-app");
      if (!app?.shadowRoot) return;

      function findElement(
        root: Element | ShadowRoot,
        selectors: string[],
        depth = 0,
      ): Element | null {
        if (depth > 10) return null;

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

      const menuButton = findElement(app.shadowRoot, [
        "#menuButton",
        "[id*='menu']",
        "cr-icon-button[iron-icon='cr:more-vert']",
        "cr-icon-button[icon='cr:more-vert']",
        ".more-actions-button",
        "[aria-label*='organize' i]",
      ]);

      if (menuButton) {
        (menuButton as HTMLElement).click();
      }
    });

    await new Promise((r) => setTimeout(r, 500));

    // Click "Add new folder"
    await page.evaluate(() => {
      const app = document.querySelector("bookmarks-app");
      if (!app?.shadowRoot) return;

      function findMenuItem(
        root: Element | ShadowRoot,
        depth = 0,
      ): Element | null {
        if (depth > 10) return null;

        const items = root.querySelectorAll(
          "button, [role='menuitem'], cr-button",
        );
        for (const item of items) {
          const text = item.textContent?.toLowerCase() ?? "";
          if (text.includes("add new folder") || text.includes("add folder") || text.includes("new folder")) {
            return item;
          }
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            const found = findMenuItem(el.shadowRoot, depth + 1);
            if (found) return found;
          }
        }
        return null;
      }

      const menuItem = findMenuItem(app.shadowRoot);
      if (menuItem) {
        (menuItem as HTMLElement).click();
      }
    });

    await new Promise((r) => setTimeout(r, 500));

    // Fill in the folder name
    await page.evaluate((folderName: string) => {
      const app = document.querySelector("bookmarks-app");
      if (!app?.shadowRoot) return;

      function findInputs(
        root: Element | ShadowRoot,
        depth = 0,
      ): HTMLInputElement[] {
        if (depth > 12) return [];
        const inputs: HTMLInputElement[] = [];

        const inputEls = root.querySelectorAll("input, cr-input");
        for (const el of inputEls) {
          if (el instanceof HTMLInputElement) {
            inputs.push(el);
          } else if (el.shadowRoot) {
            const inner = el.shadowRoot.querySelector("input");
            if (inner instanceof HTMLInputElement) inputs.push(inner);
          }
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            inputs.push(...findInputs(el.shadowRoot, depth + 1));
          }
        }
        return inputs;
      }

      const inputs = findInputs(app.shadowRoot);
      if (inputs.length >= 1) {
        inputs[0].value = folderName;
        inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
      }
    }, name);

    await new Promise((r) => setTimeout(r, 300));

    // Click save
    await page.evaluate(() => {
      const app = document.querySelector("bookmarks-app");
      if (!app?.shadowRoot) return;

      function findSaveButton(
        root: Element | ShadowRoot,
        depth = 0,
      ): Element | null {
        if (depth > 12) return null;

        const buttons = root.querySelectorAll("button, cr-button, .action-button");
        for (const btn of buttons) {
          const text = btn.textContent?.toLowerCase() ?? "";
          if (text.includes("save") || text.includes("done") || text.includes("add")) return btn;
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            const found = findSaveButton(el.shadowRoot, depth + 1);
            if (found) return found;
          }
        }
        return null;
      }

      const saveBtn = findSaveButton(app.shadowRoot);
      if (saveBtn) {
        (saveBtn as HTMLElement).click();
      }
    });

    await new Promise((r) => setTimeout(r, 500));

    return { title: name, children: 0, index: -1 };
  }

  /**
   * Export bookmarks as HTML or JSON.
   */
  async exportBookmarks(format: "html" | "json" = "html"): Promise<string> {
    const page = await this.navigateToBookmarks();

    // Extract all bookmarks via the Chrome bookmarks API in page context
    const bookmarkData: BookmarkTreeNode[] = await page.evaluate(() => {
      const app = document.querySelector("bookmarks-app");
      if (!app?.shadowRoot) return [];

      function extractAllBookmarks(
        root: Element | ShadowRoot,
        depth = 0,
      ): Array<{ title: string; url?: string; type: "bookmark" | "folder" }> {
        if (depth > 15) return [];
        const items: Array<{ title: string; url?: string; type: "bookmark" | "folder" }> = [];

        const bookmarkEls = root.querySelectorAll(
          "bookmarks-item, .bookmark-item, [role='listitem'], [role='treeitem']",
        );

        for (const el of bookmarkEls) {
          const innerRoot = el.shadowRoot ?? el;
          const titleEl = innerRoot.querySelector(".title, .label, [class*='title']");
          const urlEl = innerRoot.querySelector(".url, .subtitle, [class*='url']");

          const title = titleEl?.textContent?.trim() ?? el.textContent?.trim() ?? "";
          const url = urlEl?.textContent?.trim() ?? undefined;

          if (title) {
            items.push({
              title,
              url,
              type: url ? "bookmark" : "folder",
            });
          }
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            items.push(...extractAllBookmarks(el.shadowRoot, depth + 1));
          }
        }
        return items;
      }

      return extractAllBookmarks(app.shadowRoot).map((item) => ({
        ...item,
        children: item.type === "folder" ? [] : undefined,
      }));
    });

    if (format === "json") {
      return JSON.stringify(bookmarkData, null, 2);
    }

    // Convert to Netscape bookmarks HTML format
    let html = "<!DOCTYPE NETSCAPE-Bookmark-file-1>\n";
    html += "<!-- This is an automatically generated file. -->\n";
    html += '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n';
    html += "<TITLE>Bookmarks</TITLE>\n";
    html += "<H1>Bookmarks</H1>\n";
    html += "<DL><p>\n";

    for (const node of bookmarkData) {
      if (node.type === "folder") {
        html += `  <DT><H3>${escapeHtml(node.title)}</H3>\n`;
        html += "  <DL><p>\n  </DL><p>\n";
      } else {
        html += `  <DT><A HREF="${escapeHtml(node.url ?? "")}">${escapeHtml(node.title)}</A>\n`;
      }
    }

    html += "</DL><p>\n";
    return html;
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
