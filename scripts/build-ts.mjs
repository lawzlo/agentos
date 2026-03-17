import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const rootDir = process.cwd();
const distDir = path.join(rootDir, "dist");
const publicSrcDir = path.join(rootDir, "public");
const publicDistDir = path.join(distDir, "public");

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: "inherit",
      shell: process.platform === "win32"
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? 1}`));
    });
    child.on("error", reject);
  });
}

async function copyStaticAssets() {
  await fs.mkdir(publicDistDir, { recursive: true });
  const entries = await fs.readdir(publicSrcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith(".ts")) {
      continue;
    }
    await fs.copyFile(path.join(publicSrcDir, entry.name), path.join(publicDistDir, entry.name));
  }
}

await fs.rm(distDir, { recursive: true, force: true });
await run(process.platform === "win32" ? "npx.cmd" : "npx", ["tsc", "-p", "tsconfig.build.json"]);
await copyStaticAssets();
await fs.chmod(path.join(distDir, "bin", "agentos.js"), 0o755).catch(() => {});
