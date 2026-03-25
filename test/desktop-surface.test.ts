import test from "node:test";
import assert from "node:assert/strict";

import { DesktopSurfaceAdapter } from "../src/runtime/adapters/desktop-surface.js";
import type { WorldState } from "../src/types/runtime-schema.js";

function createAdapter() {
  const adapter = new DesktopSurfaceAdapter({
    artifactStore: {
      registerExistingFile() {
        throw new Error("artifact registration should not run in this test");
      }
    },
    dataDir: "/tmp/agentos-test"
  }) as DesktopSurfaceAdapter & { bridge: Record<string, unknown> };

  const calls: Array<{ action: string; name: string }> = [];
  adapter.bridge = {
    async focusApp(name: string) {
      calls.push({ action: "focus", name });
      return { focused: name };
    },
    async getFrontmostApp() {
      return { appName: "Slack" };
    },
    async launchApp(name: string) {
      calls.push({ action: "launch", name });
      return { launched: name };
    }
  };

  return { adapter, calls };
}

function createObserveAdapter(timeouts?: Record<string, number>) {
  const registeredArtifacts: Array<Record<string, unknown>> = [];
  const adapter = new DesktopSurfaceAdapter({
    artifactStore: {
      registerExistingFile(payload: Record<string, unknown>) {
        registeredArtifacts.push(payload);
        return {
          id: "artifact_test",
          taskId: String(payload.taskId ?? "task_test"),
          traceId: payload.traceId ?? null,
          kind: "screenshot",
          label: String(payload.label ?? "desktop-capture"),
          path: String(payload.filePath),
          metadata: payload.metadata ?? {},
          createdAt: new Date().toISOString()
        };
      }
    },
    dataDir: "/tmp/agentos-test",
    timeouts
  }) as DesktopSurfaceAdapter & { bridge: Record<string, unknown> };

  adapter.bridge = {
    async captureScreen() {
      return { ok: true };
    },
    async getFrontmostApp() {
      return { appName: "Slack" };
    },
    async getAccessibilitySnapshot() {
      return {
        appName: "Slack",
        windows: [
          {
            title: "Slack",
            bounds: { x: 0, y: 0, width: 400, height: 400, centerX: 200, centerY: 200 }
          }
        ],
        elements: [
          {
            id: "ax-thread",
            role: "AXButton",
            title: "Unread: Acme renewal",
            description: "Unread thread",
            actions: ["AXPress"],
            bounds: { x: 16, y: 18, width: 180, height: 24, centerX: 106, centerY: 30 }
          },
          {
            id: "ax-compose",
            role: "AXTextArea",
            description: "Message",
            focused: true,
            actions: ["AXPress"],
            bounds: { x: 24, y: 220, width: 220, height: 40, centerX: 134, centerY: 240 }
          }
        ]
      };
    },
    async ocrImage() {
      return {
        observations: [
          {
            text: "Acme renewal",
            confidence: 0.9,
            box: { x: 20, y: 20, width: 120, height: 20, centerX: 80, centerY: 30 }
          },
          {
            text: "# duration ms 49970",
            confidence: 0.9,
            box: { x: 620, y: 30, width: 180, height: 20, centerX: 710, centerY: 40 }
          }
        ]
      };
    },
    async listWindows() {
      return {
        windows: [
          {
            ownerName: "Slack",
            windowName: "Slack",
            bounds: { x: 0, y: 0, width: 400, height: 400, centerX: 200, centerY: 200 }
          },
          {
            ownerName: "Terminal",
            windowName: "Terminal",
            bounds: { x: 500, y: 0, width: 400, height: 400, centerX: 700, centerY: 200 }
          }
        ]
      };
    },
    async getPermissionsStatus() {
      return { accessibility: true, screenRecording: true };
    }
  };

  return { adapter, registeredArtifacts };
}

test("desktop surface focus accepts appName aliases", async () => {
  const { adapter, calls } = createAdapter();

  const result = await adapter.focus({
    step: {
      params: {
        appName: "Slack"
      }
    }
  });

  assert.deepEqual(result, { focused: true, frontmostApp: "Slack", timedOut: false });
  assert.deepEqual(calls, [{ action: "focus", name: "Slack" }]);
});

test("desktop surface actions accept appName aliases for focus and launch", async () => {
  const { adapter, calls } = createAdapter();

  const focusResult = await adapter.act({
    task: { id: "task_test" },
    step: {
      action: "focusApp",
      params: {
        appName: "Slack"
      }
    },
    workspace: {
      rootPath: "/tmp",
      artifactsPath: "/tmp"
    },
    traceId: "trace_test"
  });
  const launchResult = await adapter.act({
    task: { id: "task_test" },
    step: {
      action: "launchApp",
      params: {
        appName: "WeChat"
      }
    },
    workspace: {
      rootPath: "/tmp",
      artifactsPath: "/tmp"
    },
    traceId: "trace_test"
  });

  assert.deepEqual(focusResult, { focused: true, frontmostApp: "Slack", timedOut: false });
  assert.deepEqual(launchResult, { launched: "WeChat" });
  assert.deepEqual(calls, [
    { action: "focus", name: "Slack" },
    { action: "launch", name: "WeChat" }
  ]);
});

