import test from "node:test";
import assert from "node:assert/strict";

import { createTempDir } from "./helpers.js";
import { collectDesktopProbe, type DesktopProbeRequest } from "../bin/commands/desktop-command.js";
import type { WorkspaceProfile, WorldState } from "../src/types/runtime-schema.js";

function createWorkspace(rootPath: string): WorkspaceProfile {
  const timestamp = new Date().toISOString();
  return {
    id: "workspace-probe",
    name: "desktop-probe-test",
    rootPath,
    profilePath: `${rootPath}/profile`,
    downloadsPath: `${rootPath}/downloads`,
    artifactsPath: `${rootPath}/artifacts`,
    scratchPath: `${rootPath}/scratch`,
    metadata: {},
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

test("collectDesktopProbe summarizes a WeChat world state and pack analysis", async () => {
  const rootPath = await createTempDir("agentos-desktop-probe-");
  const workspace = createWorkspace(rootPath);
  const focusCalls: string[] = [];
  const readinessCalls: string[] = [];
  const worldState: WorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: workspace.id,
    appContext: {
      appName: "WeChat",
      windows: [{ title: "WeChat" }],
      accessibility: {
        appName: "WeChat",
        windows: [{ title: "WeChat" }],
        elements: [{ id: "ax-1" }, { id: "ax-2" }, { id: "ax-3" }]
      },
      accessibilityCandidateCount: 3,
      ocrAvailable: true,
      ocrError: null
    },
    capture: {
      id: "artifact-1",
      taskId: "probe-1",
      traceId: null,
      kind: "screenshot",
      label: "Desktop probe",
      path: `${rootPath}/artifacts/probe.png`,
      metadata: {},
      createdAt: new Date().toISOString()
    },
    ocrBlocks: [
      {
        id: "ocr-1",
        text: "微信",
        confidence: 0.98,
        bounds: { x: 0, y: 0, width: 100, height: 20, centerX: 50, centerY: 10 }
      }
    ],
    interactionCandidates: [
      {
        id: "thread-zhangsan",
        surface: "desktop",
        kind: "text",
        text: "未读: 张三",
        role: "button",
        bounds: { x: 10, y: 10, width: 160, height: 24, centerX: 90, centerY: 22 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", ariaLabel: "未读会话 张三", actions: ["AXPress"] },
        isInteractive: true
      },
      {
        id: "compose",
        surface: "desktop",
        kind: "text",
        text: "输入消息",
        role: "textbox",
        bounds: { x: 10, y: 210, width: 240, height: 32, centerX: 130, centerY: 226 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", placeholder: "输入消息", actions: ["AXPress"] },
        isInteractive: true
      },
      {
        id: "send",
        surface: "desktop",
        kind: "text",
        text: "发送",
        role: "button",
        bounds: { x: 260, y: 210, width: 60, height: 32, centerX: 290, centerY: 226 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", actions: ["AXPress"] },
        isInteractive: true
      }
    ],
    visibleText: "微信\n最近聊天\n未读\n张三\n客户: 明天下午方便吗？\n输入消息\n发送",
    recentActions: [],
    summary: "WeChat unread list",
    timestamp: new Date().toISOString()
  };

  const request: DesktopProbeRequest = {
    appName: "WeChat",
    packName: "wechat-desktop",
    workspaceName: workspace.name,
    sampleLimit: 5,
    timeoutMs: 1200,
    requireAccessibility: true,
    waitReady: true
  };

  const report = await collectDesktopProbe(request, {
    workspace,
    adapter: {
      async focus({ step }) {
        focusCalls.push(String(step?.params?.name ?? ""));
        return { focused: step?.params?.name };
      },
      async waitForAppReady({ appName }) {
        readinessCalls.push(appName);
        return {
          ready: true,
          frontmostApp: appName,
          accessibilityCandidateCount: 3
        };
      },
      async observe() {
        return worldState;
      },
      async shutdown() {}
    }
  });

  assert.deepEqual(focusCalls, ["WeChat"]);
  assert.deepEqual(readinessCalls, ["WeChat"]);
  assert.equal(report.frontmostApp, "WeChat");
  assert.equal(report.accessibilityElementCount, 3);
  assert.equal(report.accessibilityCandidateCount, 3);
  assert.equal(report.packAnalysis?.foreground, true);
  assert.equal(report.packAnalysis?.unreadCandidate?.text, "未读: 张三");
  assert.equal(report.packAnalysis?.composeCandidate?.text, "输入消息");
  assert.equal(report.packAnalysis?.sendCandidate?.text, "发送");
  assert.equal(report.packAnalysis?.topUnreadCandidates[0]?.text, "未读: 张三");
  assert.equal(report.topCandidates[0]?.text, "未读: 张三");
});

test("collectDesktopProbe can inspect raw desktop state without a pack analysis", async () => {
  const rootPath = await createTempDir("agentos-desktop-probe-");
  const workspace = createWorkspace(rootPath);
  const worldState: WorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: workspace.id,
    appContext: {
      appName: "Terminal",
      windows: [{ title: "Terminal" }],
      accessibilityCandidateCount: 0,
      ocrAvailable: false,
      ocrError: "OCR unavailable"
    },
    capture: null,
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Terminal\nnpm test",
    recentActions: [],
    summary: "Terminal",
    timestamp: new Date().toISOString()
  };

  const report = await collectDesktopProbe(
    {
      appName: "Terminal",
      packName: null,
      workspaceName: workspace.name,
      sampleLimit: 3,
      timeoutMs: 500,
      requireAccessibility: false,
      waitReady: false
    },
    {
      workspace,
      adapter: {
        async focus() {
          return { focused: "Terminal" };
        },
        async observe() {
          return worldState;
        },
        async shutdown() {}
      }
    }
  );

  assert.equal(report.readiness, null);
  assert.equal(report.packAnalysis, null);
  assert.equal(report.frontmostApp, "Terminal");
  assert.equal(report.ocrAvailable, false);
  assert.equal(report.visibleTextPreview[0], "Terminal");
});
