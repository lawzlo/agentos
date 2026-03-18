import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createTempDir } from "./helpers.js";

const execFileAsync = promisify(execFile);

test("package-release stages a bundled runtime and records it in install metadata", async () => {
  const tempDir = await createTempDir("agentos-package-release-");
  const releaseDir = path.join(tempDir, "release");
  const runtimeRoot = path.join(tempDir, "runtime");
  const nativeBinaryPath = path.join(tempDir, "agentos-native");
  const packageVersion = JSON.parse(await fs.readFile(path.join(process.cwd(), "package.json"), "utf8")).version;

  await fs.mkdir(path.join(runtimeRoot, "bin"), { recursive: true });
  await fs.mkdir(path.join(runtimeRoot, "lib"), { recursive: true });
  await fs.writeFile(path.join(runtimeRoot, "bin", "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.writeFile(path.join(runtimeRoot, "lib", "marker.txt"), "bundled runtime marker\n", "utf8");
  await fs.writeFile(nativeBinaryPath, "fake native binary\n", { mode: 0o755 });

  try {
    const result = await execFileAsync(
      process.execPath,
      ["scripts/package-release.mjs", "--platform", "darwin", "--skip-build", "--json"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AGENTOS_RELEASE_DIR: releaseDir,
          AGENTOS_BUNDLED_NODE_PATH: runtimeRoot,
          AGENTOS_NATIVE_BINARY_PATH: nativeBinaryPath
        }
      }
    );

    const payload = JSON.parse(result.stdout);
    const manifest = JSON.parse(await fs.readFile(path.join(payload.stageDir, "manifest.json"), "utf8"));
    const installRoot = path.join(releaseDir, "staging", "darwin", "root", "opt", "agentos", packageVersion);
    const metadata = JSON.parse(await fs.readFile(path.join(installRoot, "install-metadata.json"), "utf8"));
    const wrapper = await fs.readFile(path.join(releaseDir, "staging", "darwin", "root", "usr", "local", "bin", "agentos"), "utf8");

    assert.equal(manifest.bundledRuntime, true);
    assert.equal(manifest.runtimeExecutable, `/opt/agentos/${packageVersion}/runtime/bin/node`);
    assert.equal(metadata.bundledRuntime, true);
    assert.equal(metadata.runtimeExecutablePath, `/opt/agentos/${packageVersion}/runtime/bin/node`);
    assert.equal(wrapper.includes(`AGENTOS_RUNTIME="/opt/agentos/${packageVersion}/runtime/bin/node"`), true);
    assert.equal(
      await fs
        .readFile(path.join(installRoot, "runtime", "lib", "marker.txt"), "utf8")
        .then((content) => content.includes("bundled runtime marker")),
      true
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
