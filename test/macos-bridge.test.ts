import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { createTempDir } from "./helpers.js";
import { MacOSHostBridge } from "../src/runtime/host-bridges/macos-bridge.js";

const isMac = process.platform === "darwin";
test("macOS host bridge delegates desktop methods to the sidecar", { skip: !isMac }, async () => {
  const tempDir = await createTempDir("agentos-bridge-");
  const sidecarPath = path.join(tempDir, "fake-sidecar.mjs");
  const previousSidecar = process.env.AGENTOS_NATIVE_SIDECAR;
  const previousDisable = process.env.AGENTOS_DISABLE_RUST_SIDECAR;

  await fs.writeFile(
    sidecarPath,
    `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  const result = {
    frontmost_app: { appName: "Finder", bundleIdentifier: "com.apple.finder" },
    capture_screen: { ok: true, filePath: request.params.filePath, width: 1440, height: 900 },
    permissions_status: { accessibility: true, screenRecording: true },
    list_windows: { windows: [{ ownerName: "Finder", windowName: "Desktop", ownerPID: 1, windowNumber: 7, layer: 0, alpha: 1, bounds: { x: 0, y: 0, width: 1440, height: 900, centerX: 720, centerY: 450 } }] },
    accessibility_snapshot: { appName: "Finder", windows: [{ title: "Desktop", bounds: { x: 0, y: 0, width: 1440, height: 900, centerX: 720, centerY: 450 } }], elements: [{ id: "ax-1", role: "AXButton", title: "Desktop", actions: ["AXPress"], bounds: { x: 10, y: 10, width: 50, height: 20, centerX: 35, centerY: 20 } }] },
    click_at: { ok: true, x: request.params.x, y: request.params.y }
  }[request.method] ?? { ok: true };
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + "\\n");
});
`,
    "utf8"
  );
  await fs.chmod(sidecarPath, 0o755);

  process.env.AGENTOS_NATIVE_SIDECAR = sidecarPath;
  delete process.env.AGENTOS_DISABLE_RUST_SIDECAR;

  try {
    const bridge = new MacOSHostBridge({
      dataDir: tempDir
    });

    const frontmost = await bridge.getFrontmostApp() as Record<string, any>;
    assert.equal(frontmost.appName, "Finder");

    const capture = await bridge.captureScreen(path.join(tempDir, "screen.png")) as Record<string, any>;
    assert.equal(capture.ok, true);

    const permissions = await bridge.getPermissionsStatus();
    assert.equal(permissions.accessibility, true);

    const windows = await bridge.listWindows();
    assert.equal(windows.windows[0].ownerName, "Finder");

    const accessibility = await bridge.getAccessibilitySnapshot("Finder");
    assert.equal(accessibility.appName, "Finder");
    assert.equal(accessibility.elements[0].role, "AXButton");

    const click = await bridge.clickAt(120, 240) as Record<string, any>;
    assert.equal(click.ok, true);
    await bridge.shutdown();
  } finally {
    if (previousSidecar === undefined) {
      delete process.env.AGENTOS_NATIVE_SIDECAR;
    } else {
      process.env.AGENTOS_NATIVE_SIDECAR = previousSidecar;
    }
    if (previousDisable === undefined) {
      delete process.env.AGENTOS_DISABLE_RUST_SIDECAR;
    } else {
      process.env.AGENTOS_DISABLE_RUST_SIDECAR = previousDisable;
    }
  }
});

test("macOS host bridge can prefer a sidecar for helper-backed desktop methods", async () => {
  const tempDir = await createTempDir("agentos-sidecar-");
  const sidecarPath = path.join(tempDir, "fake-sidecar.mjs");
  const previousSidecar = process.env.AGENTOS_NATIVE_SIDECAR;
  const previousDisable = process.env.AGENTOS_DISABLE_RUST_SIDECAR;

  await fs.writeFile(
    sidecarPath,
    `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  const results = {
    frontmost_app: { appName: "SidecarApp", bundleIdentifier: "dev.agentos.sidecar" },
    permissions_status: { accessibility: true, screenRecording: false },
    list_windows: { windows: [{ ownerName: "SidecarApp", windowName: "Inbox", ownerPID: 99, windowNumber: 1, layer: 0, alpha: 1, bounds: { x: 1, y: 2, width: 3, height: 4, centerX: 2.5, centerY: 4 } }] },
    accessibility_snapshot: { appName: "SidecarApp", windows: [{ title: "Inbox", bounds: { x: 1, y: 2, width: 3, height: 4, centerX: 2.5, centerY: 4 } }], elements: [{ id: "ax-compose", role: "AXTextArea", description: "Message", actions: ["AXPress"], bounds: { x: 10, y: 20, width: 100, height: 30, centerX: 60, centerY: 35 } }] }
  };
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: results[request.method] ?? { ok: true } }) + "\\n");
});`,
    "utf8"
  );
  await fs.chmod(sidecarPath, 0o755);

  process.env.AGENTOS_NATIVE_SIDECAR = sidecarPath;
  delete process.env.AGENTOS_DISABLE_RUST_SIDECAR;

  try {
    const bridge = new MacOSHostBridge({
      dataDir: tempDir
    });

    const frontmost = await bridge.getFrontmostApp() as Record<string, any>;
    assert.equal(frontmost.appName, "SidecarApp");

    const permissions = await bridge.getPermissionsStatus();
    assert.equal(permissions.screenRecording, false);

    const windows = await bridge.listWindows();
    assert.equal(windows.windows[0].windowName, "Inbox");

    const accessibility = await bridge.getAccessibilitySnapshot("SidecarApp");
    assert.equal(accessibility.windows[0].title, "Inbox");
    assert.equal(accessibility.elements[0].description, "Message");

    await bridge.shutdown();
  } finally {
    if (previousSidecar === undefined) {
      delete process.env.AGENTOS_NATIVE_SIDECAR;
    } else {
      process.env.AGENTOS_NATIVE_SIDECAR = previousSidecar;
    }
    if (previousDisable === undefined) {
      delete process.env.AGENTOS_DISABLE_RUST_SIDECAR;
    } else {
      process.env.AGENTOS_DISABLE_RUST_SIDECAR = previousDisable;
    }
  }
});

