/**
 * AXON Chrome Server — Browser Management Layer
 *
 * Manages Puppeteer browser instance, pages, and tabs.
 * Provides the low-level Chrome automation that tools build on.
 */

import puppeteer, {
  Browser,
  Page,
  ElementHandle,
  type ScreenshotOptions,
} from "puppeteer";

// ============================================================================
// Browser Manager
// ============================================================================

export interface BrowserConfig {
  headless: boolean;
  defaultViewport: { width: number; height: number };
  args: string[];
  executablePath?: string;
}

const DEFAULT_CONFIG: BrowserConfig = {
  headless: false,
  defaultViewport: { width: 1280, height: 800 },
  args: [
    "--no-first-run",
    "--disable-default-apps",
    "--disable-popup-blocking",
  ],
};

export class BrowserManager {
  private browser: Browser | null = null;
  private pages: Map<number, Page> = new Map();
  private nextTabId = 1;
  private config: BrowserConfig;

  constructor(config?: Partial<BrowserConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async launch(): Promise<void> {
    if (this.browser) return;

    this.browser = await puppeteer.launch({
      headless: this.config.headless,
      defaultViewport: this.config.defaultViewport,
      args: this.config.args,
      executablePath: this.config.executablePath,
    });

    // Register the initial blank page
    const pages = await this.browser.pages();
    if (pages.length > 0) {
      const tabId = this.nextTabId++;
      this.pages.set(tabId, pages[0]);
    }

    // Listen for new pages (popups, window.open)
    this.browser.on("targetcreated", async (target) => {
      if (target.type() === "page") {
        const page = await target.page();
        if (page && !this.findTabId(page)) {
          const tabId = this.nextTabId++;
          this.pages.set(tabId, page);
        }
      }
    });
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.pages.clear();
    }
  }

  // ==========================================================================
  // Tab Management
  // ==========================================================================

  async createTab(url?: string): Promise<{ tabId: number; url: string }> {
    this.ensureBrowser();
    const page = await this.browser!.newPage();
    const tabId = this.nextTabId++;
    this.pages.set(tabId, page);

    if (url) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }

