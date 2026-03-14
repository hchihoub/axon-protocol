/**
 * AXON Cookie Manager — Chrome Cookie Management via CDP
 *
 * Manages browser cookies using Chrome DevTools Protocol (CDP) for reliable
 * programmatic access. Also supports navigating chrome://settings/cookies
 * for UI-based inspection via Shadow DOM piercing.
 *
 * Handles:
 *   - Chrome profile detection (macOS, Linux, Windows)
 *   - CDP session management for cookie CRUD operations
 *   - Shadow DOM piercing for chrome://settings/cookies page
 *   - Cookie search, filter, export, and bulk operations
 *
 * IMPORTANT: Chrome must be closed before launching — Puppeteer can't share
 * a profile directory with a running Chrome instance.
 *
 * SECURITY: Cookie values are treated as sensitive data and NEVER appear
 * in summarizers. Values only live in OCRS data, never in the model's
 * context window.
 */

import puppeteer, { type Browser, type Page, type CDPSession, type ElementHandle } from "puppeteer";
import { platform, homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
  session: boolean;
}

export interface CookieFilter {
  domain?: string;
  name?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
}

export interface SetCookieParams {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface CookieManagerConfig {
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
 * Chrome settings pages (including cookie settings) use deeply nested
 * web components with shadow roots. This function traverses the chain:
 *
 *   pierceShadow(page, ["settings-ui", "settings-main", ".cookie-row"])
 *
 * is equivalent to:
 *   document.querySelector("settings-ui")
 *     .shadowRoot.querySelector("settings-main")
 *     .shadowRoot.querySelector(".cookie-row")
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

// ============================================================================
// Cookie Manager
// ============================================================================

export class CookieManager {
  private browser: Browser | null = null;
  private config: CookieManagerConfig;

  constructor(config: CookieManagerConfig = {}) {
    this.config = config;
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

  /**
   * Create a CDP session on the first available page.
   * CDP gives direct access to cookie operations without UI navigation.
   */
  private async getCDPSession(): Promise<CDPSession> {
    const browser = this.ensureBrowser();
    const pages = await browser.pages();
    const page = pages[0] ?? await browser.newPage();
    return page.createCDPSession();
  }

  // --------------------------------------------------------------------------
  // Cookie Operations via CDP
  // --------------------------------------------------------------------------

  /**
   * List all cookies, optionally filtered by domain.
   */
  async listCookies(domain?: string): Promise<CookieEntry[]> {
    const cdp = await this.getCDPSession();
    try {
      const params: any = {};
      if (domain) {
        // Network.getCookies accepts urls array for filtering
        // We construct a URL from the domain to filter
        const url = domain.startsWith("http") ? domain : `https://${domain}`;
        params.urls = [url];
      }

      const result = await cdp.send("Network.getCookies", params);
      const cookies: CookieEntry[] = (result as any).cookies.map((c: any) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        size: c.size,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite || "None",
        session: c.session,
      }));

      return cookies;
    } finally {
      await cdp.detach();
    }
  }

  /**
   * Search cookies by name, domain, or value substring.
   */
  async searchCookies(query: string): Promise<CookieEntry[]> {
    const allCookies = await this.listCookies();
    const q = query.toLowerCase();

    return allCookies.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.domain.toLowerCase().includes(q) ||
        c.value.toLowerCase().includes(q),
    );
  }

  /**
   * Get a specific cookie by name and domain.
   */
  async getCookie(name: string, domain: string): Promise<CookieEntry | null> {
    const cookies = await this.listCookies(domain);
    return cookies.find((c) => c.name === name && c.domain.includes(domain)) ?? null;
  }

  /**
   * Set or update a cookie via CDP.
   */
  async setCookie(params: SetCookieParams): Promise<CookieEntry> {
    const cdp = await this.getCDPSession();
    try {
      const cookieParam: any = {
        name: params.name,
        value: params.value,
        domain: params.domain,
        path: params.path ?? "/",
        httpOnly: params.httpOnly ?? false,
        secure: params.secure ?? true,
        sameSite: params.sameSite ?? "Lax",
      };

      if (params.expires !== undefined) {
        cookieParam.expires = params.expires;
      }

      await cdp.send("Network.setCookie", cookieParam);

      // Verify and return the set cookie
      const result = await this.getCookie(params.name, params.domain);
      if (!result) {
        throw new Error(`Failed to verify cookie "${params.name}" on domain "${params.domain}" after setting`);
      }
      return result;
    } finally {
      await cdp.detach();
    }
  }

  /**
   * Delete a specific cookie by name and domain.
   */
  async deleteCookie(name: string, domain: string): Promise<boolean> {
    const cdp = await this.getCDPSession();
    try {
      // Build the URL for the domain
      const url = domain.startsWith("http") ? domain : `https://${domain}`;
      await cdp.send("Network.deleteCookies", {
        name,
        domain,
        url,
      });
      return true;
    } finally {
      await cdp.detach();
    }
  }

  /**
   * Clear all cookies for a specific domain.
   */
  async clearCookies(domain: string): Promise<{ cleared: number }> {
    const cookies = await this.listCookies(domain);
    const domainLower = domain.toLowerCase();

    // Filter to only cookies matching this domain
    const toDelete = cookies.filter((c) =>
      c.domain.toLowerCase().includes(domainLower),
    );

    const cdp = await this.getCDPSession();
    try {
      const url = domain.startsWith("http") ? domain : `https://${domain}`;

      for (const cookie of toDelete) {
        await cdp.send("Network.deleteCookies", {
          name: cookie.name,
          domain: cookie.domain,
          url,
        });
      }

      return { cleared: toDelete.length };
    } finally {
      await cdp.detach();
    }
  }

  /**
   * Export all cookies (optionally filtered by domain) as a JSON-serializable array.
   */
  async exportCookies(domain?: string): Promise<CookieEntry[]> {
    return this.listCookies(domain);
  }
}
