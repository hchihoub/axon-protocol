/**
 * AXON Screenshot Manager — Core Implementation
 *
 * Cross-platform screen capture using system commands:
 *   - macOS: screencapture
 *   - Linux: import (ImageMagick), gnome-screenshot, or scrot
 *   - Windows: PowerShell screen capture
 *
 * Screenshots are stored as PNG files in ~/.axon/screenshots/.
 * Each screenshot is tracked with metadata (dimensions, file size, timestamp).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

const execFileAsync = promisify(execFile);

// ============================================================================
// Types
// ============================================================================

export interface ScreenshotInfo {
  /** Unique ID for the screenshot */
  id: string;
  /** Filename on disk */
  filename: string;
  /** Full path to the screenshot file */
  filepath: string;
  /** Timestamp when the screenshot was taken (ISO 8601) */
  timestamp: string;
  /** File size in bytes */
  sizeBytes: number;
  /** Capture type: "fullscreen", "region", or "window" */
  captureType: string;
  /** Optional label or description */
  label?: string;
}

export interface ScreenshotManagerConfig {
  /** Directory to store screenshots (default: ~/.axon/screenshots/) */
  screenshotDir?: string;
}

export interface CaptureRegion {
  /** X coordinate of top-left corner */
  x: number;
  /** Y coordinate of top-left corner */
  y: number;
  /** Width of the region */
  width: number;
  /** Height of the region */
  height: number;
}

// ============================================================================
// ScreenshotManager
// ============================================================================

export class ScreenshotManager {
  private screenshotDir: string;
  private screenshots: Map<string, ScreenshotInfo> = new Map();
  private idCounter = 0;