test("desktop surface actions time out focus and launch helpers instead of hanging", async () => {
  const { adapter } = createAdapter();
  adapter.timeouts.focusMs = 10;
  adapter.bridge.focusApp = async () => new Promise(() => {});
  adapter.bridge.launchApp = async () => new Promise(() => {});
  adapter.bridge.getFrontmostApp = async () => ({ appName: "" });

  const focusResult = await adapter.act({
    task: { id: "task_test" },
    step: {
      action: "focusApp",
      params: {
        appName: "Slack"
      }
    },
    workspace: {
      rootPath: "/tmp",
      artifactsPath: "/tmp"
    },
    traceId: "trace_test"
  });
  const launchResult = await adapter.act({
    task: { id: "task_test" },
    step: {
      action: "launchApp",
      params: {
        appName: "Slack"
      }
    },
    workspace: {
      rootPath: "/tmp",
      artifactsPath: "/tmp"
    },
    traceId: "trace_test"
  });

  assert.deepEqual(focusResult, { focused: false, timedOut: true });
  assert.deepEqual(launchResult, { launched: false, timedOut: true });
});

test("desktop clickTarget prefers targetQuery OCR grounding over stale bounds", async () => {
  const { adapter } = createObserveAdapter();
  const clicks: Array<{ x: number; y: number }> = [];

  adapter.bridge.findText = async (_filePath: string, query: string) => ({
    found: query === "Reply",
    count: query === "Reply" ? 1 : 0,
    match: query === "Reply"
      ? {
          text: "Reply",
          confidence: 0.98,
          box: { x: 300, y: 220, width: 80, height: 20, centerX: 340, centerY: 230 }
        }
      : undefined
  });
  adapter.bridge.clickAt = async (x: number, y: number) => {
    clicks.push({ x, y });
    return { ok: true, x, y };
  };

  const result = await adapter.act({
    task: { id: "task_test" },
    step: {
      id: "step_click_target",
      action: "clickTarget",
      params: {
        targetQuery: "Reply",
        target: {
          id: "stale-target",
          bounds: { x: 10, y: 10, width: 20, height: 20, centerX: 20, centerY: 20 }
        }
      }
    },
    workspace: {
      rootPath: "/tmp",
      artifactsPath: "/tmp"
    },
    traceId: "trace_test"
  });

  assert.deepEqual(result, { ok: true, x: 340, y: 230 });
  assert.deepEqual(clicks, [{ x: 340, y: 230 }]);
});

test("desktop clickTarget falls back to interaction candidates when OCR misses the query", async () => {
  const { adapter } = createObserveAdapter();
  const clicks: Array<{ x: number; y: number }> = [];

  adapter.bridge.getFrontmostApp = async () => ({ appName: "Microsoft Outlook" });
  adapter.bridge.getAccessibilitySnapshot = async () => ({
    appName: "Microsoft Outlook",
    windows: [
      {
        title: "Inbox - Microsoft Outlook",
        bounds: { x: 0, y: 0, width: 1200, height: 800, centerX: 600, centerY: 400 }
      }
    ],
    elements: [
      {
        id: "ax-mail-row",
        role: "AXRow",
        title: "上海光华 项目更新",
        description: "Unread message row",
        actions: ["AXPress"],
        bounds: { x: 240, y: 180, width: 280, height: 40, centerX: 380, centerY: 200 }
      }
    ]
  });
  adapter.bridge.findText = async () => ({ found: false, count: 0 });
  adapter.bridge.clickAt = async (x: number, y: number) => {
    clicks.push({ x, y });
    return { ok: true, x, y };
  };

  const result = await adapter.act({
    task: { id: "task_test" },
    step: {
      id: "step_click_target_ax",
      action: "clickTarget",
      params: {
        targetQuery: "上海光华"
      }
    },
    workspace: {
      rootPath: "/tmp",
      artifactsPath: "/tmp"
    },
    traceId: "trace_test"
  });

  assert.deepEqual(result, { ok: true, x: 380, y: 200 });
  assert.deepEqual(clicks, [{ x: 380, y: 200 }]);
});

