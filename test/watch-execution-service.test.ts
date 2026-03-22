import test from "node:test";
import assert from "node:assert/strict";

import { WatchExecutionService } from "../src/runtime/watch-execution-service.js";
import { buildWatchHealth } from "../src/runtime/watch-presenters.js";
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

test("buildTaskSpecFromWatchRule forces explicit reply plans into planned mode and derives a preview for verification", () => {
  const service = createService();
  const watchRule = createWatchRule();

  const taskSpec = service.buildTaskSpecFromWatchRule(
    watchRule,
    {
      summary: "#general",
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
            action: "typeText",
            params: { text: "{{typeText}}" }
          }
        ]
      }
    },
    {
      replyText: "This is a longer reply body that should still expose a stable preview snippet for verification."
    }
  );

  assert.equal(taskSpec.executionMode, "planned");
  assert.equal(typeof taskSpec.inputs?.typeTextPreview, "string");
  assert.equal(String(taskSpec.inputs?.typeTextPreview).startsWith("This is a longer reply body"), true);
});

test("scan drafts a reply when explicit reply steps use the typeText placeholder", async () => {
  const timestamp = new Date().toISOString();
  let storedRule = createWatchRule();
  let createdTaskSpec: Record<string, unknown> | null = null;
  let draftReplyCalls = 0;

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
            action: "prefill",
            policy: "prefill_first",
            riskLevel: "normal",
            reasons: []
          };
        }
      },
      createTask(taskSpec: Record<string, unknown>) {
        createdTaskSpec = taskSpec;
        return {
          id: "task-prefill",
          status: "queued"
        };
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
      putWatchRule(nextRule: WatchRule) {
        storedRule = nextRule;
        return nextRule;
      }
    } as never,
    eventBus: {
      broadcast() {}
    } as never,
    livePackRegistry: {
      get() {
        return {
          activateWorkspace() {
            return Promise.resolve();
          },
          observeInbox() {
            return Promise.resolve({
              appName: "Slack",
              visibleText: ["#general", "hello"],
              candidates: [],
              raw: {}
            });
          },
          detectNewItems() {
            return Promise.resolve({
              summary: "#general",
              fingerprint: "item-1",
              taskSpec: {
                preferredSurface: "desktop",
                steps: [
                  {
                    label: "Type reply",
                    surface: "desktop",
                    action: "typeText",
                    params: { text: "{{typeText}}" }
                  }
                ]
              }
            });
          },
          draftReply() {
            draftReplyCalls += 1;
            return Promise.resolve({
              replyText: "Generated reply text",
              metadata: { source: "test" }
            });
          }
        };
      }
    } as never
  });

  await service.scan(storedRule.id);

  assert.equal(draftReplyCalls, 1);
  assert.equal((createdTaskSpec?.inputs as Record<string, unknown>)?.typeText, "Generated reply text");
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
  assert.equal(storedRule.dedupeState.lastNoTriggerReason, "extract_context_empty");
  assert.equal(storedRule.dedupeState.lastNoTriggerStage, "extract_context");
});

test("scan records no-trigger details for wechat desktop scans", async () => {
  const timestamp = new Date().toISOString();
  let storedRule = {
    ...createWatchRule(),
    appTarget: "WeChat",
    livePack: "wechat-desktop"
  } satisfies WatchRule;

  const service = new WatchExecutionService({
    controlPlane: {
      modelClient: {
        isConfigured() {
          return true;
        },
        supportsImageJson() {
          return false;
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
        throw new Error("createTask should not be called when detectNewItems returns null");
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
          name: "wechat-desktop",
          async observeInbox() {
            return {
              version: 1,
              surface: "desktop",
              workspaceId: "workspace-watch",
              appContext: { appName: "WeChat" },
              capture: null,
              ocrBlocks: [],
              interactionCandidates: [],
              visibleText: "WeChat",
              recentActions: [],
              summary: "WeChat",
              timestamp
            };
          },
          async detectNewItems() {
            return null;
          }
        };
      }
    } as never
  });

  await service.scan(storedRule.id);

  assert.equal(storedRule.status, "watching");
  assert.equal(storedRule.dedupeState.lastNoTriggerReason, "no_detection");
  assert.equal(storedRule.dedupeState.lastNoTriggerStage, "detect_items");
  assert.equal(storedRule.dedupeState.lastNoTriggerUnreadCandidate, null);
  assert.deepEqual(storedRule.dedupeState.lastNoTriggerTopUnread, []);
});

test("scan records stage details when a watch stage times out", async () => {
  const timestamp = new Date().toISOString();
  let storedRule = createWatchRule();

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
          return {
            ...rule,
            health: buildWatchHealth(rule)
          };
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
        throw new Error("createTask should not be called when detectNewItems times out");
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
            await new Promise((resolve) => setTimeout(resolve, 50));
            return null;
          }
        };
      }
    } as never,
    scanStageTimeoutMs: {
      detect_items: 10
    }
  });

  await service.scan(storedRule.id);

  assert.equal(storedRule.status, "backoff");
  assert.match(String(storedRule.lastError ?? ""), /detect_items timed out/i);
  assert.equal(storedRule.dedupeState.scanStage, "detect_items");
  assert.equal(storedRule.dedupeState.scanStageStatus, "failed");

  const health = buildWatchHealth(storedRule);
  assert.equal(health?.scanStage, "detect_items");
  assert.equal(health?.scanStageStatus, "failed");
  assert.equal(health?.scanStageTimeoutMs, 10);
});
