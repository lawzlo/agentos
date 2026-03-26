import test from "node:test";
import assert from "node:assert/strict";

import { LivePackRegistry, detectBrowserManualIntervention } from "../src/runtime/live-pack-registry.js";
import { SurfaceRegistry } from "../src/runtime/surface-registry.js";
import type { WatchRule, WorkspaceProfile, WorldState } from "../src/types/runtime-schema.js";

function makeRule(startUrl = "https://app.example.com"): WatchRule {
  const timestamp = new Date().toISOString();
  return {
    id: "watch-test",
    goal: "Always watch this app",
    enabled: true,
    status: "watching",
    preferredSurface: "browser",
    workspaceName: "test-workspace",
    skillName: null,
    appTarget: null,
    livePack: "slack-browser",
    pollIntervalMs: 1000,
    watchProfile: {
      executionMode: "planned"
    },
    taskInputs: {
      startUrl
    },
    dedupeState: {},
    lastObservedAt: null,
    lastTriggeredAt: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function makeBossRule(startUrl = "https://www.zhipin.com/web/geek/chat"): WatchRule {
  return {
    ...makeRule(startUrl),
    goal: "Find the first unread candidate and prefill a reply in the current tab",
    preferredSurface: "browser",
    livePack: "boss-browser"
  };
}

function makeWorkspace(): WorkspaceProfile {
  const timestamp = new Date().toISOString();
  return {
    id: "workspace-boss-browser",
    rootPath: "/tmp/boss-browser-main",
    profilePath: "/tmp/boss-browser-main/profile",
    downloadsPath: "/tmp/boss-browser-main/downloads",
    artifactsPath: "/tmp/boss-browser-main/artifacts",
    scratchPath: "/tmp/boss-browser-main/scratch",
    createdAt: timestamp,
    name: "boss-browser-main",
    metadata: {},
    updatedAt: timestamp
  };
}

test("detectBrowserManualIntervention identifies sign-in blockers", () => {
  const worldState = {
    version: 1,
    surface: "browser",
    workspaceId: "workspace-1",
    capture: null,
    recentActions: [],
    summary: null,
    timestamp: new Date().toISOString(),
    visibleText: "Slack sign in\nPlease sign in to continue to your workspace.",
    appContext: {
      url: "https://app.example.com/login"
    },
    interactionCandidates: [
      {
        id: "candidate-1",
        surface: "browser",
        kind: "target",
        bounds: { x: 0, y: 0, width: 10, height: 10, centerX: 5, centerY: 5 },
        text: "Sign in",
        role: "button",
        isInteractive: true,
        confidence: 0.9,
        sourceHints: {}
      }
    ],
    screenTextBlocks: []
  } as WorldState;

  const detection = detectBrowserManualIntervention({
    packName: "slack-browser",
    worldState,
    rule: makeRule()
  });

  assert.equal(detection?.metadata?.manualInterventionKind, "login");
  assert.match(String(detection?.summary ?? ""), /Slack/i);
  assert.match(String(detection?.metadata?.manualInterventionAction ?? ""), /sign in/i);
});

test("detectBrowserManualIntervention identifies verification blockers", () => {
  const worldState = {
    version: 1,
    surface: "browser",
    workspaceId: "workspace-1",
    capture: null,
    recentActions: [],
    summary: null,
    timestamp: new Date().toISOString(),
    visibleText: "Security check\nPlease complete the CAPTCHA to continue.",
    appContext: {
      url: "https://app.example.com/check"
    },
    interactionCandidates: [
      {
        id: "candidate-1",
        surface: "browser",
        kind: "target",
        bounds: { x: 0, y: 0, width: 10, height: 10, centerX: 5, centerY: 5 },
        text: "I am human",
        role: "button",
        isInteractive: true,
        confidence: 0.9,
        sourceHints: {}
      }
    ],
    screenTextBlocks: []
  } as WorldState;

  const detection = detectBrowserManualIntervention({
    packName: "generic-mail-browser",
    worldState,
    rule: makeRule("https://mail.example.com")
  });

  assert.equal(detection?.metadata?.manualInterventionKind, "verification");
  assert.match(String(detection?.metadata?.manualInterventionDetail ?? ""), /verification|CAPTCHA/i);
});

test("boss browser detectNewItems uses generic browserExtract conversation detection", async () => {
  const registry = new LivePackRegistry();
  const pack = registry.get("boss-browser");
  assert.ok(pack);

  const browserActs: Array<Record<string, unknown>> = [];
  const surfaceRegistry = new SurfaceRegistry({
    browser: {
      name: "browser",
      async act(args: { step?: { action?: string; params?: Record<string, unknown> } }) {
        browserActs.push({
          action: args.step?.action,
          params: args.step?.params ?? {}
        });
        return {
          extracted: {
            hasUnreadConversation: true,
            summary: "Lazaro Waters",
            senderName: "Lazaro Waters",
            latestInboundMessage: "Curious, are you using AWS or Google Cloud?",
            salientContext: [
              "We help funded startups stretch runway with cloud credits."
            ],
            threadSummary: "Lazaro Waters",
            replyable: true,
            pageState: "conversation_list",
            blocker: null,
            rationale: "first unread conversation"
          }
        };
      },
      async shutdown() {}
    } as never
  });

  const detection = await pack.detectNewItems({
    rule: makeBossRule(),
    worldState: {
      version: 1,
      surface: "browser",
      workspaceId: "workspace-1",
      capture: null,
      recentActions: [],
      summary: "BOSS chat list",
      timestamp: new Date().toISOString(),
      visibleText: "BOSS直聘\nLazaro Waters\n未读",
      appContext: {
        title: "BOSS直聘",
        url: "https://www.zhipin.com/web/geek/chat"
      },
      interactionCandidates: [],
      screenTextBlocks: []
    } as WorldState,
    workspace: makeWorkspace(),
    surfaceRegistry,
    controlPlane: {} as never,
    dedupeState: {}
  });

  assert.equal(browserActs.length, 1);
  assert.equal(browserActs[0]?.action, "browserExtract");
  assert.match(String((browserActs[0]?.params as Record<string, unknown>)?.instruction ?? ""), /without clicking or navigating/i);
  assert.equal(detection?.summary, "Lazaro Waters");
  assert.equal(detection?.metadata?.sender, "Lazaro Waters");
  assert.equal(detection?.metadata?.latestInboundMessage, "Curious, are you using AWS or Google Cloud?");
});

test("boss browser extractContext emits a generic browserExecute task spec", async () => {
  const registry = new LivePackRegistry();
  const pack = registry.get("boss-browser");
  assert.ok(pack);

  const extracted = await pack.extractContext({
    rule: makeBossRule(),
    detection: {
      summary: "Lazaro Waters",
      context: [
        "Curious, are you using AWS or Google Cloud?",
        "We help funded startups stretch runway with cloud credits."
      ],
      inputs: {
        startUrl: "https://www.zhipin.com/web/geek/chat",
        openTarget: "Lazaro Waters"
      },
      metadata: {
        sender: "Lazaro Waters",
        latestInboundMessage: "Curious, are you using AWS or Google Cloud?"
      }
    } as never,
    workspace: makeWorkspace(),
    surfaceRegistry: new SurfaceRegistry({ browser: { name: "browser", async shutdown() {} } as never }),
    controlPlane: {} as never,
    worldState: null
  });

  assert.equal(extracted?.taskSpec?.preferredSurface, "browser");
  assert.equal(extracted?.taskSpec?.executionMode, "planned");
  assert.equal(extracted?.taskSpec?.steps?.[0]?.action, "browserExecute");
  assert.equal(extracted?.taskSpec?.steps?.[0]?.params?.allowNewTabs, false);
  assert.equal(extracted?.taskSpec?.steps?.[0]?.params?.allowCrossOriginNavigation, false);
  assert.equal(extracted?.taskSpec?.steps?.[0]?.expect?.textVisible, "{{typeTextSuffixPreview}}");
  assert.match(String(extracted?.taskSpec?.inputs?.browserInstruction ?? ""), /Do not open a new tab, popup, or window/i);
  assert.match(String(extracted?.taskSpec?.inputs?.browserInstruction ?? ""), /\{\{typeText\}\}/);
  assert.match(String(extracted?.taskSpec?.inputs?.browserInstruction ?? ""), /Lazaro Waters/);
});