test("desktop typeIntoTarget focuses targetQuery OCR match before typing", async () => {
  const { adapter } = createObserveAdapter();
  const clicks: Array<{ x: number; y: number }> = [];
  const typed: string[] = [];
  const keyPresses: Array<{ key: string; modifiers: string[] }> = [];

  adapter.bridge.findText = async (_filePath: string, query: string) => ({
    found: query === "Reply",
    count: query === "Reply" ? 1 : 0,
    match: query === "Reply"
      ? {
          text: "Reply",
          confidence: 0.98,
          box: { x: 410, y: 260, width: 90, height: 22, centerX: 455, centerY: 271 }
        }
      : undefined
  });
  adapter.bridge.clickAt = async (x: number, y: number) => {
    clicks.push({ x, y });
    return { ok: true, x, y };
  };
  adapter.bridge.typeText = async (text: string) => {
    typed.push(text);
    return { text, typed: text.length };
  };
  adapter.bridge.pressKey = async (key: string, modifiers: string[] = []) => {
    keyPresses.push({ key, modifiers });
    return { key, modifiers };
  };

  const result = await adapter.act({
    task: { id: "task_test" },
    step: {
      id: "step_type_target",
      action: "typeIntoTarget",
      params: {
        targetQuery: "Reply",
        text: "hello"
      }
    },
    workspace: {
      rootPath: "/tmp",
      artifactsPath: "/tmp"
    },
    traceId: "trace_test"
  });

  assert.deepEqual(result, { text: "hello", typed: 5 });
  assert.deepEqual(clicks, [{ x: 455, y: 271 }]);
  assert.deepEqual(keyPresses, [
    { key: "a", modifiers: ["cmd"] },
    { key: "delete", modifiers: [] }
  ]);
  assert.deepEqual(typed, ["hello"]);
});

test("desktop typeIntoTarget can paste into a grounded target", async () => {
  const { adapter } = createObserveAdapter();
  const clicks: Array<{ x: number; y: number }> = [];
  const pasted: string[] = [];
  const keyPresses: Array<{ key: string; modifiers: string[] }> = [];

  adapter.bridge.findText = async (_filePath: string, query: string) => ({
    found: query === "Reply",
    count: query === "Reply" ? 1 : 0,
    match: query === "Reply"
      ? {
          text: "Reply",
          confidence: 0.98,
          box: { x: 410, y: 260, width: 90, height: 22, centerX: 455, centerY: 271 }
        }
      : undefined
  });
  adapter.bridge.clickAt = async (x: number, y: number) => {
    clicks.push({ x, y });
    return { ok: true, x, y };
  };
  adapter.bridge.pasteText = async (text: string) => {
    pasted.push(text);
    return { text, method: "paste" };
  };
  adapter.bridge.pressKey = async (key: string, modifiers: string[] = []) => {
    keyPresses.push({ key, modifiers });
    return { key, modifiers };
  };

  const result = await adapter.act({
    task: { id: "task_test" },
    step: {
      id: "step_paste_target",
      action: "typeIntoTarget",
      params: {
        targetQuery: "Reply",
        text: "hello",
        inputMethod: "paste"
      }
    },
    workspace: {
      rootPath: "/tmp",
      artifactsPath: "/tmp"
    },
    traceId: "trace_test"
  });

  assert.deepEqual(result, { text: "hello", method: "paste" });
  assert.deepEqual(clicks, [{ x: 455, y: 271 }]);
  assert.deepEqual(keyPresses, [{ key: "a", modifiers: ["cmd"] }]);
  assert.deepEqual(pasted, ["hello"]);
});

test("desktop typeIntoTarget skips clear keystrokes when clear is false", async () => {
  const { adapter } = createObserveAdapter();
  const clicks: Array<{ x: number; y: number }> = [];
  const pasted: string[] = [];
  const keyPresses: Array<{ key: string; modifiers: string[] }> = [];

  adapter.bridge.findText = async (_filePath: string, query: string) => ({
    found: query === "Reply",
    count: query === "Reply" ? 1 : 0,
    match: query === "Reply"
      ? {
          text: "Reply",
          confidence: 0.98,
          box: { x: 410, y: 260, width: 90, height: 22, centerX: 455, centerY: 271 }
        }
      : undefined
  });
  adapter.bridge.clickAt = async (x: number, y: number) => {
    clicks.push({ x, y });
    return { ok: true, x, y };
  };
  adapter.bridge.pasteText = async (text: string) => {
    pasted.push(text);
    return { text, method: "paste" };
  };
  adapter.bridge.pressKey = async (key: string, modifiers: string[] = []) => {
    keyPresses.push({ key, modifiers });
    return { key, modifiers };
  };

  const result = await adapter.act({
    task: { id: "task_test" },
    step: {
      id: "step_paste_target_no_clear",
      action: "typeIntoTarget",
      params: {
        targetQuery: "Reply",
        text: "hello",
        inputMethod: "paste",
        clear: false
      }
    },
    workspace: {
      rootPath: "/tmp",
      artifactsPath: "/tmp"
    },
    traceId: "trace_test"
  });

  assert.deepEqual(result, { text: "hello", method: "paste" });
  assert.deepEqual(clicks, [{ x: 455, y: 271 }]);
  assert.deepEqual(keyPresses, []);
  assert.deepEqual(pasted, ["hello"]);
});