  constructor(config?: ScreenshotManagerConfig) {
    this.screenshotDir =
      config?.screenshotDir ?? path.join(os.homedir(), ".axon", "screenshots");

    // Ensure the screenshot directory exists
    if (!fs.existsSync(this.screenshotDir)) {
      fs.mkdirSync(this.screenshotDir, { recursive: true });
    }

    // Index existing screenshots on disk
    this.indexExisting();
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  private indexExisting(): void {
    try {
      const files = fs.readdirSync(this.screenshotDir);
      for (const file of files) {
        if (!file.endsWith(".png")) continue;
        const filepath = path.join(this.screenshotDir, file);
        const stat = fs.statSync(filepath);
        const id = this.generateId();
        this.screenshots.set(id, {
          id,
          filename: file,
          filepath,
          timestamp: stat.mtime.toISOString(),
          sizeBytes: stat.size,
          captureType: "unknown",
        });
      }
    } catch {
      // Directory might not exist yet or be unreadable
    }
  }

  private generateId(): string {
    return `ss_${this.idCounter++}`;
  }

  private generateFilename(captureType: string): string {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const rand = crypto.randomBytes(4).toString("hex");
    return `screenshot_${captureType}_${ts}_${rand}.png`;
  }

  // --------------------------------------------------------------------------
  // Platform-Specific Capture
  // --------------------------------------------------------------------------

  private async captureFullscreen(filepath: string): Promise<void> {
    const platform = process.platform;

    if (platform === "darwin") {
      await execFileAsync("screencapture", ["-x", filepath]);
      return;
    }

    if (platform === "linux") {
      // Try multiple tools in order of preference
      try {
        await execFileAsync("import", ["-window", "root", filepath]);
        return;
      } catch {
        // import not available
      }
      try {
        await execFileAsync("gnome-screenshot", ["-f", filepath]);
        return;
      } catch {
        // gnome-screenshot not available
      }
      try {
        await execFileAsync("scrot", [filepath]);
        return;
      } catch {
        throw new Error(
          "No screenshot tool found. Install one of: ImageMagick (import), gnome-screenshot, or scrot",
        );
      }
    }

    if (platform === "win32") {
      const psScript = `
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
        $bitmap.Save('${filepath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
        $graphics.Dispose()
        $bitmap.Dispose()
      `;
      await execFileAsync("powershell.exe", ["-NoProfile", "-Command", psScript]);
      return;
    }

    throw new Error(`Unsupported platform: ${platform}`);
  }

  private async captureRegion(filepath: string, region: CaptureRegion): Promise<void> {
    const platform = process.platform;
    const { x, y, width, height } = region;

    if (platform === "darwin") {
      await execFileAsync("screencapture", [
        "-x",
        "-R",
        `${x},${y},${width},${height}`,
        filepath,
      ]);
      return;
    }

    if (platform === "linux") {
      try {
        await execFileAsync("import", [
          "-window",
          "root",
          "-crop",
          `${width}x${height}+${x}+${y}`,
          filepath,
        ]);
        return;
      } catch {
        // import not available
      }
      try {
        await execFileAsync("scrot", [
          "-a",
          `${x},${y},${width},${height}`,
          filepath,
        ]);
        return;
      } catch {
        throw new Error(
          "No screenshot tool with region support found. Install ImageMagick (import) or scrot",
        );
      }
    }

    if (platform === "win32") {
      const psScript = `
        Add-Type -AssemblyName System.Drawing
        $bitmap = New-Object System.Drawing.Bitmap(${width}, ${height})
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen(${x}, ${y}, 0, 0, New-Object System.Drawing.Size(${width}, ${height}))
        $bitmap.Save('${filepath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
        $graphics.Dispose()
        $bitmap.Dispose()
      `;
      await execFileAsync("powershell.exe", ["-NoProfile", "-Command", psScript]);
      return;
    }

    throw new Error(`Unsupported platform: ${platform}`);
  }

  private async captureWindowByTitle(filepath: string, windowTitle: string): Promise<void> {
    const platform = process.platform;

    if (platform === "darwin") {
      // Get window ID using CGWindowListCopyWindowInfo via osascript
      const { stdout: windowId } = await execFileAsync("osascript", [
        "-e",
        `tell application "System Events" to get the id of first window of (first process whose name contains "${windowTitle.replace(/"/g, '\\"')}")`,
      ]);
      const wid = windowId.trim();
      if (!wid) throw new Error(`Window not found: ${windowTitle}`);
      await execFileAsync("screencapture", ["-x", "-l", wid, filepath]);
      return;
    }

    if (platform === "linux") {
      try {
        // Use xdotool to find window ID, then import to capture
        const { stdout: windowId } = await execFileAsync("xdotool", [
          "search",
          "--name",
          windowTitle,
        ]);
        const wid = windowId.trim().split("\n")[0];
        if (!wid) throw new Error(`Window not found: ${windowTitle}`);
        await execFileAsync("import", ["-window", wid, filepath]);
        return;
      } catch (err: any) {
        if (err.message.includes("Window not found")) throw err;
        throw new Error(
          "Window capture requires xdotool and ImageMagick (import) on Linux",
        );
      }
    }

    if (platform === "win32") {
      const psScript = `
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class WinAPI {
          [DllImport("user32.dll")]
          public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
          [DllImport("user32.dll")]
          [return: MarshalAs(UnmanagedType.Bool)]
          public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
          [StructLayout(LayoutKind.Sequential)]
          public struct RECT { public int Left, Top, Right, Bottom; }
        }
"@
        $hwnd = [WinAPI]::FindWindow($null, '${windowTitle.replace(/'/g, "''")}')
        if ($hwnd -eq [IntPtr]::Zero) { throw "Window not found: ${windowTitle}" }
        $rect = New-Object WinAPI+RECT
        [WinAPI]::GetWindowRect($hwnd, [ref]$rect)
        $w = $rect.Right - $rect.Left
        $h = $rect.Bottom - $rect.Top
        $bitmap = New-Object System.Drawing.Bitmap($w, $h)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, New-Object System.Drawing.Size($w, $h))
        $bitmap.Save('${filepath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
        $graphics.Dispose()
        $bitmap.Dispose()
      `;
      await execFileAsync("powershell.exe", ["-NoProfile", "-Command", psScript]);
      return;
    }

    throw new Error(`Unsupported platform: ${platform}`);
  }

  // --------------------------------------------------------------------------
  // Core Operations
  // --------------------------------------------------------------------------

  /**
   * Take a screenshot (fullscreen or region).
   */
  async takeScreenshot(options?: {
    region?: CaptureRegion;
    label?: string;
  }): Promise<ScreenshotInfo> {
    const captureType = options?.region ? "region" : "fullscreen";
    const filename = this.generateFilename(captureType);
    const filepath = path.join(this.screenshotDir, filename);

    if (options?.region) {
      await this.captureRegion(filepath, options.region);
    } else {
      await this.captureFullscreen(filepath);
    }

    const stat = fs.statSync(filepath);
    const id = this.generateId();

    const info: ScreenshotInfo = {
      id,
      filename,
      filepath,
      timestamp: new Date().toISOString(),
      sizeBytes: stat.size,
      captureType,
      label: options?.label,
    };

    this.screenshots.set(id, info);
    return info;
  }

  /**
   * Capture a specific window by title.
   */
  async captureWindow(windowTitle: string, label?: string): Promise<ScreenshotInfo> {
    const filename = this.generateFilename("window");
    const filepath = path.join(this.screenshotDir, filename);

    await this.captureWindowByTitle(filepath, windowTitle);

    const stat = fs.statSync(filepath);
    const id = this.generateId();

    const info: ScreenshotInfo = {
      id,
      filename,
      filepath,
      timestamp: new Date().toISOString(),
      sizeBytes: stat.size,
      captureType: "window",
      label: label ?? `Window: ${windowTitle}`,
    };

    this.screenshots.set(id, info);
    return info;
  }

  /**
   * List all saved screenshots.
   */
  listScreenshots(): { screenshots: ScreenshotInfo[]; total: number } {
    const screenshots = Array.from(this.screenshots.values()).sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
    return { screenshots, total: screenshots.length };
  }

  /**
   * Get a screenshot as base64-encoded data.
   */
  getScreenshot(id: string): { info: ScreenshotInfo; base64: string; mimeType: string } {
    const info = this.screenshots.get(id);
    if (!info) {
      throw new Error(`Screenshot not found: ${id}`);
    }

    if (!fs.existsSync(info.filepath)) {
      this.screenshots.delete(id);
      throw new Error(`Screenshot file missing from disk: ${info.filename}`);
    }

    const buffer = fs.readFileSync(info.filepath);
    const base64 = buffer.toString("base64");

    return {
      info,
      base64,
      mimeType: "image/png",
    };
  }

  /**
   * Delete a saved screenshot.
   */
  deleteScreenshot(id: string): { deleted: boolean; filename: string } {
    const info = this.screenshots.get(id);
    if (!info) {
      throw new Error(`Screenshot not found: ${id}`);
    }

    try {
      if (fs.existsSync(info.filepath)) {
        fs.unlinkSync(info.filepath);
      }
    } catch (err: any) {
      throw new Error(`Failed to delete screenshot file: ${err.message}`);
    }

    this.screenshots.delete(id);
    return { deleted: true, filename: info.filename };
  }
}
