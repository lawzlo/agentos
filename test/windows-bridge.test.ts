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

  const permissions = await bridge.getPermissionsStatus();
  assert.equal(permissions.accessibility, true);
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
