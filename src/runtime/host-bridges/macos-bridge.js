import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NativeSidecarClient } from "../native-sidecar.js";
const execFileAsync = promisify(execFile);
function escapeAppleScript(text) {
    return String(text).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}
export class MacOSHostBridge {
    sidecar;
    constructor(options = {}) {
        const dataDir = options.dataDir ?? path.join(process.cwd(), ".agentos");
        this.sidecar = new NativeSidecarClient({
            dataDir,
            executablePath: options.sidecarExecutablePath ?? process.env.AGENTOS_NATIVE_SIDECAR,
            args: options.sidecarArgs ?? []
        });
    }
    async captureScreen(filePath) {
        return this.#requestSidecar("capture_screen", { filePath }, async () => {
            await execFileAsync("screencapture", ["-x", filePath]);
            return { filePath };
        });
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
        return this.#requestSidecar("frontmost_app", {}, async () => {
            const { stdout } = await execFileAsync("osascript", [
                "-e",
                'tell application "System Events" to get name of first application process whose frontmost is true'
            ]);
            return { appName: stdout.trim() };
        });
    }
    async getPermissionsStatus() {
        return this.#requestSidecar("permissions_status", {}, null);
    }
    async listWindows() {
        return this.#requestSidecar("list_windows", {}, null);
    }
    async typeText(text) {
        return this.#requestSidecar("type_text", { text }, null);
    }
    async pressKey(key, modifiers = []) {
        return this.#requestSidecar("key_press", { key, modifiers }, null);
    }
    async clickAt(x, y) {
        return this.#requestSidecar("click_at", { x, y }, null);
    }
    async moveMouse(x, y) {
        return this.#requestSidecar("move_mouse", { x, y }, null);
    }
    async scroll(dx, dy) {
        return this.#requestSidecar("scroll", { dx, dy }, null);
    }
    async ocrImage(filePath) {
        return this.#requestSidecar("ocr_image", { filePath }, null);
    }
    async findText(filePath, query) {
        return this.#requestSidecar("find_text", { filePath, query }, null);
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
