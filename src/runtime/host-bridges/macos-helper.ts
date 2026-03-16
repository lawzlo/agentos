import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface MacOSHelperOptions {
  dataDir: string;
  helperExecutable?: string | null;
  sourcePath: string;
}

export class MacOSHelper {
  dataDir: string;
  helperExecutable: string | null | undefined;
  sourcePath: string;
  buildPromise: Promise<string> | null;

  constructor({ dataDir, helperExecutable, sourcePath }: MacOSHelperOptions) {
    this.dataDir = dataDir;
    this.helperExecutable = helperExecutable;
    this.sourcePath = sourcePath;
    this.buildPromise = null;
  }

  async ensureBuilt(): Promise<string> {
    if (process.platform !== "darwin") {
      throw new Error("macOS helper can only be built on macOS hosts.");
    }

    if (this.helperExecutable) {
      return this.helperExecutable;
    }

    if (this.buildPromise) {
      return this.buildPromise;
    }

    this.buildPromise = (async () => {
      const binDir = path.join(this.dataDir, "bin");
      const helperPath = path.join(binDir, "agentos-macos-helper");
      await fs.mkdir(binDir, { recursive: true });

      try {
        const [helperStats, sourceStats] = await Promise.all([
          fs.stat(helperPath),
          fs.stat(this.sourcePath)
        ]);
        if (helperStats.mtimeMs >= sourceStats.mtimeMs) {
          this.helperExecutable = helperPath;
          return helperPath;
        }
      } catch {
      }

      await execFileAsync("swiftc", [
        this.sourcePath,
        "-framework",
        "AppKit",
        "-framework",
        "ApplicationServices",
        "-framework",
        "Vision",
        "-o",
        helperPath
      ]);
      this.helperExecutable = helperPath;
      return helperPath;
    })();

    return this.buildPromise;
  }

  async run(command: string, args: Array<string | number> = []): Promise<unknown> {
    const executable = await this.ensureBuilt();
    const { stdout } = await execFileAsync(executable, [command, ...args.map(String)]);
    return JSON.parse(stdout) as unknown;
  }
}
