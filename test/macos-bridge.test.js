import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { createTempDir } from "./helpers.js";
import { MacOSHostBridge } from "../src/runtime/host-bridges/macos-bridge.js";

const isMac = process.platform === "darwin";

test("macOS host bridge delegates visual commands to the helper executable", { skip: !isMac }, async () => {
  const tempDir = await createTempDir("agentos-bridge-");
  const helperPath = path.join(tempDir, "fake-helper.mjs");

  await fs.writeFile(
    helperPath,
    `#!/usr/bin/env node
const [,, command, ...args] = process.argv;
const emit = (payload) => process.stdout.write(JSON.stringify(payload));
switch (command) {
  case "frontmost-app":
    emit({ appName: "Finder", bundleIdentifier: "com.apple.finder" });
    break;
  case "capture-screen":
    emit({ ok: true, path: args[0], width: 1440, height: 900 });
    break;
  case "find-text":
    emit({ found: true, match: { text: args[1], box: { centerX: 320, centerY: 180 } }, count: 1 });
    break;
  case "ocr-image":
    emit({ observations: [{ text: "Hello AgentOS", confidence: 0.98 }] });
    break;
  default:
    emit({ ok: true, command, args });
}
`
  );
  await fs.chmod(helperPath, 0o755);

  const bridge = new MacOSHostBridge({
    helperExecutable: helperPath,
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

  const click = await bridge.clickAt(120, 240);
  assert.equal(click.ok, true);
});