test("desktop waitForTarget resolves interaction candidates without OCR text matches", async () => {
  const { adapter } = createObserveAdapter();

  adapter.bridge.getFrontmostApp = async () => ({ appName: "Microsoft Outlook" });
  adapter.bridge.getAccessibilitySnapshot = async () => ({
    appName: "Microsoft Outlook",
    windows: [
      {
        title: "Inbox - Microsoft Outlook",
        bounds: { x: 0, y: 0, width: 1200, height: 800, centerX: 600, centerY: 400 }
      }
    ],
    elements: [
      {
        id: "ax-reply-box",
        role: "AXTextArea",
        title: "Reply",
        description: "Reply message editor",
        actions: ["AXPress"],
        bounds: { x: 520, y: 240, width: 400, height: 200, centerX: 720, centerY: 340 }
      }
    ]
  });
  adapter.bridge.findText = async () => ({ found: false, count: 0 });

  const result = await adapter.act({
    task: { id: "task_test" },
    step: {
      id: "step_wait_target_ax",
      action: "waitForTarget",
      params: {
        targetQuery: "Reply",
        timeoutMs: 50,
        pollMs: 10
      }
    },
    workspace: {
      rootPath: "/tmp",
      artifactsPath: "/tmp"
    },
    traceId: "trace_test"
  });

  assert.equal(result?.found, true);
  assert.equal(result?.method, "interaction");
});

test("desktop surface focus treats a timed focus helper as success when the target app becomes frontmost", async () => {
  const { adapter } = createAdapter();
  adapter.timeouts.focusMs = 10;
  adapter.bridge.focusApp = async () => new Promise(() => {});
  adapter.bridge.getFrontmostApp = async () => ({ appName: "Microsoft Outlook" });

  const result = await adapter.act({
    task: { id: "task_test" },
    step: {
      action: "focusApp",
      params: {
        appName: "Microsoft Outlook"
      }
    },
    workspace: {
      rootPath: "/tmp",
      artifactsPath: "/tmp"
    },
    traceId: "trace_test"
  });

  assert.deepEqual(result, {
    focused: true,
    timedOut: false,
    frontmostApp: "Microsoft Outlook"
  });
});

test("desktop observe filters OCR blocks to the frontmost app window", async () => {
  const { adapter, registeredArtifacts } = createObserveAdapter();

  const worldState = (await adapter.observe({
    task: { id: "task_test" },
    workspace: {
      id: "workspace_test",
      artifactsPath: "/tmp",
      rootPath: "/tmp"
    },
    traceId: "trace_test"
  })) as WorldState;

  assert.equal(registeredArtifacts.length, 1);
  assert.equal(worldState.appContext?.appName, "Slack");
  const accessibility = worldState.appContext?.accessibility as { elements?: unknown[] } | undefined;
  assert.equal(Array.isArray(accessibility?.elements), true);
  assert.equal(worldState.ocrBlocks.length, 1);
  assert.equal(worldState.ocrBlocks[0]?.text, "Acme renewal");
  assert.equal(worldState.interactionCandidates.some((candidate) => candidate.sourceHints?.source === "accessibility"), true);
  assert.equal(worldState.visibleText.includes("Unread: Acme renewal"), true);
  assert.equal(worldState.visibleText.includes("Message"), true);
  assert.equal(worldState.visibleText.includes("# duration ms 49970"), false);
});

test("desktop observe falls back to accessibility when OCR fails", async () => {
  const { adapter } = createObserveAdapter();
  adapter.bridge.ocrImage = async () => {
    throw new Error("ocr_image failed");
  };

  const worldState = (await adapter.observe({
    task: { id: "task_test" },
    workspace: {
      id: "workspace_test",
      artifactsPath: "/tmp",
      rootPath: "/tmp"
    },
    traceId: "trace_test"
  })) as WorldState;

  assert.equal(worldState.appContext?.appName, "Slack");
  assert.equal(worldState.appContext?.ocrAvailable, false);
  assert.equal(worldState.appContext?.ocrError, "ocr_image failed");
  assert.equal(worldState.ocrBlocks.length, 0);
  assert.equal(worldState.interactionCandidates.some((candidate) => candidate.sourceHints?.source === "accessibility"), true);
  assert.equal(worldState.visibleText.includes("Unread: Acme renewal"), true);
  assert.equal(worldState.summary.includes("OCR unavailable: ocr_image failed"), true);
});

