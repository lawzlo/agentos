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
    await fs.writeFile(sidecarPath, `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  const result = {
    frontmost_app: { appName: "Finder", bundleIdentifier: "com.apple.finder" },
    capture_screen: { ok: true, filePath: request.params.filePath, width: 1440, height: 900 },
    find_text: { found: true, match: { text: request.params.query, box: { centerX: 320, centerY: 180 } }, count: 1 },
    ocr_image: { observations: [{ text: "Hello AgentOS", confidence: 0.98 }] },
    permissions_status: { accessibility: true, screenRecording: true },
    list_windows: { windows: [{ ownerName: "Finder", windowName: "Desktop", ownerPID: 1, windowNumber: 7, layer: 0, alpha: 1, bounds: { x: 0, y: 0, width: 1440, height: 900, centerX: 720, centerY: 450 } }] },
    click_at: { ok: true, x: request.params.x, y: request.params.y }
  }[request.method] ?? { ok: true };
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + "\\n");
});
`, "utf8");
    await fs.chmod(sidecarPath, 0o755);
    process.env.AGENTOS_NATIVE_SIDECAR = sidecarPath;
    delete process.env.AGENTOS_DISABLE_RUST_SIDECAR;
    try {
        const bridge = new MacOSHostBridge({
            dataDir: tempDir
        });
        const frontmost = await bridge.getFrontmostApp();
        assert.equal(frontmost.appName, "Finder");
        const capture = await bridge.captureScreen(path.join(tempDir, "screen.png"));
        assert.equal(capture.ok, true);
        const search = await bridge.findText("dummy.png", "Submit");
        assert.equal(search.found, true);
        assert.equal(search.match.box.centerX, 320);
        const ocr = await bridge.ocrImage("dummy.png");
        assert.equal(ocr.observations[0].text, "Hello AgentOS");
        const permissions = await bridge.getPermissionsStatus();
        assert.equal(permissions.accessibility, true);
        const windows = await bridge.listWindows();
        assert.equal(windows.windows[0].ownerName, "Finder");
        const click = await bridge.clickAt(120, 240);
        assert.equal(click.ok, true);
        await bridge.shutdown();
    }
    finally {
        if (previousSidecar === undefined) {
            delete process.env.AGENTOS_NATIVE_SIDECAR;
        }
        else {
            process.env.AGENTOS_NATIVE_SIDECAR = previousSidecar;
        }
        if (previousDisable === undefined) {
            delete process.env.AGENTOS_DISABLE_RUST_SIDECAR;
        }
        else {
            process.env.AGENTOS_DISABLE_RUST_SIDECAR = previousDisable;
        }
    }
});
test("macOS host bridge can prefer a sidecar for helper-backed desktop methods", async () => {
    const tempDir = await createTempDir("agentos-sidecar-");
    const sidecarPath = path.join(tempDir, "fake-sidecar.mjs");
    const previousSidecar = process.env.AGENTOS_NATIVE_SIDECAR;
    const previousDisable = process.env.AGENTOS_DISABLE_RUST_SIDECAR;
    await fs.writeFile(sidecarPath, `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  const results = {
    frontmost_app: { appName: "SidecarApp", bundleIdentifier: "dev.agentos.sidecar" },
    ocr_image: { observations: [{ text: "Sidecar OCR", confidence: 0.91, box: { x: 0, y: 0, width: 10, height: 10, centerX: 5, centerY: 5 } }] },
    find_text: { found: true, match: { text: request.params.query, confidence: 0.99, box: { x: 10, y: 20, width: 30, height: 40, centerX: 25, centerY: 40 } }, count: 1 },
    permissions_status: { accessibility: true, screenRecording: false },
    list_windows: { windows: [{ ownerName: "SidecarApp", windowName: "Inbox", ownerPID: 99, windowNumber: 1, layer: 0, alpha: 1, bounds: { x: 1, y: 2, width: 3, height: 4, centerX: 2.5, centerY: 4 } }] }
  };
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: results[request.method] ?? { ok: true } }) + "\\n");
});`, "utf8");
    await fs.chmod(sidecarPath, 0o755);
    process.env.AGENTOS_NATIVE_SIDECAR = sidecarPath;
    delete process.env.AGENTOS_DISABLE_RUST_SIDECAR;
    try {
        const bridge = new MacOSHostBridge({
            dataDir: tempDir
        });
        const frontmost = await bridge.getFrontmostApp();
        assert.equal(frontmost.appName, "SidecarApp");
        const ocr = await bridge.ocrImage("dummy.png");
        assert.equal(ocr.observations[0].text, "Sidecar OCR");
        const found = await bridge.findText("dummy.png", "Send");
        assert.equal(found.match.text, "Send");
        const permissions = await bridge.getPermissionsStatus();
        assert.equal(permissions.screenRecording, false);
        const windows = await bridge.listWindows();
        assert.equal(windows.windows[0].windowName, "Inbox");
        await bridge.shutdown();
    }
    finally {
        if (previousSidecar === undefined) {
            delete process.env.AGENTOS_NATIVE_SIDECAR;
        }
        else {
            process.env.AGENTOS_NATIVE_SIDECAR = previousSidecar;
        }
        if (previousDisable === undefined) {
            delete process.env.AGENTOS_DISABLE_RUST_SIDECAR;
        }
        else {
            process.env.AGENTOS_DISABLE_RUST_SIDECAR = previousDisable;
        }
    }
});
