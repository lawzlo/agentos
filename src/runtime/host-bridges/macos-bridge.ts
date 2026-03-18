import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { NativeSidecarClient } from "../native-sidecar.js";
import { defaultDataDir } from "../../config.js";
import type {
  SidecarAccessibilitySnapshotResult,
  SidecarFindTextResult,
  SidecarHealthResult,
  SidecarListWindowsResult,
  SidecarOcrResult,
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

export interface MacOSHostBridgeOptions {
  dataDir?: string;
  sidecarExecutablePath?: string | null;
  sidecarArgs?: string[];
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

  async captureScreen(filePath: string): Promise<unknown> {
    return this.#requestSidecar("capture_screen", { filePath }, async () => {
      await execFileAsync("screencapture", ["-x", filePath]);
      return { filePath };
    });
  }

  async launchApp(name: string): Promise<unknown> {
    return this.#requestSidecar("launch_app", { name }, async () => {
      await execFileAsync("open", ["-a", name]);
      return { launched: name };
    });
  }

  async focusApp(name: string): Promise<unknown> {
    return this.#requestSidecar("focus_app", { name }, async () => {
      await execFileAsync("osascript", [
        "-e",
        `tell application "${escapeAppleScript(name)}" to activate`
      ]);
      return { focused: name };
    });
  }

  async getFrontmostApp(): Promise<unknown> {
    return this.#requestSidecar("frontmost_app", {}, async () => {
      const { stdout } = await execFileAsync("osascript", [
        "-e",
        'tell application "System Events" to get name of first application process whose frontmost is true'
      ]);
      return { appName: stdout.trim() };
    });
  }

  async getPermissionsStatus(): Promise<SidecarPermissionsResult> {
    return this.#requestSidecar<SidecarPermissionsResult>("permissions_status", {}, null);
  }

  async listWindows(): Promise<SidecarListWindowsResult> {
    return this.#requestSidecar<SidecarListWindowsResult>("list_windows", {}, null);
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
      }
    );
  }

  async typeText(text: string): Promise<unknown> {
    return this.#requestSidecar("type_text", { text }, null);
  }

  async pressKey(key: string, modifiers: string[] = []): Promise<unknown> {
    return this.#requestSidecar("key_press", { key, modifiers }, null);
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

  async ocrImage(filePath: string): Promise<SidecarOcrResult> {
    return this.#requestSidecar<SidecarOcrResult>("ocr_image", { filePath }, null);
  }

  async findText(filePath: string, query: string): Promise<SidecarFindTextResult> {
    return this.#requestSidecar<SidecarFindTextResult>("find_text", { filePath, query }, null);
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

  async shutdown(): Promise<void> {
    await this.sidecar.shutdown();
  }

  async #requestSidecar<TResult>(
    method: string,
    params: Record<string, unknown>,
    fallback: (() => Promise<TResult>) | null
  ): Promise<TResult> {
    if (await this.sidecar.isAvailable()) {
      try {
        return await this.sidecar.request<TResult>(method, params);
      } catch {
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
