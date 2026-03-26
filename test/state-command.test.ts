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
            source: "screen-wechat-list",
            score: 31,
            hints: []
          },
          composeCandidate: {
            id: "compose",
            text: "输入",
            role: "text",
            interactive: true,
            source: "screen-wechat-compose",
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
              source: "screen-wechat-list",
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
          screenTextBlocks: [],
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

test("collectSurfaceState uses pack defaults to open browser workspaces and classify URL-only sign-in pages", async () => {
  const request: SurfaceStateRequest = {
    surface: "browser",
    appName: null,
    packName: "slack-browser",
    workspaceName: "state-slack-browser-default-url",
    sampleLimit: 5,
    timeoutMs: 1500,
    requireAccessibility: false,
    waitReady: false,
    url: null,
    browserProfilePath: null
  };

  let openedUrl: string | null = null;
  const report = await collectSurfaceState(request, {
    browserAdapter: {
      async act({ step }) {
        openedUrl = String(step.params?.url ?? "");
        return { ok: true };
      },
      async observe() {
        return {
          version: 1,
          surface: "browser",
          workspaceId: "workspace-state-browser",
          appContext: {
            title: "Slack",
            url: "https://app.slack.com/workspace-signin?redir=%2Fclient"
          },
          capture: null,
          screenTextBlocks: [],
          interactionCandidates: [],
          visibleText: "",
          recentActions: [],
          summary: "Slack",
          timestamp: new Date().toISOString()
        };
      },
      async shutdown() {}
    }
  });

  assert.equal(openedUrl, "https://app.slack.com/client");
  assert.equal(report.readinessState, "blocked_signin");
  assert.equal(report.scene, "signin");
  assert.equal(report.manualIntervention?.kind, "login");
});

test("collectSurfaceState opens boss chat by default and treats expired sessions as blocked sign-in", async () => {
  const request: SurfaceStateRequest = {
    surface: "browser",
    appName: null,
    packName: "boss-browser",
    workspaceName: "state-boss-browser-default-url",
    sampleLimit: 5,
    timeoutMs: 1500,
    requireAccessibility: false,
    waitReady: false,
    url: null,
    browserProfilePath: null
  };

  let openedUrl: string | null = null;
  const report = await collectSurfaceState(request, {
    browserAdapter: {
      async act({ step }) {
        openedUrl = String(step.params?.url ?? "");
        return { ok: true };
      },
      async observe() {
        return {
          version: 1,
          surface: "browser",
          workspaceId: "workspace-state-browser",
          appContext: {
            title: "BOSS直聘",
            url: "https://www.zhipin.com/web/geek/chat"
          },
          capture: null,
          screenTextBlocks: [],
          interactionCandidates: [],
          visibleText: "全部\n未读\n当前暂无消息\n当前登录状态已失效",
          recentActions: [],
          summary: "BOSS直聘",
          timestamp: new Date().toISOString()
        };
      },
      async shutdown() {}
    }
  });

  assert.equal(openedUrl, "https://www.zhipin.com/web/geek/chat");
  assert.equal(report.readinessState, "blocked_signin");
  assert.equal(report.scene, "signin");
  assert.equal(report.manualIntervention?.kind, "session_expired");
  assert.deepEqual(report.skipReasons, ["blocked_signin"]);
  assert.equal(report.recoverySuggested, "complete_signin");
});

test("collectSurfaceState returns browser_unavailable when no supported browser app can be focused", async () => {
  const request: SurfaceStateRequest = {
    surface: "browser",
    appName: null,
    packName: "boss-browser",
    workspaceName: "state-boss-browser-missing-cdp",
    sampleLimit: 5,
    timeoutMs: 1500,
    requireAccessibility: false,
    waitReady: false,
    url: "https://www.zhipin.com/web/geek/chat",
    browserProfilePath: null
  };

  const report = await collectSurfaceState(request, {
    browserAdapter: {
      async act() {
        throw new Error("Browser app unavailable: could not focus Google Chrome, Chromium, Microsoft Edge.");
      },
      async observe() {
        throw new Error("observe should not be reached when browser app focus is missing");
      },
      async shutdown() {}
    }
  });

  assert.equal(report.ready, false);
  assert.equal(report.readinessState, "browser_unavailable");
  assert.deepEqual(report.blockers, ["browser_unavailable"]);
  assert.deepEqual(report.skipReasons, ["browser_unavailable"]);
  assert.equal(report.recoverySuggested, "takeover");
});

test("collectSurfaceState treats empty browser shells as needs_takeover instead of no_visible_thread", async () => {
  const request: SurfaceStateRequest = {
    surface: "browser",
    appName: null,
    packName: "generic-mail-browser",
    workspaceName: "state-mail-browser-empty-shell",
    sampleLimit: 5,
    timeoutMs: 1500,
    requireAccessibility: false,
    waitReady: false,
    url: "https://outlook.office.com/mail/",
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
            title: "Outlook",
            url: "https://outlook.office.com/mail/"
          },
          capture: null,
          screenTextBlocks: [],
          interactionCandidates: [],
          visibleText: "",
          recentActions: [],
          summary: "Outlook",
          timestamp: new Date().toISOString()
        };
      },
      async shutdown() {}
    }
  });

  assert.equal(report.readinessState, "needs_takeover");
  assert.deepEqual(report.blockers, ["needs_takeover"]);
  assert.deepEqual(report.skipReasons, ["needs_takeover"]);
  assert.equal(report.recoverySuggested, "takeover");
});