test("macOS host bridge falls back and resets the sidecar after a frontmost timeout", { skip: !isMac }, async () => {
  const tempDir = await createTempDir("agentos-sidecar-timeout-");
  const sidecarPath = path.join(tempDir, "hanging-sidecar.mjs");
  const previousSidecar = process.env.AGENTOS_NATIVE_SIDECAR;
  const previousDisable = process.env.AGENTOS_DISABLE_RUST_SIDECAR;

  await fs.writeFile(
    sidecarPath,
    `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "frontmost_app") {
    return;
  }
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { ok: true } }) + "\\n");
});`,
    "utf8"
  );
  await fs.chmod(sidecarPath, 0o755);

  process.env.AGENTOS_NATIVE_SIDECAR = sidecarPath;
  delete process.env.AGENTOS_DISABLE_RUST_SIDECAR;

  try {
    const bridge = new MacOSHostBridge({
      dataDir: tempDir
    });
    const frontmost = await bridge.getFrontmostApp() as Record<string, unknown>;
    assert.equal(typeof frontmost.appName, "string");
    assert.notEqual(String(frontmost.appName ?? "").trim(), "");
    await bridge.shutdown();
  } finally {
    if (previousSidecar === undefined) {
      delete process.env.AGENTOS_NATIVE_SIDECAR;
    } else {
      process.env.AGENTOS_NATIVE_SIDECAR = previousSidecar;
    }
    if (previousDisable === undefined) {
      delete process.env.AGENTOS_DISABLE_RUST_SIDECAR;
    } else {
      process.env.AGENTOS_DISABLE_RUST_SIDECAR = previousDisable;
    }
  }
});

test("macOS host bridge falls back when the sidecar returns an empty frontmost app", { skip: !isMac }, async () => {
  const tempDir = await createTempDir("agentos-sidecar-empty-frontmost-");
  const sidecarPath = path.join(tempDir, "empty-frontmost-sidecar.mjs");
  const previousSidecar = process.env.AGENTOS_NATIVE_SIDECAR;
  const previousDisable = process.env.AGENTOS_DISABLE_RUST_SIDECAR;

  await fs.writeFile(
    sidecarPath,
    `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "frontmost_app") {
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { appName: "", bundleIdentifier: "" } }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { ok: true } }) + "\\n");
});`,
    "utf8"
  );
  await fs.chmod(sidecarPath, 0o755);

  process.env.AGENTOS_NATIVE_SIDECAR = sidecarPath;
  delete process.env.AGENTOS_DISABLE_RUST_SIDECAR;

  try {
    const bridge = new MacOSHostBridge({
      dataDir: tempDir
    });
    const frontmost = await bridge.getFrontmostApp() as Record<string, unknown>;
    assert.equal(typeof frontmost.appName, "string");
    assert.notEqual(String(frontmost.appName ?? "").trim(), "");
    await bridge.shutdown();
  } finally {
    if (previousSidecar === undefined) {
      delete process.env.AGENTOS_NATIVE_SIDECAR;
    } else {
      process.env.AGENTOS_NATIVE_SIDECAR = previousSidecar;
    }
    if (previousDisable === undefined) {
      delete process.env.AGENTOS_DISABLE_RUST_SIDECAR;
    } else {
      process.env.AGENTOS_DISABLE_RUST_SIDECAR = previousDisable;
    }
  }
});

