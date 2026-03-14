/**
 * AXON Password Manager — Chrome Password Manager Automation
 *
 * Automates Chrome's built-in password manager (chrome://password-manager)
 * via Puppeteer. Handles:
 *   - Chrome profile detection (macOS, Linux, Windows)
 *   - Shadow DOM piercing (Chrome settings pages use nested shadow roots)
 *   - Password CRUD, generation, security checks, and export
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

export interface PasswordEntry {
  site: string;
  username: string;
  password?: string;
  note?: string;
  index: number;
}

export interface GeneratePasswordOptions {
  length?: number;
  includeSymbols?: boolean;
  includeNumbers?: boolean;
}

export interface SecurityReport {
  compromised: PasswordEntry[];
  reused: PasswordEntry[];
  weak: PasswordEntry[];
  total: number;
}

export interface PasswordManagerConfig {
  /** Chrome user data directory (auto-detected if not set) */
  userDataDir?: string;
  /** Chrome profile name within the data dir (default: "Default") */
  profileName?: string;
  /** Path to Chrome/Chromium executable (auto-detected if not set) */
  executablePath?: string;
  /** Run in headless mode (default: false — password manager needs visible Chrome) */
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
 * Chrome settings pages (including password-manager) use deeply nested
 * web components with shadow roots. This function traverses the chain:
 *
 *   pierceShadow(page, ["password-manager-app", "passwords-section", ".password-row"])
 *
 * is equivalent to:
 *   document.querySelector("password-manager-app")
 *     .shadowRoot.querySelector("passwords-section")
 *     .shadowRoot.querySelector(".password-row")
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
        // No shadow root — try direct child query
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
    // Navigate to the parent container
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

    // Query all at the deepest level
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
// PasswordManager Class
// ============================================================================

export class PasswordManager {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private config: Required<
    Pick<PasswordManagerConfig, "headless" | "profileName">
  > &
    PasswordManagerConfig;

