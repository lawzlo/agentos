import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { NativeSidecarClient } from "../native-sidecar.js";
import type {
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

export interface MacOSHostBridgeOptions {
  dataDir?: string;
  sidecarExecutablePath?: string | null;
  sidecarArgs?: string[];
}

export class MacOSHostBridge {
  sidecar: NativeSidecarClient;

  constructor(options: MacOSHostBridgeOptions = {}) {
    const dataDir = options.dataDir ?? path.join(process.cwd(), ".agentos");
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