test("macOS host bridge falls back to the first window owner when the sidecar reports loginwindow", { skip: !isMac }, async () => {
  const tempDir = await createTempDir("agentos-sidecar-loginwindow-frontmost-");
  const sidecarPath = path.join(tempDir, "loginwindow-frontmost-sidecar.mjs");
  const previousSidecar = process.env.AGENTOS_NATIVE_SIDECAR;
  const previousDisable = process.env.AGENTOS_DISABLE_RUST_SIDECAR;

  await fs.writeFile(
    sidecarPath,
    `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "frontmost_app") {
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { appName: "loginwindow", bundleIdentifier: "com.apple.loginwindow" } }) + "\\n");
    return;
  }
  if (request.method === "list_windows") {
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { windows: [{ ownerName: "Microsoft Outlook", windowName: "Inbox", ownerPID: 99, windowNumber: 1, layer: 0, alpha: 1, bounds: { x: 1, y: 2, width: 3, height: 4, centerX: 2.5, centerY: 4 } }] } }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { ok: true } }) + "\\n");
});`,
    "utf8"
  );
  await fs.chmod(sidecarPath, 0o755);

  process.env.AGENTOS_NATIVE_SIDECAR = sidecarPath;
  delete process.env.AGENTOS_DISABLE_RUST_SIDECAR;

  try {
    const bridge = new MacOSHostBridge({
      dataDir: tempDir
    });
    const frontmost = await bridge.getFrontmostApp() as Record<string, unknown>;
    assert.equal(frontmost.appName, "Microsoft Outlook");
    await bridge.shutdown();
  } finally {
    if (previousSidecar === undefined) {
      delete process.env.AGENTOS_NATIVE_SIDECAR;
    } else {
      process.env.AGENTOS_NATIVE_SIDECAR = previousSidecar;
    }
    if (previousDisable === undefined) {
      delete process.env.AGENTOS_DISABLE_RUST_SIDECAR;
    } else {
      process.env.AGENTOS_DISABLE_RUST_SIDECAR = previousDisable;
    }
  }
});

test("macOS host bridge falls back when the sidecar returns no windows", { skip: !isMac }, async () => {
  const tempDir = await createTempDir("agentos-sidecar-empty-windows-");
  const sidecarPath = path.join(tempDir, "empty-windows-sidecar.mjs");
  const previousSidecar = process.env.AGENTOS_NATIVE_SIDECAR;
  const previousDisable = process.env.AGENTOS_DISABLE_RUST_SIDECAR;

  await fs.writeFile(
    sidecarPath,
    `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "list_windows") {
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { windows: [] } }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { ok: true } }) + "\\n");
});`,
    "utf8"
  );
  await fs.chmod(sidecarPath, 0o755);

  process.env.AGENTOS_NATIVE_SIDECAR = sidecarPath;
  delete process.env.AGENTOS_DISABLE_RUST_SIDECAR;

  try {
    const bridge = new MacOSHostBridge({
      dataDir: tempDir
    });
    const windows = await bridge.listWindows();
    assert.ok(Array.isArray(windows.windows));
    assert.ok(windows.windows.length > 0);
    assert.equal(typeof windows.windows[0]?.ownerName, "string");
    await bridge.shutdown();
  } finally {
    if (previousSidecar === undefined) {
      delete process.env.AGENTOS_NATIVE_SIDECAR;
    } else {
      process.env.AGENTOS_NATIVE_SIDECAR = previousSidecar;
    }
    if (previousDisable === undefined) {
      delete process.env.AGENTOS_DISABLE_RUST_SIDECAR;
    } else {
      process.env.AGENTOS_DISABLE_RUST_SIDECAR = previousDisable;
    }
  }
});

test("macOS host bridge falls back when the sidecar errors on permissions status", { skip: !isMac }, async () => {
  const tempDir = await createTempDir("agentos-sidecar-permissions-fallback-");
  const sidecarPath = path.join(tempDir, "permissions-error-sidecar.mjs");
  const previousSidecar = process.env.AGENTOS_NATIVE_SIDECAR;
  const previousDisable = process.env.AGENTOS_DISABLE_RUST_SIDECAR;

  await fs.writeFile(
    sidecarPath,
    `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "permissions_status") {
    process.stdout.write(JSON.stringify({ id: request.id, ok: false, error: "boom" }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { ok: true } }) + "\\n");
});`,
    "utf8"
  );
  await fs.chmod(sidecarPath, 0o755);

  process.env.AGENTOS_NATIVE_SIDECAR = sidecarPath;
  delete process.env.AGENTOS_DISABLE_RUST_SIDECAR;

  try {
    const bridge = new MacOSHostBridge({ dataDir: tempDir });
    const permissions = await bridge.getPermissionsStatus();
    assert.equal(typeof permissions.accessibility, "boolean");
    assert.equal(typeof permissions.screenRecording, "boolean");
    await bridge.shutdown();
  } finally {
    if (previousSidecar === undefined) {
      delete process.env.AGENTOS_NATIVE_SIDECAR;
    } else {
      process.env.AGENTOS_NATIVE_SIDECAR = previousSidecar;
    }
    if (previousDisable === undefined) {
      delete process.env.AGENTOS_DISABLE_RUST_SIDECAR;
    } else {
      process.env.AGENTOS_DISABLE_RUST_SIDECAR = previousDisable;
    }
  }
});