    return { tabId, url: page.url() };
  }

  async closeTab(tabId: number): Promise<void> {
    const page = this.getPage(tabId);
    await page.close();
    this.pages.delete(tabId);
  }

  listTabs(): { tabId: number; url: string; title: string }[] {
    const tabs: { tabId: number; url: string; title: string }[] = [];
    for (const [tabId, page] of this.pages) {
      tabs.push({
        tabId,
        url: page.url(),
        title: "", // Will be filled async if needed
      });
    }
    return tabs;
  }

  async listTabsDetailed(): Promise<{ tabId: number; url: string; title: string }[]> {
    const results: { tabId: number; url: string; title: string }[] = [];
    for (const [tabId, page] of this.pages) {
      try {
        results.push({
          tabId,
          url: page.url(),
          title: await page.title(),
        });
      } catch {
        results.push({ tabId, url: page.url(), title: "(unreachable)" });
      }
    }
    return results;
  }

  // ==========================================================================
  // Navigation
  // ==========================================================================

  async navigate(tabId: number, url: string): Promise<{ url: string; title: string; status: number }> {
    const page = this.getPage(tabId);

    // Auto-add https:// if missing
    if (!url.match(/^https?:\/\//)) {
      url = `https://${url}`;
    }

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    return {
      url: page.url(),
      title: await page.title(),
      status: response?.status() ?? 0,
    };
  }

  async goBack(tabId: number): Promise<{ url: string; title: string }> {
    const page = this.getPage(tabId);
    await page.goBack({ waitUntil: "domcontentloaded" });
    return { url: page.url(), title: await page.title() };
  }

  async goForward(tabId: number): Promise<{ url: string; title: string }> {
    const page = this.getPage(tabId);
    await page.goForward({ waitUntil: "domcontentloaded" });
    return { url: page.url(), title: await page.title() };
  }

  async reload(tabId: number): Promise<{ url: string; title: string }> {
    const page = this.getPage(tabId);
    await page.reload({ waitUntil: "domcontentloaded" });
    return { url: page.url(), title: await page.title() };
  }

  // ==========================================================================
  // Screenshots
  // ==========================================================================

  async screenshot(tabId: number, opts?: {
    fullPage?: boolean;
    selector?: string;
    quality?: number;
  }): Promise<{ base64: string; width: number; height: number; bytes: number }> {
    const page = this.getPage(tabId);

    const screenshotOpts: ScreenshotOptions = {
      type: "png",
      fullPage: opts?.fullPage ?? false,
      encoding: "base64",
    };

    let base64: string;
    if (opts?.selector) {
      const element = await page.$(opts.selector);
      if (!element) throw new Error(`Element not found: ${opts.selector}`);
      base64 = (await element.screenshot({ encoding: "base64" })) as string;
    } else {
      base64 = (await page.screenshot(screenshotOpts)) as string;
    }

    const viewport = page.viewport();
    return {
      base64,
      width: viewport?.width ?? 1280,
      height: viewport?.height ?? 800,
      bytes: Math.round(base64.length * 0.75), // Base64 overhead
    };
  }

  // ==========================================================================
  // DOM Interaction
  // ==========================================================================

  async click(tabId: number, selector: string, opts?: {
    button?: "left" | "right" | "middle";
    clickCount?: number;
    delay?: number;
  }): Promise<{ clicked: boolean; selector: string }> {
    const page = this.getPage(tabId);
    await page.click(selector, {
      button: opts?.button ?? "left",
      clickCount: opts?.clickCount ?? 1,
      delay: opts?.delay ?? 0,
    });
    return { clicked: true, selector };
  }

  async clickAtCoords(tabId: number, x: number, y: number): Promise<{ clicked: boolean; x: number; y: number }> {
    const page = this.getPage(tabId);
    await page.mouse.click(x, y);
    return { clicked: true, x, y };
  }

  async type(tabId: number, selector: string, text: string, opts?: {
    delay?: number;
    clear?: boolean;
  }): Promise<{ typed: boolean; selector: string; length: number }> {
    const page = this.getPage(tabId);

    if (opts?.clear) {
      await page.click(selector, { clickCount: 3 });
      await page.keyboard.press("Backspace");
    }

    await page.type(selector, text, { delay: opts?.delay ?? 0 });
    return { typed: true, selector, length: text.length };
  }

  async pressKey(tabId: number, key: string): Promise<{ pressed: boolean; key: string }> {
    const page = this.getPage(tabId);
    await page.keyboard.press(key as any);
    return { pressed: true, key };
  }

  async scroll(tabId: number, direction: "up" | "down" | "left" | "right", amount?: number): Promise<void> {
    const page = this.getPage(tabId);
    const scrollAmount = amount ?? 300;

    await page.evaluate(
      (dir: string, amt: number) => {
        switch (dir) {
          case "up": window.scrollBy(0, -amt); break;
          case "down": window.scrollBy(0, amt); break;
          case "left": window.scrollBy(-amt, 0); break;
          case "right": window.scrollBy(amt, 0); break;
        }
      },
      direction,
      scrollAmount
    );
  }

  async hover(tabId: number, selector: string): Promise<void> {
    const page = this.getPage(tabId);
    await page.hover(selector);
  }

  async focus(tabId: number, selector: string): Promise<void> {
    const page = this.getPage(tabId);
    await page.focus(selector);
  }

  async select(tabId: number, selector: string, ...values: string[]): Promise<string[]> {
    const page = this.getPage(tabId);
    return page.select(selector, ...values);
  }

  // ==========================================================================
  // Content Extraction
  // ==========================================================================

  async getPageText(tabId: number): Promise<{ text: string; url: string; title: string }> {
    const page = this.getPage(tabId);
    const text = await page.evaluate(() => {
      // Try to extract article content first, fall back to body text
      const article = document.querySelector("article") ?? document.querySelector("main") ?? document.body;
      return article?.innerText ?? "";
    });

    return { text, url: page.url(), title: await page.title() };
  }

  async getAccessibilityTree(tabId: number, opts?: {
    selector?: string;
    interactiveOnly?: boolean;
    maxDepth?: number;
  }): Promise<any> {
    const page = this.getPage(tabId);

    const tree = await page.evaluate(
      (options: { selector?: string; interactiveOnly?: boolean; maxDepth?: number }) => {
        const interactiveTags = new Set([
          "A", "BUTTON", "INPUT", "TEXTAREA", "SELECT", "DETAILS", "SUMMARY",
          "LABEL", "OPTION", "FIELDSET", "LEGEND",
        ]);
        const interactiveRoles = new Set([
          "button", "link", "textbox", "checkbox", "radio", "combobox",
          "listbox", "menuitem", "tab", "switch", "slider",
        ]);

        function isInteractive(el: Element): boolean {
          if (interactiveTags.has(el.tagName)) return true;
          const role = el.getAttribute("role");
          if (role && interactiveRoles.has(role)) return true;
          if (el.hasAttribute("onclick") || el.hasAttribute("tabindex")) return true;
          return false;
        }

        function isVisible(el: Element): boolean {
          const style = window.getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
        }

        function walk(el: Element, depth: number): any | null {
          if (depth > (options.maxDepth ?? 10)) return null;
          if (!isVisible(el)) return null;
          if (options.interactiveOnly && !isInteractive(el)) {
            // Still recurse into children
            const children = Array.from(el.children)
              .map((c) => walk(c, depth + 1))
              .filter(Boolean);
            if (children.length === 1) return children[0];
            if (children.length > 1) return { children };
            return null;
          }

          const node: any = {
            tag: el.tagName.toLowerCase(),
          };

          const role = el.getAttribute("role");
          if (role) node.role = role;

          const text = el.textContent?.trim().slice(0, 100);
          if (text && el.children.length === 0) node.text = text;

          const label =
            el.getAttribute("aria-label") ??
            el.getAttribute("title") ??
            el.getAttribute("placeholder") ??
            el.getAttribute("alt");
          if (label) node.label = label;

          if (el.tagName === "A") node.href = (el as HTMLAnchorElement).href;
          if (el.tagName === "INPUT") {
            node.type = (el as HTMLInputElement).type;
            node.value = (el as HTMLInputElement).value;
            node.name = (el as HTMLInputElement).name;
          }
          if (el.tagName === "IMG") node.src = (el as HTMLImageElement).src?.slice(0, 200);

          if (el.id) node.id = el.id;
          const cls = el.className;
          if (typeof cls === "string" && cls) node.class = cls.split(/\s+/).slice(0, 3).join(" ");

          const children = Array.from(el.children)
            .map((c) => walk(c, depth + 1))
            .filter(Boolean);
          if (children.length > 0) node.children = children;

          return node;
        }

        const root = options.selector
          ? document.querySelector(options.selector) ?? document.body
          : document.body;

        return walk(root, 0);
      },
      opts ?? {}
    );

    return tree;
  }

  async findElements(tabId: number, query: string): Promise<{
    elements: {
      index: number;
      tag: string;
      text: string;
      selector: string;
      visible: boolean;
      rect: { x: number; y: number; width: number; height: number } | null;
    }[];
  }> {
    const page = this.getPage(tabId);

    const elements = await page.evaluate((q: string) => {
      const results: any[] = [];

      // Strategy 1: CSS selector
      try {
        const els = document.querySelectorAll(q);
        els.forEach((el, i) => {
          const rect = el.getBoundingClientRect();
          results.push({
            index: i,
            tag: el.tagName.toLowerCase(),
            text: (el.textContent ?? "").trim().slice(0, 100),
            selector: buildSelector(el),
            visible: rect.width > 0 && rect.height > 0,
            rect: rect.width > 0 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
          });
        });
        if (results.length > 0) return results;
      } catch { /* Not a valid selector, try text search */ }

      // Strategy 2: Text content search
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node: Element | null;
      let idx = 0;
      const lowerQ = q.toLowerCase();

      while ((node = walker.nextNode() as Element | null)) {
        const text = (node.textContent ?? "").trim();
        if (text.toLowerCase().includes(lowerQ)) {
          const rect = node.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            results.push({
              index: idx++,
              tag: node.tagName.toLowerCase(),
              text: text.slice(0, 100),
              selector: buildSelector(node),
              visible: true,
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            });
            if (results.length >= 20) break;
          }
        }
      }

      return results;

      function buildSelector(el: Element): string {
        if (el.id) return `#${el.id}`;
        const tag = el.tagName.toLowerCase();
        const cls = el.className && typeof el.className === "string"
          ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
          : "";
        const nth = Array.from(el.parentElement?.children ?? []).indexOf(el);
        return `${tag}${cls}:nth-child(${nth + 1})`;
      }
    }, query);

    return { elements };
  }

  // ==========================================================================
  // JavaScript Execution
  // ==========================================================================

  async evaluate(tabId: number, expression: string): Promise<any> {
    const page = this.getPage(tabId);
    return page.evaluate(expression);
  }

  // ==========================================================================
  // Page Info
  // ==========================================================================

  async getPageInfo(tabId: number): Promise<{
    url: string;
    title: string;
    viewport: { width: number; height: number };
    cookies: number;
  }> {
    const page = this.getPage(tabId);
    const viewport = page.viewport();
    const cookies = await page.cookies();

    return {
      url: page.url(),
      title: await page.title(),
      viewport: { width: viewport?.width ?? 0, height: viewport?.height ?? 0 },
      cookies: cookies.length,
    };
  }

  async waitForSelector(tabId: number, selector: string, timeout?: number): Promise<boolean> {
    const page = this.getPage(tabId);
    try {
      await page.waitForSelector(selector, { timeout: timeout ?? 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async waitForNavigation(tabId: number, timeout?: number): Promise<{ url: string }> {
    const page = this.getPage(tabId);
    await page.waitForNavigation({ timeout: timeout ?? 30_000, waitUntil: "domcontentloaded" });
    return { url: page.url() };
  }

  async setViewport(tabId: number, width: number, height: number): Promise<void> {
    const page = this.getPage(tabId);
    await page.setViewport({ width, height });
  }

  // ==========================================================================
  // Private
  // ==========================================================================

  private getPage(tabId: number): Page {
    const page = this.pages.get(tabId);
    if (!page) throw new Error(`Tab ${tabId} not found. Available: ${Array.from(this.pages.keys()).join(", ")}`);
    return page;
  }

  private findTabId(page: Page): number | undefined {
    for (const [id, p] of this.pages) {
      if (p === page) return id;
    }
    return undefined;
  }

  private ensureBrowser(): void {
    if (!this.browser) throw new Error("Browser not launched. Call launch() first.");
  }

  get isLaunched(): boolean {
    return this.browser !== null;
  }

  get tabCount(): number {
    return this.pages.size;
  }
}
