import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createTempDir } from "./helpers.js";

const execFileAsync = promisify(execFile);

test("prepare-bundled-node plans official macOS runtime download paths", async () => {
  const releaseDir = await createTempDir("agentos-runtime-plan-");

  const result = await execFileAsync(
    process.execPath,
    [
      "scripts/prepare-bundled-node.mjs",
      "--platform",
      "darwin",
      "--arch",
      "arm64",
      "--version",
      "22.18.0",
      "--release-dir",
      releaseDir,
      "--plan-only",
      "--json"
    ],
    {
      cwd: process.cwd()
    }
  );

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.archiveName, "node-v22.18.0-darwin-arm64.tar.gz");
  assert.equal(payload.downloadUrl, "https://nodejs.org/dist/v22.18.0/node-v22.18.0-darwin-arm64.tar.gz");
  assert.equal(payload.checksumUrl, "https://nodejs.org/dist/v22.18.0/SHASUMS256.txt");
  assert.equal(payload.runtimeRoot, path.join(releaseDir, "bundled-runtime", "darwin-arm64", "node-v22.18.0", "runtime", "node-v22.18.0-darwin-arm64"));
  assert.equal(payload.executablePath, path.join(payload.runtimeRoot, "bin", "node"));
});

test("prepare-bundled-node plans official Windows runtime download paths", async () => {
  const releaseDir = await createTempDir("agentos-runtime-plan-");

  const result = await execFileAsync(
    process.execPath,
    [
      "scripts/prepare-bundled-node.mjs",
      "--platform",
      "win32",
      "--arch",
      "x64",
      "--version",
      "22.18.0",
      "--release-dir",
      releaseDir,
      "--plan-only",
      "--json"
    ],
    {
      cwd: process.cwd()
    }
  );

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.archiveName, "node-v22.18.0-win-x64.zip");
  assert.equal(payload.downloadUrl, "https://nodejs.org/dist/v22.18.0/node-v22.18.0-win-x64.zip");
  assert.equal(payload.checksumUrl, "https://nodejs.org/dist/v22.18.0/SHASUMS256.txt");
  assert.equal(payload.runtimeRoot, path.join(releaseDir, "bundled-runtime", "win32-x64", "node-v22.18.0", "runtime", "node-v22.18.0-win-x64"));
  assert.equal(payload.executablePath, path.join(payload.runtimeRoot, "node.exe"));
});
