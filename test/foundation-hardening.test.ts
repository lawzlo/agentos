import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { rotateDaemonLogs } from "../src/daemon-state.js";
import { ControlPlaneStore } from "../src/runtime/store.js";
import { getRuntimeVersionInfo } from "../src/version.js";
import { createTempDir, startAgentServer } from "./helpers.js";

const execFileAsync = promisify(execFile);

test("store schema version matches the runtime contract", async () => {
  const dataDir = await createTempDir();
  const store = new ControlPlaneStore(path.join(dataDir, "agentos.sqlite"));

  try {
    assert.equal(store.getSchemaVersion(), getRuntimeVersionInfo().storeSchemaVersion);
  } finally {
    store.close();
  }
});

test("doctor bundle and version endpoints expose hardening metadata", async () => {
  const dataDir = await createTempDir();
  const server = await startAgentServer({ dataDir });

  try {
    const versionPayload = await (await fetch(`${server.baseUrl}/version`)).json();
    assert.equal(versionPayload.version.appVersion, getRuntimeVersionInfo().appVersion);
    assert.equal(
      versionPayload.version.runtimeProtocolVersion,
      getRuntimeVersionInfo().runtimeProtocolVersion
    );

    const doctorPayload = await (await fetch(`${server.baseUrl}/doctor`)).json();
    assert.equal(typeof doctorPayload.doctor.store.schemaVersion, "number");
    assert.equal(typeof doctorPayload.doctor.version.appVersion, "string");
    assert.equal(typeof doctorPayload.doctor.native.compatible, "boolean");

    const bundlePayload = await (
      await fetch(`${server.baseUrl}/doctor/bundle`, { method: "POST" })
    ).json();
    assert.equal(path.basename(path.dirname(bundlePayload.bundle.bundlePath)), "bundles");
    const doctorBundle = JSON.parse(
      await fs.readFile(path.join(bundlePayload.bundle.bundlePath, "doctor.json"), "utf8")
    );
    assert.equal(doctorBundle.doctor.version.appVersion, getRuntimeVersionInfo().appVersion);
  } finally {
    await server.close();
  }
});

test("daemon logs rotate when they exceed the configured size", async () => {
  const dataDir = await createTempDir();
  const daemonDir = path.join(dataDir, "daemon");
  const logPath = path.join(daemonDir, "daemon.log");
  await fs.mkdir(daemonDir, { recursive: true });
  await fs.writeFile(logPath, "x".repeat(256), "utf8");
  await fs.writeFile(`${logPath}.1`, "older", "utf8");

  await rotateDaemonLogs(daemonDir, {
    maxBytes: 64,
    backups: 2
  });

  const rotated = await fs.readFile(`${logPath}.1`, "utf8");
  const older = await fs.readFile(`${logPath}.2`, "utf8");
  assert.equal(rotated.length, 256);
  assert.equal(older, "older");
});

test("cli version and doctor bundle commands use the daemon API", async () => {
  const dataDir = await createTempDir();
  const server = await startAgentServer({ dataDir });

  try {
    const env = {
      ...process.env,
      AGENTOS_BASE_URL: server.baseUrl,
      AGENTOS_DATA_DIR: dataDir
    };

    const versionResult = await execFileAsync(
      process.execPath,
      ["dist/bin/agentos.js", "version", "--json"],
      {
        cwd: process.cwd(),
        env
      }
    );
    const version = JSON.parse(versionResult.stdout);
    assert.equal(version.appVersion, getRuntimeVersionInfo().appVersion);

    const bundleResult = await execFileAsync(
      process.execPath,
      ["dist/bin/agentos.js", "doctor", "--bundle", "--json"],
      {
        cwd: process.cwd(),
        env
      }
    );
    const bundle = JSON.parse(bundleResult.stdout);
    assert.equal(typeof bundle.bundlePath, "string");
    await fs.access(path.join(bundle.bundlePath, "doctor.json"));
  } finally {
    await server.close();
  }
});
