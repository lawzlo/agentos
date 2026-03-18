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

function createObserveAdapter() {
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
    dataDir: "/tmp/agentos-test"
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
