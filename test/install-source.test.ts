import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { createTempDir } from "./helpers.js";
import { detectInstallSource } from "../src/install-source.js";

test("detectInstallSource reads bundled runtime metadata from a managed installation", async () => {
  const tempDir = await createTempDir("agentos-install-source-");
  const installRoot = path.join(tempDir, "AgentOS", "0.1.0");
  const distRoot = path.join(installRoot, "dist");
  await fs.mkdir(distRoot, { recursive: true });
  await fs.writeFile(
    path.join(installRoot, "install-metadata.json"),
    JSON.stringify(
      {
        source: "macos_pkg",
        installRoot: "/opt/agentos/0.1.0",
        wrapperPath: "/usr/local/bin/agentos",
        buildChannel: "stable",
        licenseEnforced: true,
        bundledRuntime: true,
        runtimeExecutablePath: "/opt/agentos/0.1.0/runtime/bin/node"
      },
      null,
      2
    ),
    "utf8"
  );

  try {
    const installSource = await detectInstallSource({ distRoot });
    assert.equal(installSource.source, "macos_pkg");
    assert.equal(installSource.managedInstallation, true);
    assert.equal(installSource.bundledRuntime, true);
    assert.equal(installSource.runtimeExecutablePath, "/opt/agentos/0.1.0/runtime/bin/node");
    assert.equal(installSource.buildChannel, "stable");
    assert.equal(installSource.licenseEnforced, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("detectInstallSource falls back to source mode when install metadata is missing", async () => {
  const tempDir = await createTempDir("agentos-install-source-");
  const distRoot = path.join(tempDir, "dist");
  await fs.mkdir(distRoot, { recursive: true });

  try {
    const installSource = await detectInstallSource({ distRoot });
    assert.equal(installSource.source, "source");
    assert.equal(installSource.managedInstallation, false);
    assert.equal(installSource.bundledRuntime, false);
    assert.equal(installSource.runtimeExecutablePath, process.execPath);
    assert.equal(installSource.buildChannel, "source");
    assert.equal(installSource.licenseEnforced, false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
