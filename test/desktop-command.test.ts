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
      windows: [
        {
          ownerName: "WeChat",
          windowName: "WeChat",
          bounds: { x: 100, y: 40, width: 900, height: 700, centerX: 550, centerY: 390 }
        }
      ],
      accessibility: {
        appName: "WeChat",
        windows: [
          {
            ownerName: "WeChat",
            windowName: "WeChat",
            bounds: { x: 100, y: 40, width: 900, height: 700, centerX: 550, centerY: 390 }
          }
        ],
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
        bounds: { x: 420, y: 640, width: 260, height: 32, centerX: 550, centerY: 656 },
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
        bounds: { x: 760, y: 640, width: 70, height: 32, centerX: 795, centerY: 656 },
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

test("collectDesktopProbe can analyze a target app even when the current frontmost app is different", async () => {
  const rootPath = await createTempDir("agentos-desktop-probe-");
  const workspace = createWorkspace(rootPath);
  const report = await collectDesktopProbe(
    {
      appName: "WeChat",
      packName: "wechat-desktop",
      workspaceName: workspace.name,
      sampleLimit: 4,
      timeoutMs: 800,
      requireAccessibility: true,
      waitReady: false
    },
    {
      workspace,
      adapter: {
        async focus() {
          return { focused: "WeChat" };
        },
        async observe() {
          return {
            version: 1,
            surface: "desktop",
            workspaceId: workspace.id,
            appContext: {
              appName: "Terminal",
              windows: [{ title: "Terminal" }],
              accessibilityCandidateCount: 0,
              ocrAvailable: true,
              ocrError: null
            },
            capture: null,
            ocrBlocks: [],
            interactionCandidates: [],
            visibleText: "Terminal\nagentos desktop probe",
            recentActions: [],
            summary: "Terminal",
            timestamp: new Date().toISOString()
          };
        },
        async inspectApp() {
          return {
            targetAppName: "WeChat",
            frontmostApp: "Terminal",
            windows: [
              {
                ownerName: "WeChat",
                windowName: "WeChat",
                bounds: { x: 100, y: 40, width: 900, height: 700, centerX: 550, centerY: 390 }
              }
            ],
            accessibility: {
              appName: "WeChat",
              windows: [
                {
                  ownerName: "WeChat",
                  windowName: "WeChat",
                  bounds: { x: 100, y: 40, width: 900, height: 700, centerX: 550, centerY: 390 }
                }
              ],
              elements: [{ id: "ax-1" }, { id: "ax-2" }]
            },
            accessibilityCandidateCount: 2,
            interactionCandidates: [
              {
                id: "wechat-thread",
                surface: "desktop",
                kind: "text",
                text: "未读: 李四",
                role: "button",
                bounds: { x: 10, y: 10, width: 150, height: 24, centerX: 85, centerY: 22 },
                confidence: 0.98,
                sourceHints: { source: "accessibility", ariaLabel: "未读会话 李四" },
                isInteractive: true
              },
              {
                id: "wechat-compose",
                surface: "desktop",
                kind: "text",
                text: "输入消息",
                role: "textbox",
                bounds: { x: 420, y: 640, width: 260, height: 32, centerX: 550, centerY: 656 },
                confidence: 0.98,
                sourceHints: { source: "accessibility", placeholder: "输入消息" },
                isInteractive: true
              }
            ],
            visibleText: "未读: 李四\n输入消息"
          };
        },
        async shutdown() {}
      }
    }
  );

  assert.equal(report.frontmostApp, "Terminal");
  assert.equal(report.targetAppInspection?.frontmostApp, "Terminal");
  assert.equal(report.targetAppInspection?.accessibilityCandidateCount, 2);
  assert.equal(report.packAnalysis?.foreground, false);
  assert.equal(report.packAnalysis?.unreadCandidate?.text, "未读: 李四");
  assert.equal(report.packAnalysis?.composeCandidate?.text, "输入消息");
});

test("collectDesktopProbe falls back to OCR world state when target app inspection has no usable signals", async () => {
  const rootPath = await createTempDir("agentos-desktop-probe-");
  const workspace = createWorkspace(rootPath);
  const report = await collectDesktopProbe(
    {
      appName: "WeChat",
      packName: "wechat-desktop",
      workspaceName: workspace.name,
      sampleLimit: 4,
      timeoutMs: 800,
      requireAccessibility: true,
      waitReady: false
    },
    {
      workspace,
      adapter: {
        async focus() {
          return { focused: "WeChat" };
        },
        async observe() {
          return {
            version: 1,
            surface: "desktop",
            workspaceId: workspace.id,
            appContext: {
              appName: "WeChat",
              windows: [
                {
                  ownerName: "WeChat",
                  windowName: "WeChat",
                  bounds: { x: 0, y: 0, width: 900, height: 700, centerX: 450, centerY: 350 }
                }
              ],
              accessibilityCandidateCount: 0,
              ocrAvailable: true,
              ocrError: null
            },
            capture: null,
            ocrBlocks: [],
            interactionCandidates: [
              {
                id: "wechat-thread-ocr",
                surface: "desktop",
                kind: "text",
                text: "Official Accounts",
                role: "text",
                bounds: { x: 120, y: 140, width: 180, height: 28, centerX: 210, centerY: 154 },
                confidence: 0.97,
                sourceHints: { source: "ocr" },
                isInteractive: true
              }
            ],
            visibleText: "Official Accounts\n03/11\nhttps://apps.apple.co..\n",
            recentActions: [],
            summary: "WeChat OCR capture",
            timestamp: new Date().toISOString()
          };
        },
        async inspectApp() {
          return {
            targetAppName: "WeChat",
            frontmostApp: "WeChat",
            accessibility: { elements: [] },
            accessibilityCandidateCount: 0,
            interactionCandidates: [],
            visibleText: ""
          };
        },
        async shutdown() {}
      }
    }
  );

  assert.equal(report.packAnalysis?.foreground, true);
  assert.equal(report.packAnalysis?.unreadCandidate?.text, "Official Accounts");
  assert.equal(report.packAnalysis?.topUnreadCandidates[0]?.text, "Official Accounts");
});

test("collectDesktopProbe does not treat message-count body text as a WeChat composer candidate", async () => {
  const rootPath = await createTempDir("agentos-desktop-probe-");
  const workspace = createWorkspace(rootPath);
  const report = await collectDesktopProbe(
    {
      appName: "WeChat",
      packName: "wechat-desktop",
      workspaceName: workspace.name,
      sampleLimit: 4,
      timeoutMs: 800,
      requireAccessibility: false,
      waitReady: false
    },
    {
      workspace,
      adapter: {
        async focus() {
          return { focused: "WeChat" };
        },
        async observe() {
          return {
            version: 1,
            surface: "desktop",
            workspaceId: workspace.id,
            appContext: {
              appName: "WeChat",
              windows: [
                {
                  ownerName: "WeChat",
                  windowName: "WeChat",
                  windowNumber: 11,
                  bounds: { x: 0, y: 0, width: 900, height: 700, centerX: 450, centerY: 350 }
                }
              ],
              captureWindowNumber: 11,
              accessibilityCandidateCount: 0,
              ocrAvailable: true,
              ocrError: null
            },
            capture: null,
            ocrBlocks: [],
            interactionCandidates: [
              {
                id: "wechat-thread",
                surface: "desktop",
                kind: "text",
                text: "Tan",
                role: "text",
                bounds: { x: 220, y: 170, width: 60, height: 24, centerX: 250, centerY: 182 },
                confidence: 0.96,
                sourceHints: { source: "ocr-wechat-list" },
                isInteractive: true
              },
              {
                id: "wechat-body-summary",
                surface: "desktop",
                kind: "text",
                text: "25P5 #Jit: [Video] 4 message(s)",
                role: "text",
                bounds: { x: 620, y: 150, width: 320, height: 28, centerX: 780, centerY: 164 },
                confidence: 0.92,
                sourceHints: { source: "ocr" },
                isInteractive: true
              }
            ],
            visibleText: "Tan\n25P5 #Jit: [Video] 4 message(s)",
            recentActions: [],
            summary: "WeChat body text without visible composer",
            timestamp: new Date().toISOString()
          };
        },
        async shutdown() {}
      }
    }
  );

  assert.equal(report.packAnalysis?.foreground, true);
  assert.equal(report.packAnalysis?.unreadCandidate?.text, "Tan");
  assert.equal(report.packAnalysis?.composeCandidate, null);
});