test("desktop observe augments WeChat window captures with supplemental OCR regions", async () => {
  const { adapter } = createObserveAdapter();
  const ocrCalls: Array<Record<string, unknown>> = [];
  adapter.bridge.captureScreen = async (_filePath: string, windowNumber?: number | null) => ({
    ok: true,
    windowNumber: windowNumber ?? null
  });
  adapter.bridge.getFrontmostApp = async () => ({ appName: "WeChat" });
  adapter.bridge.listWindows = async () => ({
    windows: [
      {
        ownerName: "WeChat",
        windowName: "WeChat",
        windowNumber: 11,
        bounds: { x: 0, y: 0, width: 900, height: 700, centerX: 450, centerY: 350 }
      }
    ]
  });
  adapter.bridge.getAccessibilitySnapshot = async () => ({
    appName: "WeChat",
    windows: [],
    elements: []
  });
  adapter.bridge.ocrImage = async (_filePath: string, options?: { region?: Record<string, number>; scale?: number }) => {
    ocrCalls.push({
      region: options?.region ?? null,
      scale: options?.scale ?? null
    });
    if (!options?.region) {
      return {
        observations: [
          {
            text: "03/11",
            confidence: 0.8,
            box: { x: 350, y: 120, width: 60, height: 24, centerX: 380, centerY: 132 }
          }
        ]
      };
    }
    if (Number(options.region.x) < 0.2) {
      return {
        observations: [
          {
            text: "Official Accounts",
            confidence: 0.95,
            box: { x: 120, y: 120, width: 180, height: 28, centerX: 210, centerY: 134 }
          }
        ]
      };
    }
    return {
      observations: [
        {
          text: "输入",
          confidence: 0.9,
          box: { x: 420, y: 610, width: 120, height: 32, centerX: 480, centerY: 626 }
        }
      ]
    };
  };

  const worldState = (await adapter.observe({
    task: { id: "task_test" },
    workspace: {
      id: "workspace_test",
      artifactsPath: "/tmp",
      rootPath: "/tmp"
    },
    traceId: "trace_test"
  })) as WorldState;

  assert.equal(ocrCalls.length, 3);
  assert.deepEqual(ocrCalls[1]?.region, { x: 0.1, y: 0.09, width: 0.34, height: 0.78 });
  assert.deepEqual(ocrCalls[2]?.region, { x: 0.34, y: 0.78, width: 0.6, height: 0.18 });
  assert.equal(worldState.appContext?.supplementalOcrBlockCount, 2);
  assert.equal(worldState.ocrBlocks.some((block) => block.text === "Official Accounts"), true);
  assert.equal(worldState.ocrBlocks.some((block) => block.text === "输入"), true);
  assert.equal(
    worldState.interactionCandidates.some((candidate) => candidate.text === "Official Accounts" && candidate.sourceHints?.source === "ocr-wechat-list"),
    true
  );
  assert.equal(
    worldState.interactionCandidates.some((candidate) => candidate.text === "输入" && candidate.sourceHints?.source === "ocr-wechat-compose"),
    true
  );
});

test("desktop observe captures the target app window even when another app is frontmost", async () => {
  const { adapter } = createObserveAdapter();
  const capturedWindowNumbers: Array<number | null> = [];
  adapter.bridge.getFrontmostApp = async () => ({ appName: "Terminal" });
  adapter.bridge.captureScreen = async (_filePath: string, windowNumber?: number | null) => {
    capturedWindowNumbers.push(windowNumber ?? null);
    return { ok: true, windowNumber: windowNumber ?? null };
  };
  adapter.bridge.listWindows = async () => ({
    windows: [
      {
        ownerName: "WeChat",
        windowName: "WeChat",
        windowNumber: 52183,
        bounds: { x: 20, y: 20, width: 300, height: 500, centerX: 170, centerY: 270 }
      },
      {
        ownerName: "Terminal",
        windowName: "Terminal",
        windowNumber: 49764,
        bounds: { x: 500, y: 0, width: 400, height: 400, centerX: 700, centerY: 200 }
      }
    ]
  });

  const worldState = (await adapter.observe({
    task: { id: "task_test" },
    workspace: {
      id: "workspace_test",
      artifactsPath: "/tmp",
      rootPath: "/tmp"
    },
    traceId: "trace_test",
    targetAppName: "WeChat"
  })) as WorldState;

  assert.deepEqual(capturedWindowNumbers, [52183]);
  assert.equal(worldState.appContext?.targetAppName, "WeChat");
  assert.equal(worldState.appContext?.captureWindowNumber, 52183);
});

