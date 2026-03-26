import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { NativeSidecarClient } from "../native-sidecar.js";
import { defaultDataDir } from "../../config.js";
import type {
  SidecarAccessibilitySnapshotResult,
  SidecarHealthResult,
  SidecarListWindowsResult,
  SidecarPermissionsResult
} from "../../types/native-sidecar.js";

const execFileAsync = promisify(execFile);

function escapeAppleScript(text: string): string {
  return String(text).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function buildAccessibilitySnapshotScript(appName: string) {
  const appNameLiteral = JSON.stringify(String(appName ?? "").trim());
  return `
const targetApp = ${appNameLiteral};
function safe(fn, fallback) {
  try {
    const value = fn();
    return value === undefined || value === null ? fallback : value;
  } catch (_error) {
    return fallback;
  }
}

function toArray(collection) {
  if (!collection) {
    return [];
  }
  return safe(() => collection(), []);
}
function text(value) {
  const raw = value === undefined || value === null ? "" : String(value);
  return raw.trim();
}
function readBounds(element) {
  const position = safe(() => element.position(), null);
  const size = safe(() => element.size(), null);
  if (!position || !size || position.length < 2 || size.length < 2) {
    return null;
  }
  const x = Number(position[0]);
  const y = Number(position[1]);
  const width = Number(size[0]);
  const height = Number(size[1]);
  if (![x, y, width, height].every(Number.isFinite)) {
    return null;
  }
  return {
    x,
    y,
    width,
    height,
    centerX: x + width / 2,
    centerY: y + height / 2
  };
}
function actionNames(element) {
  return toArray(safe(() => element.actions, null))
    .map((action) => text(safe(() => action.name(), "")))
    .filter(Boolean);
}
function serializeElement(element, index, windowTitle) {
  return {
    id: "ax-" + index,
    role: text(safe(() => element.role(), "")),
    subrole: text(safe(() => element.subrole(), "")) || null,
    title: text(safe(() => element.title(), "")) || null,
    value: text(safe(() => element.value(), "")) || null,
    description: text(safe(() => element.description(), "")) || null,
    enabled: Boolean(safe(() => element.enabled(), true)),
    focused: Boolean(safe(() => element.focused(), false)),
    actions: actionNames(element),
    windowTitle: text(windowTitle) || null,
    bounds: readBounds(element)
  };
}
const systemEvents = Application("System Events");
const process = systemEvents.processes.byName(targetApp);
const windows = toArray(safe(() => process.windows, null));
const serializedWindows = windows.map((window) => ({
  title: text(safe(() => window.name(), "")),
  bounds: readBounds(window)
}));
const elements = [];
let nextIndex = 1;
windows.forEach((window) => {
  const windowTitle = text(safe(() => window.name(), ""));
  const content = [window].concat(toArray(safe(() => window.entireContents, null)));
  content.forEach((element) => {
    const serialized = serializeElement(element, nextIndex, windowTitle);
    nextIndex += 1;
    elements.push(serialized);
  });
});
JSON.stringify({
  appName: targetApp,
  windows: serializedWindows,
  elements: elements.slice(0, 400)
});
`.trim();
}

function buildFrontmostAppSwiftScript() {
  return `
import AppKit
import Foundation

let appName = NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
let bundleIdentifier = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
let payload: [String: String] = [
  "appName": appName,
  "bundleIdentifier": bundleIdentifier
]
let data = try JSONSerialization.data(withJSONObject: payload, options: [])
FileHandle.standardOutput.write(data)
`.trim();
}

function buildListWindowsSwiftScript() {
  return `
import CoreGraphics
import Foundation

func number(_ value: Any?) -> Double? {
  switch value {
  case let number as NSNumber:
    return number.doubleValue
  case let value as Double:
    return value
  case let value as Int:
    return Double(value)
  default:
    return nil
  }
}

var windows: [[String: Any]] = []
if let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] {
  for entry in info {
    let ownerName = entry[kCGWindowOwnerName as String] as? String ?? ""
    let windowName = entry[kCGWindowName as String] as? String ?? ""
    let layer = Int(number(entry[kCGWindowLayer as String]) ?? -1)
    let alpha = number(entry[kCGWindowAlpha as String]) ?? 0
    if ownerName.isEmpty || layer != 0 || alpha <= 0 {
      continue
    }
    let windowNumber = Int(number(entry[kCGWindowNumber as String]) ?? -1)
    let ownerPID = Int(number(entry[kCGWindowOwnerPID as String]) ?? -1)
    let boundsValue = entry[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let x = number(boundsValue["X"]) ?? 0
    let y = number(boundsValue["Y"]) ?? 0
    let width = number(boundsValue["Width"]) ?? 0
    let height = number(boundsValue["Height"]) ?? 0
    windows.append([
      "ownerName": ownerName,
      "windowName": windowName,
      "ownerPID": ownerPID,
      "windowNumber": windowNumber,
      "layer": layer,
      "alpha": alpha,
      "bounds": [
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "centerX": x + width / 2,
        "centerY": y + height / 2
      ]
    ])
  }
}

let payload: [String: Any] = ["windows": windows]
let data = try JSONSerialization.data(withJSONObject: payload, options: [])
FileHandle.standardOutput.write(data)
`.trim();
}

function buildPermissionsSwiftScript() {
  return `
import ApplicationServices
import CoreGraphics
import Foundation

let payload: [String: Any] = [
  "accessibility": AXIsProcessTrusted(),
  "screenRecording": CGPreflightScreenCaptureAccess()
]
let data = try JSONSerialization.data(withJSONObject: payload, options: [])
FileHandle.standardOutput.write(data)
`.trim();
}

function isUsableFrontmostApp(payload: { appName?: string; bundleIdentifier?: string } | null | undefined) {
  const appName = String(payload?.appName ?? "").trim();
  const bundleIdentifier = String(payload?.bundleIdentifier ?? "").trim();
  if (!appName) {
    return false;
  }
  if (appName === "loginwindow" || bundleIdentifier === "com.apple.loginwindow") {
    return false;
  }
  return true;
}

export interface MacOSHostBridgeOptions {
  dataDir?: string;
  sidecarExecutablePath?: string | null;
  sidecarArgs?: string[];
}

interface SidecarRequestOptions {
  timeoutMs?: number;
  resetSidecarOnFailure?: boolean;
}

export class MacOSHostBridge {
  sidecar: NativeSidecarClient;

  constructor(options: MacOSHostBridgeOptions = {}) {
    const dataDir = options.dataDir ?? defaultDataDir();
    this.sidecar = new NativeSidecarClient({
      dataDir,
      executablePath: options.sidecarExecutablePath ?? process.env.AGENTOS_NATIVE_SIDECAR,
      args: options.sidecarArgs ?? []
    });
  }

  async captureScreen(filePath: string, windowNumber?: number | null): Promise<unknown> {
    return this.#requestSidecar("capture_screen", { filePath, ...(windowNumber ? { windowNumber } : {}) }, async () => {
      const args = ["-x"];
      if (windowNumber) {
        args.push("-o", "-l", String(windowNumber));
      }
      args.push(filePath);
      await execFileAsync("screencapture", args);
      return { filePath, windowNumber: windowNumber ?? null };
    }, { timeoutMs: 1200 });
  }

  async launchApp(name: string): Promise<unknown> {
    return this.#requestSidecar("launch_app", { name }, async () => {
      await execFileAsync("open", ["-a", name]);
      return { launched: name };
    }, { timeoutMs: 1200 });
  }

  async focusApp(name: string): Promise<unknown> {
    return this.#requestSidecar("focus_app", { name }, async () => {
      await execFileAsync("open", ["-a", name]);
      await execFileAsync("osascript", [
        "-e",
        `tell application "${escapeAppleScript(name)}" to activate`
      ]);
      await execFileAsync("osascript", [
        "-e",
        `tell application "System Events" to set frontmost of process "${escapeAppleScript(name)}" to true`
      ]);
      return { focused: name };
    }, { timeoutMs: 900 });
  }

  async getFrontmostApp(): Promise<unknown> {
    const swiftFallback = async () => {
      const { stdout } = await execFileAsync("swift", ["-e", buildFrontmostAppSwiftScript()], {
        maxBuffer: 1024 * 1024
      });
      const payload = JSON.parse(stdout.trim() || "{}") as { appName?: string; bundleIdentifier?: string };
      return {
        appName: String(payload.appName ?? "").trim(),
        bundleIdentifier: String(payload.bundleIdentifier ?? "").trim()
      };
    };
    const result = await this.#requestSidecar<Record<string, unknown>>("frontmost_app", {}, swiftFallback, { timeoutMs: 700 });
    if (isUsableFrontmostApp(result as { appName?: string; bundleIdentifier?: string })) {
      return result;
    }
    const windows = await this.listWindows().catch(() => ({ windows: [] }));
    const firstWindow = Array.isArray(windows?.windows) ? windows.windows[0] : null;
    if (firstWindow && String(firstWindow.ownerName ?? "").trim()) {
      return {
        appName: String(firstWindow.ownerName ?? "").trim(),
        bundleIdentifier: ""
      };
    }
    return swiftFallback();
  }

  async getPermissionsStatus(): Promise<SidecarPermissionsResult> {
    return this.#requestSidecar<SidecarPermissionsResult>("permissions_status", {}, async () => {
      const { stdout } = await execFileAsync("swift", ["-e", buildPermissionsSwiftScript()], {
        maxBuffer: 1024 * 1024
      });
      const payload = JSON.parse(stdout.trim() || "{}") as Partial<SidecarPermissionsResult>;
      return {
        accessibility: Boolean(payload.accessibility),
        screenRecording: Boolean(payload.screenRecording)
      };
    }, { timeoutMs: 1500 });
  }

  async listWindows(): Promise<SidecarListWindowsResult> {
    const fallback = async () => {
      const { stdout } = await execFileAsync("swift", ["-e", buildListWindowsSwiftScript()], {
        maxBuffer: 1024 * 1024 * 8
      });
      const payload = JSON.parse(stdout.trim() || "{}") as Partial<SidecarListWindowsResult>;
      return {
        windows: Array.isArray(payload.windows) ? payload.windows : []
      };
    };
    const result = await this.#requestSidecar<SidecarListWindowsResult>("list_windows", {}, fallback, { timeoutMs: 1500 });
    if (Array.isArray(result?.windows) && result.windows.length > 0) {
      return result;
    }
    return fallback();
  }

  async getAccessibilitySnapshot(appName: string): Promise<SidecarAccessibilitySnapshotResult> {
    const normalizedAppName = String(appName ?? "").trim();
    if (!normalizedAppName) {
      return {
        appName: "",
        windows: [],
        elements: []
      };
    }

    return this.#requestSidecar<SidecarAccessibilitySnapshotResult>(
      "accessibility_snapshot",
      { appName: normalizedAppName },
      async () => {
        const { stdout } = await execFileAsync(
          "osascript",
          ["-l", "JavaScript", "-e", buildAccessibilitySnapshotScript(normalizedAppName)],
          {
            maxBuffer: 1024 * 1024 * 8
          }
        );
        const payload = JSON.parse(stdout.trim() || "{}") as Partial<SidecarAccessibilitySnapshotResult>;
        return {
          appName: String(payload.appName ?? normalizedAppName),
          windows: Array.isArray(payload.windows) ? payload.windows : [],
          elements: Array.isArray(payload.elements) ? payload.elements : []
        };
      },
      { timeoutMs: 1800 }
    );
  }

  async typeText(text: string): Promise<unknown> {
    return this.#requestSidecar("type_text", { text }, null);
  }

  async pasteText(text: string): Promise<unknown> {
    const previousClipboard = await this.#readClipboardText();
    await this.#writeClipboardText(text);
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      const result = await this.pressKey("v", ["cmd"]);
      await new Promise((resolve) => setTimeout(resolve, 150));
      return result;
    } finally {
      if (previousClipboard !== null) {
        await this.#writeClipboardText(previousClipboard).catch(() => null);
      }
    }
  }

  async pressKey(key: string, modifiers: string[] = []): Promise<unknown> {
    return this.#requestSidecar("key_press", { key, modifiers }, null);
  }

  async captureSelectedText(): Promise<string | null> {
    const previousClipboard = await this.#readClipboardText();
    try {
      await this.pressKey("c", ["cmd"]);
      await new Promise((resolve) => setTimeout(resolve, 90));
      return await this.#readClipboardText();
    } finally {
      if (previousClipboard !== null) {
        await this.#writeClipboardText(previousClipboard).catch(() => null);
      }
    }
  }

  async clickAt(x: number, y: number): Promise<unknown> {
    return this.#requestSidecar("click_at", { x, y }, null);
  }

  async moveMouse(x: number, y: number): Promise<unknown> {
    return this.#requestSidecar("move_mouse", { x, y }, null);
  }

  async scroll(dx: number, dy: number): Promise<unknown> {
    return this.#requestSidecar("scroll", { dx, dy }, null);
  }

  async sidecarHealth(): Promise<SidecarHealthResult> {
    return this.sidecar.request<SidecarHealthResult>("health", {});
  }

  async runCommand(command: string, cwd = process.cwd()): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFileAsync("zsh", ["-lc", command], {
      cwd
    });
    return { stdout, stderr };
  }

  async #readClipboardText(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("pbpaste", [], {
        maxBuffer: 1024 * 1024 * 8
      });
      return stdout;
    } catch {
      return null;
    }
  }

  async #writeClipboardText(text: string): Promise<void> {
    await execFileAsync("zsh", ["-lc", "printf %s \"$AGENTOS_PASTE_TEXT\" | pbcopy"], {
      env: {
        ...process.env,
        AGENTOS_PASTE_TEXT: text
      },
      maxBuffer: 1024 * 1024 * 8
    });
  }

  async shutdown(): Promise<void> {
    await this.sidecar.shutdown();
  }

  async #requestSidecar<TResult>(
    method: string,
    params: Record<string, unknown>,
    fallback: (() => Promise<TResult>) | null,
    { timeoutMs = 15000, resetSidecarOnFailure = true }: SidecarRequestOptions = {}
  ): Promise<TResult> {
    if (await this.sidecar.isAvailable()) {
      try {
        return await this.sidecar.request<TResult>(method, params, { timeoutMs });
      } catch {
        if (resetSidecarOnFailure) {
          await this.sidecar.shutdown().catch(() => null);
        }
        if (fallback) {
          return fallback();
        }
        throw new Error(`Rust sidecar request failed for ${method}.`);
      }
    }

    if (!fallback) {
      throw new Error(`No fallback is available for ${method}.`);
    }

    return fallback();
  }
}
