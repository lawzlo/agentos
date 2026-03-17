import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const rootDir = process.cwd();
const testDir = path.join(rootDir, "dist", "test");

const entries = (await fs.readdir(testDir))
  .filter((entry) => entry.endsWith(".test.js"))
  .sort()
  .map((entry) => path.join(testDir, entry));

if (!entries.length) {
  throw new Error(`No compiled tests found in ${testDir}`);
}

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--test", ...entries], {
    cwd: rootDir,
    stdio: "inherit"
  });

  child.on("exit", (code) => {
    if (code === 0) {
      resolve();
      return;
    }
    reject(new Error(`node --test exited with code ${code ?? 1}`));
  });
  child.on("error", reject);
});
