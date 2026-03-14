/**
 * AXON Extensions Manager — Chrome Extensions Automation
 *
 * Automates Chrome's built-in extensions page (chrome://extensions)
 * via Puppeteer. Handles:
 *   - Chrome profile detection (macOS, Linux, Windows)
 *   - Shadow DOM piercing (Chrome extensions page uses nested shadow roots)
 *   - Extension listing, toggling, details, permissions, search, and removal
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

export interface ExtensionEntry {
  name: string;
  id: string;
  version: string;
  enabled: boolean;
  description?: string;
  index: number;
}

export interface ExtensionDetails {
  name: string;
  id: string;
  version: string;
  enabled: boolean;
  description: string;
  permissions: string[];
  siteAccess?: string;
  size?: string;
  homepageUrl?: string;
  updateUrl?: string;
}

export interface ExtensionsManagerConfig {
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
 * Chrome extensions page uses deeply nested web components with shadow roots:
 *   extensions-manager > extensions-item-list > extensions-item
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
// ExtensionsManager Class
// ============================================================================

export class ExtensionsManager {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private config: Required<
    Pick<ExtensionsManagerConfig, "headless" | "profileName">
  > &
    ExtensionsManagerConfig;

  constructor(config?: ExtensionsManagerConfig) {
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

  private async navigateToExtensions(): Promise<Page> {
    const page = await this.ensurePage();
    const url = page.url();

    if (!url.startsWith("chrome://extensions")) {
      await page.goto("chrome://extensions", {
        waitUntil: "networkidle2",
        timeout: 15000,
      });
    }

    await page.waitForSelector("extensions-manager", { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 500));
    return page;
  }

  // --------------------------------------------------------------------------
  // Extension Operations
  // --------------------------------------------------------------------------

  /**
   * List all installed extensions with their status.
   */
  async listExtensions(): Promise<ExtensionEntry[]> {
    const page = await this.navigateToExtensions();

    const extensions: ExtensionEntry[] = await page.evaluate(() => {
      const results: Array<{
        name: string;
        id: string;
        version: string;
        enabled: boolean;
        description?: string;
        index: number;
      }> = [];

      const manager = document.querySelector("extensions-manager");
      if (!manager?.shadowRoot) return results;

      // Find extensions-item-list through shadow DOM
      function findExtensionItems(
        root: Element | ShadowRoot,
        depth = 0,
      ): Element[] {
        if (depth > 12) return [];
        const items: Element[] = [];

        const candidates = root.querySelectorAll(
          "extensions-item, .extension-item, [is='extensions-item']",
        );
        items.push(...Array.from(candidates));

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            items.push(...findExtensionItems(el.shadowRoot, depth + 1));
          }
        }
        return items;
      }

      const items = findExtensionItems(manager.shadowRoot);

      items.forEach((item, index) => {
        const innerRoot = item.shadowRoot ?? item;

        // Extract extension name
        const nameEl = innerRoot.querySelector(
          "#name, .extension-name, [id*='name'], .name",
        );
        const name = nameEl?.textContent?.trim() ?? "";

        // Extract extension ID
        const idAttr = item.getAttribute("id") ??
          item.getAttribute("extension-id") ?? "";

        // Extract version
        const versionEl = innerRoot.querySelector(
          "#version, .version, [id*='version']",
        );
        const version = versionEl?.textContent?.trim()?.replace("Version: ", "") ?? "";

        // Check if enabled via toggle
        const toggle = innerRoot.querySelector(
          "cr-toggle, [id*='enable'], .toggle",
        );
        const enabled = toggle
          ? (toggle.hasAttribute("checked") || toggle.getAttribute("aria-pressed") === "true")
          : !item.classList.contains("disabled");

        // Extract description
        const descEl = innerRoot.querySelector(
          "#description, .description, [id*='description']",
        );
        const description = descEl?.textContent?.trim() ?? undefined;

        if (name) {
          results.push({
            name,
            id: idAttr,
            version,
            enabled,
            description,
            index,
          });
        }
      });

      // Fallback: try text-based extraction
      if (results.length === 0) {
        const allText = manager.shadowRoot.textContent ?? "";
        // Extensions page shows names in specific patterns
        // This is a last resort
      }

      return results;
    });

    return extensions;
  }

  /**
   * Get detailed information about a specific extension.
   */
  async getExtensionDetails(extensionId: string): Promise<ExtensionDetails | null> {
    const page = await this.navigateToExtensions();

    // Navigate to the extension's detail page
    await page.goto(`chrome://extensions/?id=${extensionId}`, {
      waitUntil: "networkidle2",
      timeout: 15000,
    });

    await new Promise((r) => setTimeout(r, 1000));

    const details: ExtensionDetails | null = await page.evaluate((extId: string) => {
      const manager = document.querySelector("extensions-manager");
      if (!manager?.shadowRoot) return null;

      function findDetailPage(
        root: Element | ShadowRoot,
        depth = 0,
      ): Element | null {
        if (depth > 12) return null;

        const detailPages = root.querySelectorAll(
          "extensions-detail-view, .detail-view, [is='extensions-detail-view']",
        );
        for (const page of detailPages) return page;

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            const found = findDetailPage(el.shadowRoot, depth + 1);
            if (found) return found;
          }
        }
        return null;
      }

      const detailPage = findDetailPage(manager.shadowRoot);
      if (!detailPage) return null;

      const innerRoot = detailPage.shadowRoot ?? detailPage;

      // Extract name
      const nameEl = innerRoot.querySelector(
        "#name, .extension-name, [id*='name'], .name, h1",
      );
      const name = nameEl?.textContent?.trim() ?? "";

      // Extract version
      const versionEl = innerRoot.querySelector(
        "#version, .version, [id*='version']",
      );
      const version = versionEl?.textContent?.trim()?.replace("Version: ", "") ?? "";

      // Check enabled state
      const toggle = innerRoot.querySelector(
        "cr-toggle, [id*='enable'], .toggle",
      );
      const enabled = toggle
        ? (toggle.hasAttribute("checked") || toggle.getAttribute("aria-pressed") === "true")
        : true;

      // Extract description
      const descEl = innerRoot.querySelector(
        "#description, .description, [id*='description']",
      );
      const description = descEl?.textContent?.trim() ?? "";

      // Extract permissions
      const permissions: string[] = [];
      function findPermissions(root: Element | ShadowRoot, depth = 0): void {
        if (depth > 10) return;

        const permEls = root.querySelectorAll(
          ".permission, [class*='permission'], li",
        );
        for (const el of permEls) {
          const text = el.textContent?.trim();
          if (text) permissions.push(text);
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) findPermissions(el.shadowRoot, depth + 1);
        }
      }

      // Look for permissions section
      const permSection = innerRoot.querySelector(
        "#permissions, .permissions-list, [id*='permission']",
      );
      if (permSection) {
        findPermissions(permSection);
      }

      // Extract site access
      const siteAccessEl = innerRoot.querySelector(
        "#siteAccess, [id*='siteAccess'], .site-access",
      );
      const siteAccess = siteAccessEl?.textContent?.trim() ?? undefined;

      // Extract homepage URL
      const homepageEl = innerRoot.querySelector(
        "a[href*='chrome.google.com'], a.homepage-link, [id*='homepage']",
      );
      const homepageUrl = (homepageEl as HTMLAnchorElement)?.href ?? undefined;

      return {
        name,
        id: extId,
        version,
        enabled,
        description,
        permissions,
        siteAccess,
        homepageUrl,
      };
    }, extensionId);

    // Navigate back to extensions list
    await page.goto("chrome://extensions", {
      waitUntil: "networkidle2",
      timeout: 15000,
    });

    return details;
  }

  /**
   * Enable or disable an extension.
   */
  async toggleExtension(extensionId: string, enable: boolean): Promise<boolean> {
    const page = await this.navigateToExtensions();

    const toggled = await page.evaluate((extId: string, shouldEnable: boolean) => {
      const manager = document.querySelector("extensions-manager");
      if (!manager?.shadowRoot) return false;

      function findExtensionItems(
        root: Element | ShadowRoot,
        depth = 0,
      ): Element[] {
        if (depth > 12) return [];
        const items: Element[] = [];

        const candidates = root.querySelectorAll(
          "extensions-item, .extension-item, [is='extensions-item']",
        );
        items.push(...Array.from(candidates));

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            items.push(...findExtensionItems(el.shadowRoot, depth + 1));
          }
        }
        return items;
      }

      const items = findExtensionItems(manager.shadowRoot);

      for (const item of items) {
        const itemId = item.getAttribute("id") ??
          item.getAttribute("extension-id") ?? "";

        if (itemId === extId || item.textContent?.includes(extId)) {
          const innerRoot = item.shadowRoot ?? item;
          const toggle = innerRoot.querySelector(
            "cr-toggle, [id*='enable'], .toggle, [role='switch']",
          );

          if (!toggle) continue;

          const isEnabled = toggle.hasAttribute("checked") ||
            toggle.getAttribute("aria-pressed") === "true";

          if (isEnabled !== shouldEnable) {
            (toggle as HTMLElement).click();
            return true;
          }
          return true; // Already in desired state
        }
      }
      return false;
    }, extensionId, enable);

    await new Promise((r) => setTimeout(r, 500));
    return toggled;
  }

  /**
   * Search installed extensions by name or description.
   */
  async searchExtensions(query: string): Promise<ExtensionEntry[]> {
    const page = await this.navigateToExtensions();

    // Use the search functionality on the extensions page
    const searched = await page.evaluate((searchQuery: string) => {
      const manager = document.querySelector("extensions-manager");
      if (!manager?.shadowRoot) return false;

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

      const searchInput = findSearchInput(manager.shadowRoot);
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

    // Get the current list (which should now be filtered)
    const allExtensions = await this.listExtensions();

    // If search did not work via UI, filter client-side
    if (!searched) {
      const lowerQuery = query.toLowerCase();
      return allExtensions.filter((ext) =>
        ext.name.toLowerCase().includes(lowerQuery) ||
        (ext.description?.toLowerCase().includes(lowerQuery) ?? false) ||
        ext.id.toLowerCase().includes(lowerQuery),
      );
    }

    return allExtensions;
  }

  /**
   * Get permissions for a specific extension.
   */
  async getExtensionPermissions(extensionId: string): Promise<string[]> {
    const details = await this.getExtensionDetails(extensionId);
    return details?.permissions ?? [];
  }

  /**
   * Remove an extension.
   */
  async removeExtension(extensionId: string): Promise<boolean> {
    const page = await this.navigateToExtensions();

    // Find the extension and click its remove button
    const found = await page.evaluate((extId: string) => {
      const manager = document.querySelector("extensions-manager");
      if (!manager?.shadowRoot) return false;

      function findExtensionItems(
        root: Element | ShadowRoot,
        depth = 0,
      ): Element[] {
        if (depth > 12) return [];
        const items: Element[] = [];

        const candidates = root.querySelectorAll(
          "extensions-item, .extension-item, [is='extensions-item']",
        );
        items.push(...Array.from(candidates));

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            items.push(...findExtensionItems(el.shadowRoot, depth + 1));
          }
        }
        return items;
      }

      const items = findExtensionItems(manager.shadowRoot);

      for (const item of items) {
        const itemId = item.getAttribute("id") ??
          item.getAttribute("extension-id") ?? "";

        if (itemId === extId || item.textContent?.includes(extId)) {
          const innerRoot = item.shadowRoot ?? item;
          const removeBtn = innerRoot.querySelector(
            "#remove-button, [id*='remove'], button[aria-label*='remove' i], cr-button[id*='remove']",
          );

          if (removeBtn) {
            (removeBtn as HTMLElement).click();
            return true;
          }

          // Try the 3-dot menu approach
          const menuBtn = innerRoot.querySelector(
            "cr-icon-button[icon*='more'], [icon*='more-vert'], .more-vert-button",
          );
          if (menuBtn) {
            (menuBtn as HTMLElement).click();
            return true;
          }
        }
      }
      return false;
    }, extensionId);

    if (!found) return false;

    await new Promise((r) => setTimeout(r, 500));

    // If we clicked the 3-dot menu, find and click "Remove"
    await page.evaluate(() => {
      const manager = document.querySelector("extensions-manager");
      if (!manager?.shadowRoot) return;

      function findRemoveMenuItem(
        root: Element | ShadowRoot,
        depth = 0,
      ): Element | null {
        if (depth > 12) return null;

        const items = root.querySelectorAll(
          "button, [role='menuitem'], cr-button",
        );
        for (const item of items) {
          const text = item.textContent?.toLowerCase() ?? "";
          if (text.includes("remove") || text.includes("uninstall")) return item;
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            const found = findRemoveMenuItem(el.shadowRoot, depth + 1);
            if (found) return found;
          }
        }
        return null;
      }

      const menuItem = findRemoveMenuItem(manager.shadowRoot);
      if (menuItem) {
        (menuItem as HTMLElement).click();
      }
    });

    await new Promise((r) => setTimeout(r, 500));

    // Confirm the removal dialog
    const confirmed = await page.evaluate(() => {
      const manager = document.querySelector("extensions-manager");
      if (!manager?.shadowRoot) return false;

      function findConfirmButton(
        root: Element | ShadowRoot,
        depth = 0,
      ): Element | null {
        if (depth > 12) return null;

        const buttons = root.querySelectorAll(
          "button, cr-button, .action-button",
        );
        for (const btn of buttons) {
          const text = btn.textContent?.toLowerCase() ?? "";
          if (text.includes("remove") || text.includes("confirm") || text.includes("yes")) {
            return btn;
          }
        }

        // Also check dialogs
        const dialogs = root.querySelectorAll("cr-dialog, dialog, [role='dialog']");
        for (const dialog of dialogs) {
          const dialogRoot = dialog.shadowRoot ?? dialog;
          const btns = dialogRoot.querySelectorAll("button, cr-button, .action-button");
          for (const btn of btns) {
            const text = btn.textContent?.toLowerCase() ?? "";
            if (text.includes("remove") || text.includes("confirm")) {
              return btn;
            }
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

      const confirmBtn = findConfirmButton(manager.shadowRoot);
      if (confirmBtn) {
        (confirmBtn as HTMLElement).click();
        return true;
      }
      return false;
    });

    await new Promise((r) => setTimeout(r, 1000));
    return confirmed;
  }
}
