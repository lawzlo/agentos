import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MacOSHelper } from "./macos-helper.js";
import { NativeSidecarClient } from "../native-sidecar.js";
const execFileAsync = promisify(execFile);
function escapeAppleScript(text) {
    return String(text).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}
export class MacOSHostBridge {
    helper;
    sidecar;
    constructor(options = {}) {
        const helperExecutable = options.helperExecutable ?? process.env.AGENTOS_MAC_HELPER_EXECUTABLE;
        const sourcePath = options.sourcePath ??
            path.join(process.cwd(), "native", "macos", "AgentOSHelper.swift");
        const dataDir = options.dataDir ?? path.join(process.cwd(), ".agentos");
        this.helper = new MacOSHelper({
            dataDir,
            helperExecutable,
            sourcePath
        });
        this.sidecar = new NativeSidecarClient({
            dataDir,
            helperExecutable,
            helperSourcePath: sourcePath
        });
    }
    async captureScreen(filePath) {
        return this.#requestSidecar("capture_screen", { filePath }, () => this.helper.run("capture-screen", [filePath]));
    }
    async launchApp(name) {
        return this.#requestSidecar("launch_app", { name }, async () => {
            await execFileAsync("open", ["-a", name]);
            return { launched: name };
        });
    }
    async focusApp(name) {
        return this.#requestSidecar("focus_app", { name }, async () => {
            await execFileAsync("osascript", [
                "-e",
                `tell application "${escapeAppleScript(name)}" to activate`
            ]);
            return { focused: name };
        });
    }
    async getFrontmostApp() {
        return this.#requestSidecar("frontmost_app", {}, () => this.helper.run("frontmost-app"));
    }
    async getPermissionsStatus() {
        await this.helper.ensureBuilt();
        return this.#requestSidecar("permissions_status", {}, () => this.helper.run("permissions-status"));
    }
    async listWindows() {
        await this.helper.ensureBuilt();
        return this.#requestSidecar("list_windows", {}, () => this.helper.run("list-windows"));
    }
    async typeText(text) {
        return this.#requestSidecar("type_text", { text }, () => this.helper.run("type-text", [text]));
    }
    async pressKey(key, modifiers = []) {
        return this.#requestSidecar("key_press", { key, modifiers }, () => this.helper.run("key-press", [key, modifiers.join(",")]));
    }
    async clickAt(x, y) {
        return this.#requestSidecar("click_at", { x, y }, () => this.helper.run("click-at", [x, y]));
    }
    async moveMouse(x, y) {
        return this.#requestSidecar("move_mouse", { x, y }, () => this.helper.run("move-mouse", [x, y]));
    }
    async scroll(dx, dy) {
        return this.#requestSidecar("scroll", { dx, dy }, () => this.helper.run("scroll", [dx, dy]));
    }
    async ocrImage(filePath) {
        await this.helper.ensureBuilt();
        return this.#requestSidecar("ocr_image", { filePath }, () => this.helper.run("ocr-image", [filePath]));
    }
    async findText(filePath, query) {
        await this.helper.ensureBuilt();
        return this.#requestSidecar("find_text", { filePath, query }, () => this.helper.run("find-text", [filePath, query]));
    }
    async sidecarHealth() {
        return this.sidecar.request("health", {});
    }
    async runCommand(command, cwd = process.cwd()) {
        const { stdout, stderr } = await execFileAsync("zsh", ["-lc", command], {
            cwd
        });
        return { stdout, stderr };
    }
    async shutdown() {
        await this.sidecar.shutdown();
    }
    async #requestSidecar(method, params, fallback) {
        if (await this.sidecar.isAvailable()) {
            try {
                return await this.sidecar.request(method, params);
            }
            catch {
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
