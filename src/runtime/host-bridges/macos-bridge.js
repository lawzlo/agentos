import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { MacOSHelper } from "./macos-helper.js";

const execFileAsync = promisify(execFile);

function escapeAppleScript(text) {
  return String(text).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

export class MacOSHostBridge {
  constructor(options = {}) {
    this.helper = new MacOSHelper({
      dataDir: options.dataDir ?? path.join(process.cwd(), ".agentos"),
      helperExecutable: options.helperExecutable ?? process.env.AGENTOS_MAC_HELPER_EXECUTABLE,
      sourcePath: options.sourcePath ?? path.join(process.cwd(), "native", "macos", "AgentOSHelper.swift")
    });
  }

  async captureScreen(filePath) {
    return this.helper.run("capture-screen", [filePath]);
  }

  async launchApp(name) {
    await execFileAsync("open", ["-a", name]);
    return { launched: name };
  }

  async focusApp(name) {
    await execFileAsync("osascript", ["-e", `tell application "${escapeAppleScript(name)}" to activate`]);
    return { focused: name };
  }

  async getFrontmostApp() {
    return this.helper.run("frontmost-app");
  }

  async typeText(text) {
    return this.helper.run("type-text", [text]);
  }

  async pressKey(key, modifiers = []) {
    return this.helper.run("key-press", [key, modifiers.join(",")]);
  }

  async clickAt(x, y) {
    return this.helper.run("click-at", [x, y]);
  }

  async moveMouse(x, y) {
    return this.helper.run("move-mouse", [x, y]);
  }

  async scroll(dx, dy) {
    return this.helper.run("scroll", [dx, dy]);
  }

  async ocrImage(filePath) {
    return this.helper.run("ocr-image", [filePath]);
  }

  async findText(filePath, query) {
    return this.helper.run("find-text", [filePath, query]);
  }

  async runCommand(command, cwd = process.cwd()) {
    const { stdout, stderr } = await execFileAsync("zsh", ["-lc", command], { cwd });
    return { stdout, stderr };
  }
}
