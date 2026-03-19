import test from "node:test";
import assert from "node:assert/strict";

import { WatchExecutionService } from "../src/runtime/watch-execution-service.js";
import type { WatchRule } from "../src/types/runtime-schema.js";

function createService() {
  return new WatchExecutionService({
    controlPlane: {
      modelClient: {
        isConfigured() {
          return true;
        }
      }
    } as never,
    store: {} as never,
    eventBus: {
      broadcast() {}
    } as never,
    livePackRegistry: {} as never
  });
}

function createWatchRule(): WatchRule {
  const timestamp = new Date().toISOString();
  return {
    id: "watch-prefill-test",
    goal: "Always watch desktop chat threads and reply",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "desktop-main",
    skillName: null,
    appTarget: "Slack",
    livePack: "slack-desktop",
    pollIntervalMs: 15000,
    watchProfile: {
      executionMode: "autonomous"
    },
    taskInputs: {},
    dedupeState: {},
    lastObservedAt: null,
    lastTriggeredAt: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

test("buildTaskSpecFromWatchRule strips explicit send steps when autoSend is false", () => {
  const service = createService();
  const watchRule = createWatchRule();

  const taskSpec = service.buildTaskSpecFromWatchRule(
    watchRule,
    {
      summary: "#general",
      inputs: {
        openTarget: "#general",
        typeTarget: "Message #general",
        sendTarget: "Send"
      },
      taskSpec: {
        preferredSurface: "desktop",
        steps: [
          {
            label: "Open thread",
            surface: "desktop",
            action: "clickTarget",
            params: { targetQuery: "{{openTarget}}" }
          },
          {
            label: "Type reply",
            surface: "desktop",
            action: "typeIntoTarget",
            params: { targetQuery: "{{typeTarget}}", text: "{{typeText}}" }
          },
          {
            label: "Send reply",
            surface: "desktop",
            action: "clickTarget",
            params: { targetQuery: "{{sendTarget}}" }
          }
        ]
      }
    },
    {
      replyText: "Prefilled but unsent",
      autoSend: false
    }
  );

  assert.equal(taskSpec.inputs?.autoSend, false);
  assert.equal(taskSpec.steps?.length, 2);
  assert.equal(taskSpec.steps?.some((step) => /send/i.test(String(step.label ?? ""))), false);
});

test("buildTaskSpecFromWatchRule keeps explicit send steps when autoSend is true", () => {
  const service = createService();
  const watchRule = createWatchRule();

  const taskSpec = service.buildTaskSpecFromWatchRule(
    watchRule,
    {
      summary: "#general",
      inputs: {
        openTarget: "#general",
        typeTarget: "Message #general",
        sendTarget: "Send"
      },
      taskSpec: {
        preferredSurface: "desktop",
        steps: [
          {
            label: "Open thread",
            surface: "desktop",
            action: "clickTarget",
            params: { targetQuery: "{{openTarget}}" }
          },
          {
            label: "Type reply",
            surface: "desktop",
            action: "typeIntoTarget",
            params: { targetQuery: "{{typeTarget}}", text: "{{typeText}}" }
          },
          {
            label: "Send reply",
            surface: "desktop",
            action: "clickTarget",
            params: { targetQuery: "{{sendTarget}}" }
          }
        ]
      }
    },
    {
      replyText: "Send immediately",
      autoSend: true
    }
  );

  assert.equal(taskSpec.inputs?.autoSend, true);
  assert.equal(taskSpec.steps?.length, 3);
  assert.equal(taskSpec.steps?.some((step) => /send/i.test(String(step.label ?? ""))), true);
});

test("scan skips a watch trigger when extractContext cannot produce a stable reply context", async () => {
  const timestamp = new Date().toISOString();
  let storedRule = createWatchRule();
  let createTaskCalls = 0;

  const service = new WatchExecutionService({
    controlPlane: {
      modelClient: {
        isConfigured() {
          return true;
        }
      },
      surfaceRegistry: {},
      workspaceManager: {
        async prepareProfile() {
          return {
            id: "profile-watch",
            name: "desktop-main",
            rootPath: "/tmp/desktop-main",
            profilePath: "/tmp/desktop-main/profile",
            downloadsPath: "/tmp/desktop-main/downloads",
            artifactsPath: "/tmp/desktop-main/artifacts",
            scratchPath: "/tmp/desktop-main/scratch",
            metadata: {},
            createdAt: timestamp,
            updatedAt: timestamp
          };
        }
      },
      watchService: {
        decorate(rule: WatchRule) {
          return rule;
        }
      },
      policyEngine: {
        evaluateAutomation() {
          return {
            action: "draft",
            policy: "draft_only",
            riskLevel: "normal",
            reasons: []
          };
        }
      },
      createTask() {
        createTaskCalls += 1;
        throw new Error("createTask should not be called when extractContext returns null");
      }
    } as never,
    store: {
      getWatchRule() {
        return storedRule;
      },
      getTask() {
        return null;
      },
      getDraft() {
        return null;
      },
      putWatchRule(rule: WatchRule) {
        storedRule = rule;
        return rule;
      }
    } as never,
    eventBus: {
      broadcast() {}
    } as never,
    livePackRegistry: {
      get() {
        return {
          name: "slack-desktop",
          async observeInbox() {
            return {
              version: 1,
              surface: "desktop",
              workspaceId: "workspace-watch",
              appContext: { appName: "Slack" },
              capture: null,
              ocrBlocks: [],
              interactionCandidates: [],
              visibleText: "Slack",
              recentActions: [],
              summary: "Slack",
              timestamp
            };
          },
          async detectNewItems() {
            return {
              summary: "#general",
              inputs: {
                openTarget: "#general"
              }
            };
          },
          async extractContext() {
            return null;
          }
        };
      }
    } as never
  });

  await service.scan(storedRule.id);

  assert.equal(createTaskCalls, 0);
  assert.equal(storedRule.status, "watching");
  assert.equal(storedRule.lastError, null);
});
