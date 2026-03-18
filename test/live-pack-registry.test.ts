import test from "node:test";
import assert from "node:assert/strict";

import { detectBrowserManualIntervention } from "../src/runtime/live-pack-registry.js";
import type { WatchRule, WorldState } from "../src/types/runtime-schema.js";

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
    ocrBlocks: []
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
    ocrBlocks: []
  } as WorldState;

  const detection = detectBrowserManualIntervention({
    packName: "generic-mail-browser",
    worldState,
    rule: makeRule("https://mail.example.com")
  });

  assert.equal(detection?.metadata?.manualInterventionKind, "verification");
  assert.match(String(detection?.metadata?.manualInterventionDetail ?? ""), /verification|CAPTCHA/i);
});
