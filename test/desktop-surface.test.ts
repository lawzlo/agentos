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

  assert.deepEqual(result, { focused: "Slack" });
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

  assert.deepEqual(focusResult, { focused: "Slack" });
  assert.deepEqual(launchResult, { launched: "WeChat" });
  assert.deepEqual(calls, [
    { action: "focus", name: "Slack" },
    { action: "launch", name: "WeChat" }
  ]);
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
