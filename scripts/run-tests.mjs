import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const rootDir = process.cwd();
const testDir = path.join(rootDir, "dist", "test");

const runnerArgs = process.argv.slice(2);
const hasConcurrencyArg = runnerArgs.some((value) => value.startsWith("--test-concurrency="));
const hasTimeoutArg = runnerArgs.some((value) => value.startsWith("--test-timeout="));
const defaultTimeoutMs = Number.parseInt(process.env.AGENTOS_TEST_TIMEOUT_MS ?? "", 10) || 600000;

const defaultRunnerArgs = [
  ...(!hasConcurrencyArg ? ["--test-concurrency=1"] : []),
  ...(!hasTimeoutArg ? [`--test-timeout=${defaultTimeoutMs}`] : [])
];

const entries = (await fs.readdir(testDir))
  .filter((entry) => entry.endsWith(".test.js"))
  .sort()
  .map((entry) => path.join(testDir, entry));

if (!entries.length) {
  throw new Error(`No compiled tests found in ${testDir}`);
}

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--test", ...defaultRunnerArgs, ...runnerArgs, ...entries], {
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