test("desktop verify can require region text visibility", async () => {
  const { adapter } = createObserveAdapter();
  adapter.bridge.getFrontmostApp = async () => ({ appName: "WeChat" });
  adapter.bridge.ocrImage = async (_filePath: string, options?: { region?: Record<string, number> }) => {
    if (options?.region && Number(options.region.x) > 0.3) {
      return {
        observations: [
          {
            text: "Tan",
            confidence: 0.95,
            box: { x: 520, y: 28, width: 60, height: 24, centerX: 550, centerY: 40 }
          }
        ]
      };
    }
    return { observations: [] };
  };

  const result = await adapter.verify({
    task: { id: "task_test" },
    workspace: {
      id: "workspace_test",
      artifactsPath: "/tmp",
      rootPath: "/tmp"
    },
    traceId: "trace_test",
    expectation: {
      frontmostApp: "WeChat",
      regionTextVisible: {
        text: "Tan",
        region: { x: 0.34, y: 0.02, width: 0.6, height: 0.16 },
        scale: 2.2
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.details.frontmostApp, "WeChat");
  assert.equal(result.details.regionTextVisible, true);
});

test("desktop verify fails when region text is not visible in the requested area", async () => {
  const { adapter } = createObserveAdapter();
  adapter.bridge.getFrontmostApp = async () => ({ appName: "WeChat" });
  adapter.bridge.ocrImage = async () => ({
    observations: [
      {
        text: "Official Accounts",
        confidence: 0.95,
        box: { x: 120, y: 140, width: 180, height: 28, centerX: 210, centerY: 154 }
      }
    ]
  });

  const result = await adapter.verify({
    task: { id: "task_test" },
    workspace: {
      id: "workspace_test",
      artifactsPath: "/tmp",
      rootPath: "/tmp"
    },
    traceId: "trace_test",
    expectation: {
      frontmostApp: "WeChat",
      regionTextVisible: {
        text: "Tan",
        region: { x: 0.34, y: 0.02, width: 0.6, height: 0.16 },
        scale: 2.2
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.details.frontmostApp, "WeChat");
  assert.equal(result.details.regionTextVisible, false);
  assert.deepEqual(result.details.regionTextPreview, ["Official Accounts"]);
});

test("desktop verify does not accept tiny OCR fragments as a full region-text match", async () => {
  const { adapter } = createObserveAdapter();
  adapter.bridge.getFrontmostApp = async () => ({ appName: "Microsoft Outlook" });
  adapter.bridge.ocrImage = async () => ({
    observations: [
      {
        text: "4",
        confidence: 0.92,
        box: { x: 640, y: 330, width: 12, height: 20, centerX: 646, centerY: 340 }
      }
    ]
  });

  const result = await adapter.verify({
    task: { id: "task_test" },
    workspace: {
      id: "workspace_test",
      artifactsPath: "/tmp",
      rootPath: "/tmp"
    },
    traceId: "trace_test",
    expectation: {
      frontmostApp: "Outlook",
      regionTextVisible: {
        text: "AGENTOS PASTE 4",
        region: { x: 0.4, y: 0.2, width: 0.4, height: 0.2 },
        scale: 2.4
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.details.regionTextVisible, false);
  assert.deepEqual(result.details.regionTextPreview, ["4"]);
});

test("desktop verify supports matching region text across multiple candidate regions", async () => {
  const { adapter } = createObserveAdapter();
  adapter.bridge.getFrontmostApp = async () => ({ appName: "WeChat" });
  adapter.bridge.ocrImage = async (
    _path: string,
    options?: { region?: { x?: number; y?: number; width?: number; height?: number } }
  ) => {
    const regionHeight = Number(options?.region?.height ?? 0);
    if (regionHeight <= 0.2) {
      return {
        observations: [
          {
            text: "Official Accounts",
            confidence: 0.95,
            box: { x: 120, y: 140, width: 180, height: 28, centerX: 210, centerY: 154 }
          }
        ]
      };
    }
    return {
      observations: [
        {
          text: "Tan",
          confidence: 0.96,
          box: { x: 620, y: 84, width: 60, height: 24, centerX: 650, centerY: 96 }
        }
      ]
    };
  };

  const result = await adapter.verify({
    task: { id: "task_test" },
    workspace: {
      id: "workspace_test",
      artifactsPath: "/tmp",
      rootPath: "/tmp"
    },
    traceId: "trace_test",
    expectation: {
      frontmostApp: "WeChat",
      regionTextAnyVisible: [
        {
          text: "Tan",
          region: { x: 0.34, y: 0.02, width: 0.6, height: 0.16 },
          scale: 2.2
        },
        {
          text: "Tan",
          region: { x: 0.34, y: 0.02, width: 0.62, height: 0.72 },
          scale: 2.2
        }
      ]
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.details.frontmostApp, "WeChat");
  assert.equal(result.details.regionTextAnyVisible, true);
  assert.equal(result.details.regionTextAnyChecks[0]?.matched, false);
  assert.equal(result.details.regionTextAnyChecks[1]?.matched, true);
});

test("desktop verify can match region text against the combined OCR preview of a single region", async () => {
  const { adapter } = createObserveAdapter();
  adapter.bridge.getFrontmostApp = async () => ({ appName: "Microsoft Outlook" });
  adapter.bridge.ocrImage = async () => ({
    observations: [
      {
        text: "Thanks for your email.",
        confidence: 0.96,
        box: { x: 640, y: 340, width: 210, height: 24, centerX: 745, centerY: 352 }
      },
      {
        text: "I received it and will follow up shortly.",
        confidence: 0.95,
        box: { x: 640, y: 372, width: 320, height: 24, centerX: 800, centerY: 384 }
      }
    ]
  });

  const result = await adapter.verify({
    task: { id: "task_test" },
    workspace: {
      id: "workspace_test",
      artifactsPath: "/tmp",
      rootPath: "/tmp"
    },
    traceId: "trace_test",
    expectation: {
      frontmostApp: "Outlook",
      regionTextVisible: {
        text: "Thanks for your email. I received it and will follow up shortly.",
        region: { x: 0.38, y: 0.27, width: 0.22, height: 0.14 },
        scale: 2.4
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.details.frontmostApp, "Microsoft Outlook");
  assert.equal(result.details.regionTextVisible, true);
  assert.equal((result.details.regionTextMatch as { source?: string } | undefined)?.source, "combined_preview");
});

test("desktop verify falls back to matching windows when frontmost app lookup times out", async () => {
  const { adapter } = createObserveAdapter({
    frontmostMs: 10,
    windowsMs: 50
  });
  adapter.bridge.getFrontmostApp = async () => new Promise(() => {});
  adapter.bridge.listWindows = async () => ({
    windows: [
      {
        ownerName: "Microsoft Outlook",
        windowName: "Inbox - Microsoft Outlook",
        bounds: { x: 0, y: 0, width: 800, height: 600, centerX: 400, centerY: 300 }
      }
    ]
  });

  const result = await adapter.verify({
    task: { id: "task_test" },
    workspace: {
      id: "workspace_test",
      artifactsPath: "/tmp",
      rootPath: "/tmp"
    },
    traceId: "trace_test",
    expectation: {
      frontmostApp: "Outlook"
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.details.frontmostApp, "");
  assert.equal(result.details.frontmostAppFallback, true);
  assert.equal(result.details.frontmostAppWindowMatchCount, 1);
});

test("desktop capture falls back to a full-screen capture when window capture fails", async () => {
  const { adapter, registeredArtifacts } = createObserveAdapter({
    captureMs: 50
  });
  const captureCalls: Array<number | null | undefined> = [];
  adapter.bridge.listWindows = async () => {
    return {
      windows: [
        {
          ownerName: "Slack",
          windowName: "Slack",
          windowNumber: 7,
          bounds: { x: 0, y: 0, width: 400, height: 400, centerX: 200, centerY: 200 }
        }
      ]
    };
  };
  adapter.bridge.captureScreen = async (_filePath: string, windowNumber?: number | null) => {
    captureCalls.push(windowNumber);
    if (windowNumber) {
      throw new Error("window capture failed");
    }
    return { ok: true };
  };

  const worldState = (await adapter.observe({
    task: { id: "task_test" },
    workspace: {
      id: "workspace_test",
      artifactsPath: "/tmp",
      rootPath: "/tmp"
    },
    traceId: "trace_test"
  })) as WorldState;

  assert.deepEqual(captureCalls, [7, null]);
  assert.equal(registeredArtifacts.length, 1);
  assert.equal(worldState.appContext?.captureAvailable, true);
  assert.equal(worldState.appContext?.captureWindowNumber ?? null, null);
});

test("desktop verify can use visual checks for WeChat thread and prefill validation", async () => {
  const captureCalls: Array<number | null> = [];
  const adapter = new DesktopSurfaceAdapter({
    artifactStore: {
      registerExistingFile(payload: Record<string, unknown>) {
        return {
          id: "artifact_test",
          taskId: String(payload.taskId ?? "task_test"),
          traceId: payload.traceId ?? null,
          kind: "screenshot",
          label: String(payload.label ?? "desktop-capture"),
          path: String(payload.filePath),
          metadata: payload.metadata ?? {},
          createdAt: new Date().toISOString()
        };
      }
    },
    dataDir: "/tmp/agentos-test",
    visualModelClient: {
      supportsImageJson() {
        return true;
      },
      async analyzeImageJson() {
        return {
          openThread: "Tan",
          targetThreadOpen: true,
          prefillVisible: true
        };
      }
    } as never
  }) as DesktopSurfaceAdapter & { bridge: Record<string, unknown> };

  adapter.bridge = {
    async captureScreen(_filePath: string, windowNumber?: number | null) {
      captureCalls.push(windowNumber ?? null);
      return { ok: true, windowNumber: windowNumber ?? null };
    },
    async getFrontmostApp() {
      return { appName: "WeChat" };
    },
    async listWindows() {
      return {
        windows: [
          {
            ownerName: "WeChat",
            windowName: "WeChat",
            windowNumber: 11,
            bounds: { x: 0, y: 0, width: 900, height: 700, centerX: 450, centerY: 350 }
          }
        ]
      };
    },
    async getPermissionsStatus() {
      return { accessibility: true, screenRecording: true };
    },
    async ocrImage() {
      return { observations: [] };
    }
  };

  const result = await adapter.verify({
    task: { id: "task_test" },
    workspace: {
      id: "workspace_test",
      artifactsPath: "/tmp",
      rootPath: "/tmp"
    },
    traceId: "trace_test",
    expectation: {
      frontmostApp: "WeChat",
      visualCheck: {
        type: "wechat_prefill",
        targetThread: "Tan",
        replyPreview: "好的，我来处理"
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.details.frontmostApp, "WeChat");
  assert.equal(result.details.visualCheck?.targetThreadOpen, true);
  assert.equal(result.details.visualCheck?.prefillVisible, true);
  assert.deepEqual(captureCalls, [11]);
});

test("desktop visual checks require explicit positive verification results", async () => {
  const adapter = new DesktopSurfaceAdapter({
    artifactStore: {
      registerExistingFile(payload: Record<string, unknown>) {
        return {
          id: "artifact_test",
          taskId: String(payload.taskId ?? "task_test"),
          traceId: payload.traceId ?? null,
          kind: "screenshot",
          label: String(payload.label ?? "desktop-capture"),
          path: String(payload.filePath),
          metadata: payload.metadata ?? {},
          createdAt: new Date().toISOString()
        };
      }
    },
    dataDir: "/tmp/agentos-test",
    visualModelClient: {
      supportsImageJson() {
        return true;
      },
      async analyzeImageJson() {
        return {
          openThread: "Alice",
          targetThreadOpen: null,
          prefillVisible: null
        };
      }
    } as never
  }) as DesktopSurfaceAdapter & { bridge: Record<string, unknown> };

  adapter.bridge = {
    async captureScreen() {
      return { ok: true, windowNumber: 11 };
    },
    async getFrontmostApp() {
      return { appName: "Microsoft Outlook" };
    },
    async listWindows() {
      return {
        windows: [
          {
            ownerName: "Microsoft Outlook",
            windowName: "Inbox",
            windowNumber: 11,
            bounds: { x: 0, y: 0, width: 900, height: 700, centerX: 450, centerY: 350 }
          }
        ]
      };
    },
    async getPermissionsStatus() {
      return { accessibility: true, screenRecording: true };
    },
    async ocrImage() {
      return { observations: [] };
    }
  };

  const result = await adapter.verify({
    task: { id: "task_test" },
    workspace: {
      id: "workspace_test",
      artifactsPath: "/tmp",
      rootPath: "/tmp"
    },
    traceId: "trace_test",
    expectation: {
      frontmostApp: "Outlook",
      visualCheck: {
        type: "outlook_prefill",
        targetThread: "Alice",
        replyPreview: "Thanks, I will review it."
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.details.visualCheck?.targetThreadOpen, null);
  assert.equal(result.details.visualCheck?.prefillVisible, null);
});

test("desktop waitForAppReady waits for a stable frontmost app with accessibility candidates", async () => {
  const { adapter } = createObserveAdapter();
  let frontmostReads = 0;
  adapter.bridge.getFrontmostApp = async () => {
    frontmostReads += 1;
    return {
      appName: frontmostReads === 1 ? "Terminal" : "Slack"
    };
  };

  const readiness = await adapter.waitForAppReady({
    appName: "Slack",
    timeoutMs: 1000,
    pollMs: 1,
    stablePolls: 2,
    requireAccessibility: true
  });

  assert.equal(readiness.ready, true);
  assert.equal(readiness.frontmostApp, "Slack");
  assert.equal(readiness.accessibilityCandidateCount >= 1, true);
  assert.equal(readiness.attempts >= 3, true);
});

test("desktop waitForAppReady reports not ready when accessibility candidates never appear", async () => {
  const { adapter } = createObserveAdapter();
  adapter.bridge.getAccessibilitySnapshot = async () => ({
    appName: "WeChat",
    windows: [{ title: "WeChat", bounds: null }],
    elements: []
  });
  adapter.bridge.getFrontmostApp = async () => ({ appName: "WeChat" });

  const readiness = await adapter.waitForAppReady({
    appName: "WeChat",
    timeoutMs: 20,
    pollMs: 1,
    stablePolls: 2,
    requireAccessibility: true
  });

  assert.equal(readiness.ready, false);
  assert.equal(readiness.frontmostApp, "WeChat");
  assert.equal(readiness.accessibilityCandidateCount, 0);
});

test("desktop observe times out slow helper calls instead of hanging", async () => {
  const { adapter } = createObserveAdapter({
    captureMs: 20,
    frontmostMs: 20,
    ocrMs: 20,
    windowsMs: 20,
    permissionsMs: 20,
    accessibilityMs: 20
  });

  adapter.bridge.captureScreen = async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { ok: true };
  };
  adapter.bridge.getFrontmostApp = async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { appName: "WeChat" };
  };
  adapter.bridge.ocrImage = async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { observations: [{ text: "slow" }] };
  };
  adapter.bridge.listWindows = async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { windows: [] };
  };
  adapter.bridge.getPermissionsStatus = async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { accessibility: true, screenRecording: true };
  };
  adapter.bridge.getAccessibilitySnapshot = async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return {
      appName: "WeChat",
      windows: [],
      elements: []
    };
  };

  const started = Date.now();
  const worldState = (await adapter.observe({
    task: { id: "task_test" },
    workspace: {
      id: "workspace_test",
      artifactsPath: "/tmp",
      rootPath: "/tmp"
    },
    traceId: "trace_test"
  })) as WorldState;

  assert.equal(Date.now() - started < 250, true);
  assert.equal(worldState.appContext?.appName, "");
  assert.equal(worldState.capture, null);
  assert.equal(worldState.appContext?.captureAvailable, false);
  assert.match(String(worldState.appContext?.captureError ?? ""), /timed out after 20ms/i);
  assert.equal(worldState.ocrBlocks.length, 0);
  assert.equal(worldState.appContext?.ocrAvailable, false);
  assert.match(String(worldState.appContext?.ocrError ?? ""), /capture unavailable/i);
});

test("desktop waitForAppReady reports timeout-backed readiness details", async () => {
  const { adapter } = createObserveAdapter({
    frontmostMs: 20,
    accessibilityMs: 20
  });
  adapter.bridge.getFrontmostApp = async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { appName: "WeChat" };
  };

  const readiness = await adapter.waitForAppReady({
    appName: "WeChat",
    timeoutMs: 25,
    pollMs: 1,
    stablePolls: 1,
    requireAccessibility: true
  });

  assert.equal(readiness.ready, false);
  assert.equal(readiness.frontmostApp, null);
  assert.equal(readiness.matchedFrontmostApp, false);
  assert.equal(readiness.accessibilityCandidateCount, 0);
});
