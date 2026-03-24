import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { createId } from "./id.js";
import { defaultDataDir } from "../config.js";
import type { SidecarResponse } from "../types/native-sidecar.js";

const execFileAsync = promisify(execFile);

interface PendingRequest<TResult = unknown> {
  resolve: (value: TResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface NativeSidecarClientOptions {
  dataDir?: string;
  executablePath?: string | null;
  args?: string[];
  manifestPath?: string;
}

export class NativeSidecarClient {
  dataDir: string;
  executablePath: string | null;
  args: string[];
  manifestPath: string;
  child: ChildProcessWithoutNullStreams | null;
  readline: readline.Interface | null;
  pending: Map<string, PendingRequest>;
  startPromise: Promise<ChildProcessWithoutNullStreams> | null;
  resolveExecutablePromise:
    | Promise<{ command: string; args: string[] }>
    | null;
  disabled: boolean;
  unavailableReason: string | null;
  stderr: string;

  constructor({
    dataDir,
    executablePath = process.env.AGENTOS_NATIVE_SIDECAR,
    args = [],
    manifestPath = path.join(process.cwd(), "rust", "agentos-native", "Cargo.toml")
  }: NativeSidecarClientOptions = {}) {
    this.dataDir = dataDir ?? defaultDataDir();
    this.executablePath = executablePath ?? null;
    this.args = args;
    this.manifestPath = manifestPath;
    this.child = null;
    this.readline = null;
    this.pending = new Map();
    this.startPromise = null;
    this.resolveExecutablePromise = null;
    this.disabled = process.env.AGENTOS_DISABLE_RUST_SIDECAR === "true";
    this.unavailableReason = null;
    this.stderr = "";
  }

  #rejectAllPending(message: string) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error(message));
    }
    this.pending.clear();
  }

  async isAvailable(): Promise<boolean> {
    if (this.disabled) {
      return false;
    }

    try {
      return Boolean(await this.#resolveExecutable());
    } catch (error) {
      this.unavailableReason =
        error instanceof Error ? error.message : String(error);
      this.disabled = true;
      return false;
    }
  }

  async #resolveExecutable(): Promise<{ command: string; args: string[] }> {
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
      const cachedBinary = path.join(
        this.dataDir,
        "bin",
        `agentos-native${extension}`
      );
      const manifestDir = path.dirname(this.manifestPath);
      const targetBinary = path.join(
        manifestDir,
        "target",
        "release",
        `agentos-native${extension}`
      );

      try {
        await fs.access(targetBinary);
        return { command: targetBinary, args: [] };
      } catch {
      }

      try {
        await fs.access(targetBinary);
      } catch {
        await fs.mkdir(path.dirname(cachedBinary), { recursive: true });
        await execFileAsync("cargo", [
          "build",
          "--manifest-path",
          this.manifestPath,
          "--release"
        ]);
      }

      try {
        await fs.access(targetBinary);
        return { command: targetBinary, args: [] };
      } catch {
      }

      await fs.mkdir(path.dirname(cachedBinary), { recursive: true });
      await fs.copyFile(targetBinary, cachedBinary);
      await fs.chmod(cachedBinary, 0o755).catch(() => {});
      return { command: cachedBinary, args: [] };
    })();

    return this.resolveExecutablePromise;
  }

  async #ensureStarted(): Promise<ChildProcessWithoutNullStreams> {
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
          AGENTOS_DATA_DIR: this.dataDir
        },
        stdio: ["pipe", "pipe", "pipe"]
      });

      child.stderr.on("data", (chunk: Buffer | string) => {
        this.stderr += chunk.toString();
      });
      child.stdin.on("error", (error: Error) => {
        this.#rejectAllPending(
          `Rust sidecar stdin closed unexpectedly.${error?.message ? ` ${error.message}` : ""}`
        );
        this.child = null;
        this.readline?.close();
        this.readline = null;
      });
      child.on("exit", () => {
        this.#rejectAllPending(
          `Rust sidecar exited unexpectedly.${this.stderr ? ` ${this.stderr.trim()}` : ""}`
        );
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

        let payload: SidecarResponse<unknown>;
        try {
          payload = JSON.parse(line) as SidecarResponse<unknown>;
        } catch {
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

        pending.reject(
          new Error(("error" in payload ? payload.error : null) ?? "Rust sidecar request failed.")
        );
      });

      this.child = child;
      this.readline = rl;
      return child;
    })();

    return this.startPromise.finally(() => {
      this.startPromise = null;
    });
  }

  async request<TResult = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    { timeoutMs = 15000 }: { timeoutMs?: number } = {}
  ): Promise<TResult> {
    if (!(await this.isAvailable())) {
      throw new Error(this.unavailableReason ?? "Rust sidecar is not available.");
    }

    const child = await this.#ensureStarted();
    const id = createId("sidecar");

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Rust sidecar timed out for ${method}.`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
        timer
      });
      try {
        child.stdin.write(
          `${JSON.stringify({
            id,
            method,
            params
          })}\n`,
          (error) => {
            if (!error) {
              return;
            }
            clearTimeout(timer);
            this.pending.delete(id);
            reject(
              new Error(
                `Rust sidecar write failed for ${method}.${error.message ? ` ${error.message}` : ""}`
              )
            );
          }
        );
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new Error(
            `Rust sidecar write failed for ${method}.${error instanceof Error && error.message ? ` ${error.message}` : ""}`
          )
        );
      }
    });
  }

  async shutdown(): Promise<void> {
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
