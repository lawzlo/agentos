import test from "node:test";
import assert from "node:assert/strict";

import { collectSurfaceState, type SurfaceStateRequest } from "../bin/commands/state-command.js";
import type { DesktopProbeReport } from "../bin/commands/desktop-command.js";

test("collectSurfaceState reports a ready desktop conversation surface with candidates and composer state", async () => {
  const request: SurfaceStateRequest = {
    surface: "desktop",
    appName: "WeChat",
    packName: "wechat-desktop",
    workspaceName: "state-wechat",
    sampleLimit: 5,
    timeoutMs: 1500,
    requireAccessibility: false,
    waitReady: false,
    url: null,
    browserProfilePath: null
  };

  const report = await collectSurfaceState(request, {
    desktopProbe: async () =>
      ({
        request: {
          appName: "WeChat",
          packName: "wechat-desktop",
          workspaceName: "state-wechat",
          sampleLimit: 5,
          timeoutMs: 1500,
          requireAccessibility: false,
          waitReady: false
        },
        readiness: null,
        frontmostApp: "WeChat",
        windowCount: 1,
        accessibilityElementCount: 0,
        accessibilityCandidateCount: 0,
        ocrBlockCount: 3,
        ocrAvailable: true,
        ocrError: null,
        capturePath: "/tmp/wechat-state.png",
        visibleTextPreview: ["微信", "Official Accounts", "输入"],
        topCandidates: [],
        targetAppInspection: null,
        packAnalysis: {
          packName: "wechat-desktop",
          foreground: true,
          unreadCandidate: {
            id: "thread",
            text: "Official Accounts",
            role: "text",
            interactive: true,
            source: "ocr-wechat-list",
            score: 31,
            hints: []
          },
          composeCandidate: {
            id: "compose",
            text: "输入",
            role: "text",
            interactive: true,
            source: "ocr-wechat-compose",
            score: 14,
            hints: []
          },
          sendCandidate: null,
          topUnreadCandidates: [
            {
              id: "thread",
              text: "Official Accounts",
              role: "text",
              interactive: true,
              source: "ocr-wechat-list",
              score: 31,
              hints: []
            }
          ]
        }
      }) satisfies DesktopProbeReport
  });

  assert.equal(report.ready, true);
  assert.equal(report.readinessState, "ready");
  assert.deepEqual(report.blockers, []);
  assert.equal(report.runnerType, "desktop_vlm");
  assert.equal(report.scene, "thread");
  assert.equal(report.selectedTarget, "Official Accounts");
  assert.deepEqual(report.skipReasons, []);
  assert.equal(report.recoverySuggested, null);
  assert.equal(report.threadCandidates[0]?.text, "Official Accounts");
  assert.equal(report.composeCandidate?.text, "输入");
});

test("collectSurfaceState maps browser sign-in pages into explicit blockers", async () => {
  const request: SurfaceStateRequest = {
    surface: "browser",
    appName: null,
    packName: "slack-browser",
    workspaceName: "state-slack-browser",
    sampleLimit: 5,
    timeoutMs: 1500,
    requireAccessibility: false,
    waitReady: false,
    url: "https://app.slack.com/client",
    browserProfilePath: null
  };

  const report = await collectSurfaceState(request, {
    browserAdapter: {
      async act() {
        return { ok: true };
      },
      async observe() {
        return {
          version: 1,
          surface: "browser",
          workspaceId: "workspace-state-browser",
          appContext: {
            title: "Sign in to Slack",
            url: "https://app.slack.com/client"
          },
          capture: null,
          ocrBlocks: [],
          interactionCandidates: [],
          visibleText: "Slack\nSign in to Slack\nContinue with Google",
          recentActions: [],
          summary: "Sign in to Slack",
          timestamp: new Date().toISOString()
        };
      },
      async shutdown() {}
    }
  });

  assert.equal(report.ready, false);
  assert.equal(report.readinessState, "blocked_signin");
  assert.deepEqual(report.blockers, ["blocked_signin"]);
  assert.equal(report.runnerType, "browser_native");
  assert.equal(report.scene, "signin");
  assert.equal(report.recoverySuggested, "complete_signin");
  assert.deepEqual(report.skipReasons, ["blocked_signin"]);
  assert.equal(report.manualIntervention?.kind, "login");
});