  constructor(config?: PasswordManagerConfig) {
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
        "--disable-extensions",
        "--password-store=basic", // Avoid OS keyring prompts where possible
      ],
      defaultViewport: this.config.viewport ?? { width: 1280, height: 900 },
    });

    // Get or create initial page
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

  private async navigateToPasswords(): Promise<Page> {
    const page = await this.ensurePage();
    const url = page.url();

    // Only navigate if not already on the passwords page
    if (!url.startsWith("chrome://password-manager")) {
      await page.goto("chrome://password-manager/passwords", {
        waitUntil: "networkidle2",
        timeout: 15000,
      });
    }

    // Wait for the app shell to load
    await page.waitForSelector("password-manager-app", { timeout: 10000 });
    // Small delay for shadow DOM to fully render
    await new Promise((r) => setTimeout(r, 500));
    return page;
  }

  private async navigateToCheckup(): Promise<Page> {
    const page = await this.ensurePage();
    await page.goto("chrome://password-manager/checkup", {
      waitUntil: "networkidle2",
      timeout: 15000,
    });
    await page.waitForSelector("password-manager-app", { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 500));
    return page;
  }

  private async navigateToSettings(): Promise<Page> {
    const page = await this.ensurePage();
    await page.goto("chrome://password-manager/settings", {
      waitUntil: "networkidle2",
      timeout: 15000,
    });
    await page.waitForSelector("password-manager-app", { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 500));
    return page;
  }

  // --------------------------------------------------------------------------
  // Password Operations
  // --------------------------------------------------------------------------

  /**
   * List all saved passwords.
   * Returns site + username only — NEVER includes password values.
   */
  async listPasswords(): Promise<PasswordEntry[]> {
    const page = await this.navigateToPasswords();

    // Use page.evaluate with deep shadow DOM traversal to extract password list
    const entries: PasswordEntry[] = await page.evaluate(() => {
      const results: Array<{
        site: string;
        username: string;
        index: number;
      }> = [];

      // Strategy 1: Try the password-manager-app shadow DOM structure
      const app = document.querySelector("password-manager-app");
      if (!app?.shadowRoot) return results;

      // Look for password list items through the shadow DOM
      // Chrome password manager uses <password-list-item> or similar elements
      const root = app.shadowRoot;

      // Try multiple possible selectors for password entries
      const selectors = [
        "passwords-section",
        "password-section",
        "#passwordsList",
        ".password-list",
        "[role='list']",
        "cr-action-menu",
      ];

      let passwordSection: Element | null = null;
      for (const sel of selectors) {
        passwordSection = root.querySelector(sel);
        if (passwordSection) break;
        // Also try through nested shadow roots
        const children = root.querySelectorAll("*");
        for (const child of children) {
          if (child.shadowRoot) {
            passwordSection = child.shadowRoot.querySelector(sel);
            if (passwordSection) break;
          }
        }
        if (passwordSection) break;
      }

      // Fallback: Recursively search all shadow roots for password entries
      function findPasswordItems(
        root: Element | ShadowRoot,
        depth = 0,
      ): Element[] {
        if (depth > 10) return [];
        const items: Element[] = [];

        // Look for password list items
        const candidates = root.querySelectorAll(
          "password-list-item, .password-row, [class*='password'], site-entry, credential-row",
        );
        items.push(...Array.from(candidates));

        // Recurse into shadow roots
        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            items.push(...findPasswordItems(el.shadowRoot, depth + 1));
          }
        }
        return items;
      }

      const items = findPasswordItems(app.shadowRoot);

      // Extract text from each item
      items.forEach((item, index) => {
        const textContent = item.textContent?.trim() ?? "";
        const shadowText = item.shadowRoot?.textContent?.trim() ?? textContent;

        // Parse site and username from the item text
        // Typical format: "example.com  username@email.com" or similar
        const lines = shadowText.split(/\n/).map((l) => l.trim()).filter(Boolean);

        if (lines.length >= 2) {
          results.push({
            site: lines[0],
            username: lines[1],
            index,
          });
        } else if (lines.length === 1) {
          results.push({
            site: lines[0],
            username: "",
            index,
          });
        }
      });

      // If recursive search didn't find items, try extracting from accessibility tree
      if (results.length === 0) {
        // Look for any list-like structure with site/credential info
        const allText = app.shadowRoot.textContent ?? "";
        // Return empty — the accessibility tree approach in the tool handler
        // will provide better results
      }

      return results;
    });

    return entries;
  }

  /**
   * Search passwords by site name or username.
   */
  async searchPasswords(query: string): Promise<PasswordEntry[]> {
    const page = await this.navigateToPasswords();

    // Use Chrome password manager's built-in search
    // The search input is typically inside the shadow DOM
    const searched = await page.evaluate((searchQuery: string) => {
      const app = document.querySelector("password-manager-app");
      if (!app?.shadowRoot) return false;

      // Find search input through shadow DOM
      function findInput(root: Element | ShadowRoot, depth = 0): HTMLInputElement | null {
        if (depth > 10) return null;

        const inputs = root.querySelectorAll(
          'input[type="search"], input[aria-label*="search" i], #searchInput, cr-toolbar-search-field, .search-field input',
        );
        for (const input of inputs) {
          if (input instanceof HTMLInputElement) return input;
          if (input.shadowRoot) {
            const inner = findInput(input.shadowRoot, depth + 1);
            if (inner) return inner;
          }
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            const found = findInput(el.shadowRoot, depth + 1);
            if (found) return found;
          }
        }
        return null;
      }

      const searchInput = findInput(app.shadowRoot);
      if (searchInput) {
        searchInput.value = searchQuery;
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
        searchInput.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      return false;
    }, query);

    if (searched) {
      // Wait for search results to filter
      await new Promise((r) => setTimeout(r, 800));
    }

    // Get filtered results
    const entries = await this.listPasswords();

    // If the built-in search didn't work, filter client-side
    if (!searched) {
      const q = query.toLowerCase();
      return entries.filter(
        (e) =>
          e.site.toLowerCase().includes(q) ||
          e.username.toLowerCase().includes(q),
      );
    }

    return entries;
  }

  /**
   * Get a specific password entry including the password value.
   *
   * WARNING: This may trigger OS authentication (Touch ID, system password).
   * The password is only returned in the full result data, never in summaries.
   */
  async getPassword(site: string, username: string): Promise<PasswordEntry> {
    const page = await this.navigateToPasswords();

    // Find and click the matching password entry to open details
    const clicked = await page.evaluate(
      (targetSite: string, targetUser: string) => {
        const app = document.querySelector("password-manager-app");
        if (!app?.shadowRoot) return false;

        function findAndClick(
          root: Element | ShadowRoot,
          depth = 0,
        ): boolean {
          if (depth > 10) return false;

          const items = root.querySelectorAll(
            "password-list-item, .password-row, site-entry, credential-row, [class*='password']",
          );

          for (const item of items) {
            const text = (item.shadowRoot?.textContent ?? item.textContent ?? "").toLowerCase();
            if (
              text.includes(targetSite.toLowerCase()) &&
              (targetUser === "" || text.includes(targetUser.toLowerCase()))
            ) {
              (item as HTMLElement).click();
              return true;
            }
          }

          const elements = root.querySelectorAll("*");
          for (const el of elements) {
            if (el.shadowRoot && findAndClick(el.shadowRoot, depth + 1)) {
              return true;
            }
          }
          return false;
        }

        return findAndClick(app.shadowRoot);
      },
      site,
      username,
    );

    if (!clicked) {
      throw new Error(`Password entry not found: ${site} / ${username}`);
    }

    // Wait for detail view to load
    await new Promise((r) => setTimeout(r, 1000));

    // Try to click "show password" button (may trigger OS auth)
    const showResult = await page.evaluate(() => {
      const app = document.querySelector("password-manager-app");
      if (!app?.shadowRoot) return { shown: false, password: "" };

      function findShowButton(
        root: Element | ShadowRoot,
        depth = 0,
      ): HTMLElement | null {
        if (depth > 10) return null;

        const buttons = root.querySelectorAll(
          'button[aria-label*="show" i], button[aria-label*="password" i], .password-toggle, #showPasswordButton, [id*="show"][id*="password" i]',
        );
        for (const btn of buttons) {
          if (btn instanceof HTMLElement) return btn;
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            const found = findShowButton(el.shadowRoot, depth + 1);
            if (found) return found;
          }
        }
        return null;
      }

      const showBtn = findShowButton(app.shadowRoot);
      if (showBtn) {
        showBtn.click();
        return { shown: true, password: "" };
      }
      return { shown: false, password: "" };
    });

    // Wait for password to be revealed (may require OS authentication)
    if (showResult.shown) {
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Extract the password value from the detail view
    const details = await page.evaluate(() => {
      const app = document.querySelector("password-manager-app");
      if (!app?.shadowRoot) return null;

      function extractDetails(root: Element | ShadowRoot, depth = 0): any {
        if (depth > 10) return null;

        // Look for password input/field in detail view
        const passwordFields = root.querySelectorAll(
          'input[type="password"], input[type="text"][aria-label*="password" i], .password-value, [id*="password"]',
        );

        for (const field of passwordFields) {
          if (field instanceof HTMLInputElement && field.value) {
            return { password: field.value };
          }
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            const found = extractDetails(el.shadowRoot, depth + 1);
            if (found) return found;
          }
        }
        return null;
      }

      return extractDetails(app.shadowRoot);
    });

    return {
      site,
      username,
      password: details?.password ?? "[OS authentication required — check Chrome window]",
      index: 0,
    };
  }

  /**
   * Add a new password entry.
   */
  async addPassword(
    site: string,
    username: string,
    password: string,
    note?: string,
  ): Promise<PasswordEntry> {
    const page = await this.navigateToPasswords();

    // Click the "Add" button
    const addClicked = await page.evaluate(() => {
      const app = document.querySelector("password-manager-app");
      if (!app?.shadowRoot) return false;

      function findAddButton(
        root: Element | ShadowRoot,
        depth = 0,
      ): HTMLElement | null {
        if (depth > 10) return null;

        const buttons = root.querySelectorAll(
          'button[aria-label*="add" i], #addPasswordButton, .add-button, cr-button[id*="add"], [class*="add"]',
        );
        for (const btn of buttons) {
          const text = (btn.textContent ?? "").toLowerCase();
          if (
            text.includes("add") &&
            btn instanceof HTMLElement
          ) {
            return btn;
          }
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            const found = findAddButton(el.shadowRoot, depth + 1);
            if (found) return found;
          }
        }
        return null;
      }

      const btn = findAddButton(app.shadowRoot);
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });

    if (!addClicked) {
      throw new Error("Could not find 'Add Password' button. The UI structure may have changed.");
    }

    // Wait for dialog to open
    await new Promise((r) => setTimeout(r, 1000));

    // Fill in the form fields
    await page.evaluate(
      (siteVal: string, userVal: string, passVal: string, noteVal: string) => {
        const app = document.querySelector("password-manager-app");
        if (!app?.shadowRoot) return;

        function findInputs(root: Element | ShadowRoot, depth = 0): void {
          if (depth > 10) return;

          const inputs = root.querySelectorAll("input, textarea");
          for (const input of inputs) {
            if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) continue;

            const label = (
              input.getAttribute("aria-label") ??
              input.getAttribute("placeholder") ??
              input.id ??
              ""
            ).toLowerCase();

            if (label.includes("site") || label.includes("url") || label.includes("website")) {
              input.value = siteVal;
              input.dispatchEvent(new Event("input", { bubbles: true }));
            } else if (label.includes("user") || label.includes("email")) {
              input.value = userVal;
              input.dispatchEvent(new Event("input", { bubbles: true }));
            } else if (label.includes("password") || label.includes("pass")) {
              input.value = passVal;
              input.dispatchEvent(new Event("input", { bubbles: true }));
            } else if (label.includes("note") && noteVal) {
              input.value = noteVal;
              input.dispatchEvent(new Event("input", { bubbles: true }));
            }
          }

          const elements = root.querySelectorAll("*");
          for (const el of elements) {
            if (el.shadowRoot) findInputs(el.shadowRoot, depth + 1);
          }
        }

        findInputs(app.shadowRoot);
      },
      site,
      username,
      password,
      note ?? "",
    );

    // Click Save button
    await new Promise((r) => setTimeout(r, 500));
    await page.evaluate(() => {
      const app = document.querySelector("password-manager-app");
      if (!app?.shadowRoot) return;

      function findSaveButton(root: Element | ShadowRoot, depth = 0): void {
        if (depth > 10) return;

        const buttons = root.querySelectorAll("button, cr-button");
        for (const btn of buttons) {
          const text = (btn.textContent ?? "").toLowerCase();
          if (text.includes("save") && btn instanceof HTMLElement) {
            btn.click();
            return;
          }
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) findSaveButton(el.shadowRoot, depth + 1);
        }
      }

      findSaveButton(app.shadowRoot);
    });

    await new Promise((r) => setTimeout(r, 1000));

    return {
      site,
      username,
      index: -1, // Will be assigned when listed
    };
  }

  /**
   * Edit an existing password entry.
   */
  async editPassword(
    site: string,
    username: string,
    updates: { newUsername?: string; newPassword?: string; newNote?: string },
  ): Promise<PasswordEntry> {
    const page = await this.navigateToPasswords();

    // First, find and click the entry to open its detail view
    const clicked = await page.evaluate(
      (targetSite: string, targetUser: string) => {
        const app = document.querySelector("password-manager-app");
        if (!app?.shadowRoot) return false;

        function findAndClick(root: Element | ShadowRoot, depth = 0): boolean {
          if (depth > 10) return false;

          const items = root.querySelectorAll(
            "password-list-item, .password-row, site-entry, credential-row",
          );
          for (const item of items) {
            const text = (item.shadowRoot?.textContent ?? item.textContent ?? "").toLowerCase();
            if (text.includes(targetSite.toLowerCase()) && text.includes(targetUser.toLowerCase())) {
              (item as HTMLElement).click();
              return true;
            }
          }

          const elements = root.querySelectorAll("*");
          for (const el of elements) {
            if (el.shadowRoot && findAndClick(el.shadowRoot, depth + 1)) return true;
          }
          return false;
        }

        return findAndClick(app.shadowRoot);
      },
      site,
      username,
    );

    if (!clicked) {
      throw new Error(`Password entry not found: ${site} / ${username}`);
    }

    // Wait for detail view
    await new Promise((r) => setTimeout(r, 1000));

    // Click Edit button
    await page.evaluate(() => {
      const app = document.querySelector("password-manager-app");
      if (!app?.shadowRoot) return;

      function findEditButton(root: Element | ShadowRoot, depth = 0): void {
        if (depth > 10) return;

        const buttons = root.querySelectorAll("button, cr-button, cr-icon-button");
        for (const btn of buttons) {
          const label = (
            btn.getAttribute("aria-label") ??
            btn.textContent ??
            ""
          ).toLowerCase();
          if ((label.includes("edit") || label.includes("modify")) && btn instanceof HTMLElement) {
            btn.click();
            return;
          }
        }

        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) findEditButton(el.shadowRoot, depth + 1);
        }
      }

      findEditButton(app.shadowRoot);
    });

    await new Promise((r) => setTimeout(r, 1000));

    // Apply updates
    await page.evaluate(
      (newUser: string, newPass: string, newNote: string) => {
        const app = document.querySelector("password-manager-app");
        if (!app?.shadowRoot) return;

        function updateInputs(root: Element | ShadowRoot, depth = 0): void {
          if (depth > 10) return;

          const inputs = root.querySelectorAll("input, textarea");
          for (const input of inputs) {
            if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) continue;

            const label = (
              input.getAttribute("aria-label") ??
              input.getAttribute("placeholder") ??
              input.id ??
              ""
            ).toLowerCase();

            if (newUser && (label.includes("user") || label.includes("email"))) {
              input.value = newUser;
              input.dispatchEvent(new Event("input", { bubbles: true }));
            } else if (newPass && (label.includes("password") || label.includes("pass"))) {
              input.value = newPass;
              input.dispatchEvent(new Event("input", { bubbles: true }));
            } else if (newNote && label.includes("note")) {
              input.value = newNote;
              input.dispatchEvent(new Event("input", { bubbles: true }));
            }
          }

          const elements = root.querySelectorAll("*");
          for (const el of elements) {
            if (el.shadowRoot) updateInputs(el.shadowRoot, depth + 1);
          }
        }

        updateInputs(app.shadowRoot);
      },
      updates.newUsername ?? "",
      updates.newPassword ?? "",
      updates.newNote ?? "",
    );

    // Click Save
    await new Promise((r) => setTimeout(r, 500));
    await page.evaluate(() => {
      const app = document.querySelector("password-manager-app");
      if (!app?.shadowRoot) return;

      function findSaveButton(root: Element | ShadowRoot, depth = 0): void {
        if (depth > 10) return;
        const buttons = root.querySelectorAll("button, cr-button");
        for (const btn of buttons) {
          const text = (btn.textContent ?? "").toLowerCase();
          if (text.includes("save") && btn instanceof HTMLElement) {
            btn.click();
            return;
          }
        }
        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) findSaveButton(el.shadowRoot, depth + 1);
        }
      }
      findSaveButton(app.shadowRoot);
    });

    await new Promise((r) => setTimeout(r, 1000));

    return {
      site,
      username: updates.newUsername ?? username,
      index: 0,
    };
  }

  /**
   * Delete a password entry.
   */
  async deletePassword(site: string, username: string): Promise<boolean> {
    const page = await this.navigateToPasswords();

    // Find and click the entry
    const clicked = await page.evaluate(
      (targetSite: string, targetUser: string) => {
        const app = document.querySelector("password-manager-app");
        if (!app?.shadowRoot) return false;

        function findAndClick(root: Element | ShadowRoot, depth = 0): boolean {
          if (depth > 10) return false;
          const items = root.querySelectorAll(
            "password-list-item, .password-row, site-entry, credential-row",
          );
          for (const item of items) {
            const text = (item.shadowRoot?.textContent ?? item.textContent ?? "").toLowerCase();
            if (text.includes(targetSite.toLowerCase()) && text.includes(targetUser.toLowerCase())) {
              (item as HTMLElement).click();
              return true;
            }
          }
          const elements = root.querySelectorAll("*");
          for (const el of elements) {
            if (el.shadowRoot && findAndClick(el.shadowRoot, depth + 1)) return true;
          }
          return false;
        }
        return findAndClick(app.shadowRoot);
      },
      site,
      username,
    );

    if (!clicked) {
      throw new Error(`Password entry not found: ${site} / ${username}`);
    }

    await new Promise((r) => setTimeout(r, 1000));

    // Click Delete button
    await page.evaluate(() => {
      const app = document.querySelector("password-manager-app");
      if (!app?.shadowRoot) return;

      function findDeleteButton(root: Element | ShadowRoot, depth = 0): void {
        if (depth > 10) return;
        const buttons = root.querySelectorAll("button, cr-button, cr-icon-button");
        for (const btn of buttons) {
          const label = (
            btn.getAttribute("aria-label") ??
            btn.textContent ??
            ""
          ).toLowerCase();
          if ((label.includes("delete") || label.includes("remove")) && btn instanceof HTMLElement) {
            btn.click();
            return;
          }
        }
        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) findDeleteButton(el.shadowRoot, depth + 1);
        }
      }
      findDeleteButton(app.shadowRoot);
    });

    // Wait and confirm deletion dialog if present
    await new Promise((r) => setTimeout(r, 1000));
    await page.evaluate(() => {
      const app = document.querySelector("password-manager-app");
      if (!app?.shadowRoot) return;

      function findConfirmButton(root: Element | ShadowRoot, depth = 0): void {
        if (depth > 10) return;
        const buttons = root.querySelectorAll("button, cr-button");
        for (const btn of buttons) {
          const text = (btn.textContent ?? "").toLowerCase();
          if (
            (text.includes("delete") || text.includes("remove") || text.includes("confirm")) &&
            btn instanceof HTMLElement
          ) {
            btn.click();
            return;
          }
        }
        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) findConfirmButton(el.shadowRoot, depth + 1);
        }
      }
      findConfirmButton(app.shadowRoot);
    });

    await new Promise((r) => setTimeout(r, 500));
    return true;
  }

  /**
   * Generate a strong password.
   * Uses crypto.getRandomValues for generation since Chrome's built-in
   * generator is not easily accessible via the password manager UI.
   */
  async generatePassword(options?: GeneratePasswordOptions): Promise<string> {
    const length = options?.length ?? 20;
    const includeSymbols = options?.includeSymbols ?? true;
    const includeNumbers = options?.includeNumbers ?? true;

    let charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    if (includeNumbers) charset += "0123456789";
    if (includeSymbols) charset += "!@#$%^&*()_+-=[]{}|;:,.<>?";

    // Generate in the browser context for true randomness
    const page = await this.ensurePage();
    const password = await page.evaluate(
      (chars: string, len: number) => {
        const array = new Uint8Array(len);
        crypto.getRandomValues(array);
        return Array.from(array)
          .map((b) => chars[b % chars.length])
          .join("");
      },
      charset,
      length,
    );

    return password;
  }

  /**
   * Check for compromised, reused, and weak passwords.
   * Navigates to chrome://password-manager/checkup.
   */
  async checkCompromised(): Promise<SecurityReport> {
    const page = await this.navigateToCheckup();

    // Click "Check passwords" if the check hasn't run yet
    await page.evaluate(() => {
      const app = document.querySelector("password-manager-app");
      if (!app?.shadowRoot) return;

      function findCheckButton(root: Element | ShadowRoot, depth = 0): void {
        if (depth > 10) return;
        const buttons = root.querySelectorAll("button, cr-button");
        for (const btn of buttons) {
          const text = (btn.textContent ?? "").toLowerCase();
          if (
            (text.includes("check") || text.includes("scan") || text.includes("start")) &&
            btn instanceof HTMLElement
          ) {
            btn.click();
            return;
          }
        }
        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) findCheckButton(el.shadowRoot, depth + 1);
        }
      }
      findCheckButton(app.shadowRoot);
    });

    // Wait for check to complete (can take a while)
    await new Promise((r) => setTimeout(r, 5000));

    // Extract results
    const report = await page.evaluate(() => {
      const app = document.querySelector("password-manager-app");
      if (!app?.shadowRoot) {
        return { compromised: [], reused: [], weak: [], total: 0 };
      }

      function extractSection(
        root: Element | ShadowRoot,
        keyword: string,
        depth = 0,
      ): Array<{ site: string; username: string; index: number }> {
        if (depth > 10) return [];
        const items: Array<{ site: string; username: string; index: number }> = [];

        // Find sections matching the keyword
        const sections = root.querySelectorAll(
          "[class*='compromised'], [class*='reused'], [class*='weak'], .password-check-section, checkup-section",
        );

        for (const section of sections) {
          const sectionText = (section.textContent ?? "").toLowerCase();
          if (sectionText.includes(keyword)) {
            const entries = section.querySelectorAll(
              "password-list-item, .password-row, credential-row",
            );
            entries.forEach((entry, idx) => {
              const text = entry.textContent?.trim() ?? "";
              const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
              if (lines.length >= 2) {
                items.push({ site: lines[0], username: lines[1], index: idx });
              }
            });
          }
        }

        // Recurse into shadow roots
        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            items.push(...extractSection(el.shadowRoot, keyword, depth + 1));
          }
        }

        return items;
      }

      const compromised = extractSection(app.shadowRoot, "compromised");
      const reused = extractSection(app.shadowRoot, "reused");
      const weak = extractSection(app.shadowRoot, "weak");

      return {
        compromised,
        reused,
        weak,
        total: compromised.length + reused.length + weak.length,
      };
    });

    return report;
  }

  /**
   * Export passwords as CSV or JSON.
   * Navigates to chrome://password-manager/settings and triggers export.
   *
   * NOTE: Chrome may show an OS authentication prompt before exporting.
   */
  async exportPasswords(format: "csv" | "json" = "csv"): Promise<string> {
    const page = await this.navigateToSettings();

    // Find and click "Export passwords" button
    const exportClicked = await page.evaluate(() => {
      const app = document.querySelector("password-manager-app");
      if (!app?.shadowRoot) return false;

      function findExportButton(root: Element | ShadowRoot, depth = 0): boolean {
        if (depth > 10) return false;
        const buttons = root.querySelectorAll("button, cr-button");
        for (const btn of buttons) {
          const text = (
            btn.getAttribute("aria-label") ??
            btn.textContent ??
            ""
          ).toLowerCase();
          if (text.includes("export") && btn instanceof HTMLElement) {
            btn.click();
            return true;
          }
        }
        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) {
            if (findExportButton(el.shadowRoot, depth + 1)) return true;
          }
        }
        return false;
      }
      return findExportButton(app.shadowRoot);
    });

    if (!exportClicked) {
      // Fallback: just list all passwords and format them
      const entries = await this.listPasswords();

      if (format === "json") {
        return JSON.stringify(entries, null, 2);
      }

      // CSV format
      const header = "site,username";
      const rows = entries.map(
        (e) => `"${e.site.replace(/"/g, '""')}","${e.username.replace(/"/g, '""')}"`,
      );
      return [header, ...rows].join("\n");
    }

    // Wait for export confirmation dialog
    await new Promise((r) => setTimeout(r, 2000));

    // Click "Export passwords" confirmation
    await page.evaluate(() => {
      const app = document.querySelector("password-manager-app");
      if (!app?.shadowRoot) return;

      function findConfirmExport(root: Element | ShadowRoot, depth = 0): void {
        if (depth > 10) return;
        const buttons = root.querySelectorAll("button, cr-button");
        for (const btn of buttons) {
          const text = (btn.textContent ?? "").toLowerCase();
          if (text.includes("export") && btn instanceof HTMLElement) {
            btn.click();
            return;
          }
        }
        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          if (el.shadowRoot) findConfirmExport(el.shadowRoot, depth + 1);
        }
      }
      findConfirmExport(app.shadowRoot);
    });

    return "[Export triggered — check Chrome download folder for the CSV file. OS authentication may be required.]";
  }
}
