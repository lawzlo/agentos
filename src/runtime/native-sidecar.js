import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createId } from "./id.js";
const execFileAsync = promisify(execFile);
export class NativeSidecarClient {
    dataDir;
    executablePath;
    args;
    manifestPath;
    helperExecutable;
    helperSourcePath;
    child;
    readline;
    pending;
    startPromise;
    resolveExecutablePromise;
    disabled;
    unavailableReason;
    stderr;
    constructor({ dataDir, executablePath = process.env.AGENTOS_NATIVE_SIDECAR, args = [], manifestPath = path.join(process.cwd(), "rust", "agentos-native", "Cargo.toml"), helperExecutable = null, helperSourcePath = null } = {}) {
        this.dataDir = dataDir ?? path.join(process.cwd(), ".agentos");
        this.executablePath = executablePath ?? null;
        this.args = args;
        this.manifestPath = manifestPath;
        this.helperExecutable = helperExecutable;
        this.helperSourcePath = helperSourcePath;
        this.child = null;
        this.readline = null;
        this.pending = new Map();
        this.startPromise = null;
        this.resolveExecutablePromise = null;
        this.disabled = process.env.AGENTOS_DISABLE_RUST_SIDECAR === "true";
        this.unavailableReason = null;
        this.stderr = "";
    }
    async isAvailable() {
        if (this.disabled) {
            return false;
        }
        try {
            return Boolean(await this.#resolveExecutable());
        }
        catch (error) {
            this.unavailableReason =
                error instanceof Error ? error.message : String(error);
            this.disabled = true;
            return false;
        }
    }
    async #resolveExecutable() {
        if (this.disabled) {
            throw new Error(this.unavailableReason ?? "Rust sidecar is disabled.");
        }
        if (this.resolveExecutablePromise) {
            return this.resolveExecutablePromise;
        }
        this.resolveExecutablePromise = (async () => {
            if (this.executablePath) {
                return {
                    command: this.executablePath,
                    args: this.args
                };
            }
            const extension = process.platform === "win32" ? ".exe" : "";
            const cachedBinary = path.join(this.dataDir, "bin", `agentos-native${extension}`);
            const manifestDir = path.dirname(this.manifestPath);
            const targetBinary = path.join(manifestDir, "target", "release", `agentos-native${extension}`);
            try {
                const [cachedStats, targetStats] = await Promise.all([
                    fs.stat(cachedBinary),
                    fs.stat(targetBinary)
                ]);
                if (cachedStats.mtimeMs >= targetStats.mtimeMs) {
                    return { command: cachedBinary, args: [] };
                }
            }
            catch {
            }
            try {
                await fs.access(targetBinary);
            }
            catch {
                await fs.mkdir(path.dirname(cachedBinary), { recursive: true });
                await execFileAsync("cargo", [
                    "build",
                    "--manifest-path",
                    this.manifestPath,
                    "--release"
                ]);
            }
            await fs.mkdir(path.dirname(cachedBinary), { recursive: true });
            await fs.copyFile(targetBinary, cachedBinary);
            await fs.chmod(cachedBinary, 0o755).catch(() => { });
            return { command: cachedBinary, args: [] };
        })();
        return this.resolveExecutablePromise;
    }
    async #ensureStarted() {
        if (this.child && !this.child.killed) {
            return this.child;
        }
        if (this.startPromise) {
            return this.startPromise;
        }
        this.startPromise = (async () => {
            const executable = await this.#resolveExecutable();
            const child = spawn(executable.command, executable.args, {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    AGENTOS_DATA_DIR: this.dataDir,
                    ...(this.helperExecutable
                        ? { AGENTOS_MAC_HELPER_EXECUTABLE: this.helperExecutable }
                        : {}),
                    ...(this.helperSourcePath
                        ? { AGENTOS_MAC_HELPER_SOURCE: this.helperSourcePath }
                        : {})
                },
                stdio: ["pipe", "pipe", "pipe"]
            });
            child.stderr.on("data", (chunk) => {
                this.stderr += chunk.toString();
            });
            child.on("exit", () => {
                for (const { reject, timer } of this.pending.values()) {
                    clearTimeout(timer);
                    reject(new Error(`Rust sidecar exited unexpectedly.${this.stderr ? ` ${this.stderr.trim()}` : ""}`));
                }
                this.pending.clear();
                this.child = null;
                this.readline?.close();
                this.readline = null;
            });
            const rl = readline.createInterface({
                input: child.stdout
            });
            rl.on("line", (line) => {
                if (!line.trim()) {
                    return;
                }
                let payload;
                try {
                    payload = JSON.parse(line);
                }
                catch {
                    return;
                }
                const pending = this.pending.get(payload.id);
                if (!pending) {
                    return;
                }
                clearTimeout(pending.timer);
                this.pending.delete(payload.id);
                if (payload.ok) {
                    pending.resolve(payload.result);
                    return;
                }
                pending.reject(new Error(payload.error ?? "Rust sidecar request failed."));
            });
            this.child = child;
            this.readline = rl;
            return child;
        })();
        return this.startPromise.finally(() => {
            this.startPromise = null;
        });
    }
    async request(method, params = {}, { timeoutMs = 15000 } = {}) {
        if (!(await this.isAvailable())) {
            throw new Error(this.unavailableReason ?? "Rust sidecar is not available.");
        }
        const child = await this.#ensureStarted();
        const id = createId("sidecar");
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Rust sidecar timed out for ${method}.`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (value) => resolve(value),
                reject,
                timer
            });
            child.stdin.write(`${JSON.stringify({
                id,
                method,
                params
            })}\n`);
        });
    }
    async shutdown() {
        if (this.readline) {
            this.readline.close();
            this.readline = null;
        }
        if (this.child && !this.child.killed) {
            this.child.kill("SIGTERM");
            this.child = null;
        }
        for (const { reject, timer } of this.pending.values()) {
            clearTimeout(timer);
            reject(new Error("Rust sidecar has been shut down."));
        }
        this.pending.clear();
    }
}
