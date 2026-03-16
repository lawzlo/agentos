import test from "node:test";
import assert from "node:assert/strict";

import { WindowsHostBridge } from "../src/runtime/host-bridges/windows-bridge.js";

test("windows host bridge parses native desktop queries through PowerShell", async () => {
  const scripts = [];
  const bridge = new WindowsHostBridge({
    platform: "win32",
    runPowerShell: async (script) => {
      scripts.push(script);

      if (script.includes("GetForegroundWindow")) {
        return {
          stdout: JSON.stringify({
            appName: "Slack",
            processId: 4242,
            windowTitle: "Inbox",
            mainWindowTitle: "Inbox"
          }),
          stderr: ""
        };
      }

      if (script.includes("EnumWindows")) {
        return {
          stdout: JSON.stringify({
            windows: [
              {
                ownerName: "Slack",
                windowName: "Inbox",
                ownerPID: 4242,
                windowNumber: 7,
                layer: 0,
                alpha: 1,
                bounds: { x: 10, y: 20, width: 300, height: 400, centerX: 160, centerY: 220 }
              }
            ]
          }),
          stderr: ""
        };
      }

      if (script.includes("Windows.Media.Ocr.OcrEngine")) {
        return {
          stdout: JSON.stringify({
            observations: [
              {
                text: "Unread",
                confidence: 0.7,
                box: { x: 1, y: 2, width: 50, height: 20, centerX: 26, centerY: 12 }
              },
              {
                text: "Send",
                confidence: 0.95,
                box: { x: 10, y: 20, width: 40, height: 20, centerX: 30, centerY: 30 }
              }
            ]
          }),
          stderr: ""
        };
      }

      return {
        stdout: JSON.stringify({ ok: true, echoed: true }),
        stderr: ""
      };
    }
  });

  const frontmost = await bridge.getFrontmostApp();
  assert.equal(frontmost.appName, "Slack");

  const windows = await bridge.listWindows();
  assert.equal(windows.windows[0].ownerName, "Slack");

  const ocr = await bridge.ocrImage("screen.png");
  assert.equal(ocr.observations[1].text, "Send");

  const found = await bridge.findText("screen.png", "send");
  assert.equal(found.found, true);
  assert.equal(found.match.text, "Send");

  const permissions = await bridge.getPermissionsStatus();
  assert.equal(permissions.accessibility, true);

  assert.ok(scripts.some((script) => script.includes("Windows.Media.Ocr.OcrEngine")));
});

test("windows host bridge supports input primitives via PowerShell", async () => {
  const scripts = [];
  const bridge = new WindowsHostBridge({
    platform: "win32",
    runPowerShell: async (script) => {
      scripts.push(script);
      return {
        stdout: JSON.stringify({ ok: true, pressed: true, typed: 5, x: 120, y: 240, dx: 0, dy: -120 }),
        stderr: ""
      };
    }
  });

  await bridge.typeText("a+b");
  await bridge.pressKey("enter", ["ctrl"]);
  await bridge.moveMouse(120, 240);
  await bridge.clickAt(120, 240);
  await bridge.scroll(0, -120);

  assert.ok(scripts.some((script) => script.includes("SendKeys")));
  assert.ok(scripts.some((script) => script.includes("mouse_event")));
  assert.ok(scripts.some((script) => script.includes("^")));
});
