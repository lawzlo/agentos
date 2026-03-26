import test from "node:test";
import assert from "node:assert/strict";

import { WatchExecutionService } from "../src/runtime/watch-execution-service.js";
import { buildWatchHealth } from "../src/runtime/watch-presenters.js";
import type { WatchRule } from "../src/types/runtime-schema.js";

function createSurfaceCoordinator() {
  return {
    async withWatchScanSession(
      request: { surface: "browser" | "desktop" },
      fn: (session: {
        surface: "browser" | "desktop";
        surfaceKey: string;
        adapter: Record<string, unknown>;
        surfaceRegistry: Record<string, unknown>;
        lease: Record<string, unknown>;
      }) => Promise<unknown>
    ) {
      return fn({
        surface: request.surface,
        surfaceKey: request.surface === "desktop" ? "desktop-global" : "browser-workspace:test",
        adapter: {},
        surfaceRegistry: {
          get() {
            return {};
          }
        },
        lease: {
          id: "lease-watch",
          surfaceKey: request.surface === "desktop" ? "desktop-global" : "browser-workspace:test",
          holderId: "watch:test:scan",
          holderKind: "watch_scan",
          priority: "watch",
          taskId: null,
          watchId: "watch-prefill-test",
          workspaceKey: "desktop-main",
          reason: "watch scan",
          acquiredAt: new Date().toISOString()
        }
      });
    }
  } as never;
}

function createService() {
  return new WatchExecutionService({
    controlPlane: {
      modelClient: {
        isConfigured() {
          return true;
        }
      },
      surfaceCoordinator: createSurfaceCoordinator()
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

test("createModelBudget allows Outlook desktop watches to use the higher watch request budget", () => {
  const service = createService();
  const watchRule = {
    ...createWatchRule(),
    livePack: "outlook-desktop",
    appTarget: "Microsoft Outlook"
  } satisfies WatchRule;

  const budget = service.createModelBudget(watchRule);

  assert.equal(budget.maxRequests, 8);
});

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
      openTarget: "#general",
      replyText: "This is a longer reply body that should still expose a stable preview snippet for verification."
    }
  );

  assert.equal(taskSpec.executionMode, "planned");
  assert.equal(typeof taskSpec.inputs?.typeTextPreview, "string");
  assert.equal(String(taskSpec.inputs?.typeTextPreview).startsWith("This is a longer reply body"), true);
  assert.equal(typeof taskSpec.inputs?.typeTextMiddlePreview, "string");
  assert.equal(String(taskSpec.inputs?.typeTextMiddlePreview).includes("still expose a stable preview"), true);
  assert.equal(typeof taskSpec.inputs?.typeTextTailPreview, "string");
  assert.equal(String(taskSpec.inputs?.typeTextTailPreview).endsWith("snippet for verification."), true);
  assert.equal(typeof taskSpec.inputs?.typeTextSuffixPreview, "string");
  assert.equal(String(taskSpec.inputs?.typeTextSuffixPreview).endsWith("verification."), true);
});

test("buildTaskSpecFromWatchRule materializes embedded browser instruction templates before step expansion", () => {
  const service = createService();
  const watchRule = {
    ...createWatchRule(),
    preferredSurface: "browser",
    livePack: "boss-browser"
  } satisfies WatchRule;

  const taskSpec = service.buildTaskSpecFromWatchRule(
    watchRule,
    {
      summary: "Lazaro Waters",
      inputs: {
        startUrl: "https://www.zhipin.com/web/geek/chat",
        watchSummary: "Lazaro Waters",
        watchContext: "Curious, are you using AWS or Google Cloud?"
      },
      taskSpec: {
        preferredSurface: "browser",
        inputs: {
          browserInstruction:
            "Open the active conversation for {{watchSummary}} in the current tab and prefill exactly this reply without sending it:\n{{typeText}}\nContext:\n{{watchContext}}"
        },
        steps: [
          {
            label: "Run browser automation",
            surface: "browser",
            action: "browserExecute",
            params: {
              instruction: "{{browserInstruction}}",
              startUrl: "{{startUrl}}",
              maxSteps: 6
            },
            expect: {
              textVisible: "{{typeTextSuffixPreview}}"
            }
          }
        ]
      }
    },
    {
      replyText: "Thanks for your message. I can chat on Wednesday afternoon."
    }
  );

  assert.match(
    String(taskSpec.inputs?.browserInstruction ?? ""),
    /prefill exactly this reply without sending it:\nThanks for your message\./
  );
  assert.match(String(taskSpec.inputs?.browserInstruction ?? ""), /Lazaro Waters/);
  assert.match(
    String(taskSpec.steps?.[0]?.params?.instruction ?? ""),
    /Wednesday afternoon\.\nContext:\nCurious, are you using AWS or Google Cloud\?/
  );
  assert.equal(taskSpec.steps?.[0]?.action, "browserExecute");
  assert.equal(taskSpec.steps?.[0]?.params?.startUrl, "https://www.zhipin.com/web/geek/chat");
  assert.equal(taskSpec.steps?.[0]?.expect?.textVisible, String(taskSpec.inputs?.typeTextSuffixPreview ?? ""));
});

test("buildTaskSpecFromWatchRule rejects unresolved typeText placeholders", () => {
  const service = createService();
  const watchRule = createWatchRule();

  assert.throws(
    () =>
      service.buildTaskSpecFromWatchRule(watchRule, {
        summary: "#general",
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
      }),
    /unresolved template inputs: typeText/i
  );
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
      surfaceCoordinator: createSurfaceCoordinator(),
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

test("draftReply fallback stays English for an English thread even when the workspace UI contains Chinese", async () => {
  const service = new WatchExecutionService({
    controlPlane: {
      modelClient: {
        isConfigured() {
          return false;
        }
      }
    } as never,
    store: {} as never,
    eventBus: {
      broadcast() {}
    } as never,
    livePackRegistry: {} as never
  });

  const draft = await service.draftReply({
    watchRule: {
      ...createWatchRule(),
      goal: "Always watch Outlook and prefill replies"
    },
    detection: {
      summary: "Re: extend runway",
      context: [
        "Should I share info?",
        "Curious, are you using AWS or Google Cloud?",
        "收件箱"
      ]
    } as never,
    pack: null
  });

  assert.equal(draft.replyText, "Got it. I will follow up shortly.");
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
      surfaceCoordinator: createSurfaceCoordinator(),
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
              screenTextBlocks: [],
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
      surfaceCoordinator: createSurfaceCoordinator(),
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
              screenTextBlocks: [],
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
  assert.equal(storedRule.dedupeState.lastNoTriggerRunnerType, "desktop_vlm");
  assert.equal(storedRule.dedupeState.lastNoTriggerScene, "unknown");
  const skipReasons = Array.isArray(storedRule.dedupeState.lastNoTriggerSkipReasons)
    ? storedRule.dedupeState.lastNoTriggerSkipReasons.map((entry) => String(entry))
    : [];
  assert.equal(skipReasons.includes("no_visible_thread"), true);
  assert.equal(storedRule.dedupeState.lastNoTriggerUnreadCandidate, null);
  assert.deepEqual(storedRule.dedupeState.lastNoTriggerTopUnread, []);
});

test("scan records stage details when a watch stage times out", async () => {
  const timestamp = new Date().toISOString();
  let storedRule: WatchRule = {
    ...createWatchRule(),
    appTarget: "Mail",
    livePack: "mail-desktop"
  };

  const service = new WatchExecutionService({
    controlPlane: {
      modelClient: {
        isConfigured() {
          return true;
        }
      },
      surfaceRegistry: {},
      surfaceCoordinator: createSurfaceCoordinator(),
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
              screenTextBlocks: [],
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
  assert.equal(health?.runnerType, null);
  assert.equal(health?.scene, null);
  assert.deepEqual(health?.lastSkipReasons, []);
});

test("scan cools down repeated slack desktop no-trigger cycles", async () => {
  const timestamp = new Date().toISOString();
  let storedRule = createWatchRule();

  const service = new WatchExecutionService({
    controlPlane: {
      modelClient: {
        isConfigured() {
          return true;
        },
        createUsageBudget({ id, maxRequests }: { id: string; maxRequests: number }) {
          return {
            id,
            maxRequests,
            status: "ok" as const,
            usage: {
              requestCount: 0,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              estimatedCostUsd: null
            }
          };
        },
        async runWithUsageBudget<T>(_: unknown, work: () => Promise<T>) {
          return work();
        }
      },
      artifactStore: {
        async getUsage() {
          return {
            workspaceArtifactBytes: 0,
            workspaceArtifactLimitBytes: 500 * 1024 * 1024,
            globalArtifactBytes: 0,
            globalArtifactLimitBytes: 3 * 1024 * 1024 * 1024,
            prunedFiles: 0
          };
        }
      },
      surfaceRegistry: {},
      surfaceCoordinator: createSurfaceCoordinator(),
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
      draftService: {
        create() {
          throw new Error("drafts should not be created");
        }
      },
      listReplyStylePreferences() {
        return [];
      },
      createTask() {
        throw new Error("tasks should not be created");
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
          async detectNewItems() {
            return null;
          }
        };
      }
    } as never
  });

  await service.scan(storedRule.id);
  assert.equal(storedRule.dedupeState.surfaceHealth, "healthy");
  assert.equal(storedRule.dedupeState.repeatedNoTriggerCount, 1);

  await service.scan(storedRule.id);
  assert.equal(storedRule.dedupeState.surfaceHealth, "cooldown");
  assert.equal(storedRule.dedupeState.repeatedNoTriggerCount, 2);
  assert.ok(Number(storedRule.dedupeState.retryAfter ?? 0) > Date.now());

  const health = buildWatchHealth(storedRule);
  assert.equal(health?.surfaceHealth, "cooldown");
  assert.equal(health?.budgetStatus, "ok");
});

test("draft reply stage timeout honors the configured model timeout floor", () => {
  const service = new WatchExecutionService({
    controlPlane: {
      modelClient: {
        config: {
          timeoutMs: 45000
        },
        isConfigured() {
          return true;
        }
      },
      artifactStore: {
        async getUsage() {
          return {
            workspaceArtifactBytes: 0,
            workspaceArtifactLimitBytes: 500 * 1024 * 1024,
            globalArtifactBytes: 0,
            globalArtifactLimitBytes: 3 * 1024 * 1024 * 1024,
            prunedFiles: 0
          };
        }
      }
    } as never,
    store: {} as never,
    eventBus: {
      broadcast() {}
    } as never,
    livePackRegistry: {} as never
  });

  const slackRule = createWatchRule();
  const outlookRule: WatchRule = {
    ...createWatchRule(),
    livePack: "outlook-desktop",
    appTarget: "Microsoft Outlook"
  };
  const bossRule: WatchRule = {
    ...createWatchRule(),
    preferredSurface: "browser",
    appTarget: null,
    livePack: "boss-browser",
    workspaceName: "boss-browser-main"
  };

  assert.equal(service.scanStageTimeoutForRule(slackRule, "draft_reply"), 50000);
  assert.equal(service.scanStageTimeoutForRule(outlookRule, "draft_reply"), 50000);
  assert.equal(service.scanStageTimeoutForRule(outlookRule, "detect_items"), 90000);
  assert.equal(service.scanStageTimeoutForRule(bossRule, "activate_pack"), 20000);
  assert.equal(service.scanStageTimeoutForRule(bossRule, "extract_context"), 40000);
  assert.equal(service.scanStageTimeoutForRule(bossRule, "draft_reply"), 50000);
});

test("scan pauses when the storage guard threshold is exceeded", async () => {
  const timestamp = new Date().toISOString();
  const previousThreshold = process.env.AGENTOS_STORAGE_GUARD_MAX_USED_PERCENT;
  process.env.AGENTOS_STORAGE_GUARD_MAX_USED_PERCENT = "1";
  let storedRule = createWatchRule();
  let detectCalls = 0;

  try {
    const service = new WatchExecutionService({
      controlPlane: {
        modelClient: {
          isConfigured() {
            return true;
          },
          createUsageBudget() {
            return {
              id: "budget-storage-guard",
              maxRequests: 8,
              requestCount: 0,
              usage: {
                requestCount: 0,
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                estimatedCostUsd: null
              },
              status: "ok"
            };
          },
          async runWithUsageBudget(_budget: unknown, work: () => Promise<unknown>) {
            return work();
          },
          usageSummary(budget: { usage: Record<string, unknown> }) {
            return budget.usage;
          }
        },
        artifactStore: {
          async getUsage() {
            return {
              workspaceArtifactBytes: 0,
              workspaceArtifactLimitBytes: 500 * 1024 * 1024,
              globalArtifactBytes: 0,
              globalArtifactLimitBytes: 3 * 1024 * 1024 * 1024,
              prunedFiles: 0
            };
          }
        },
        surfaceRegistry: {},
        surfaceCoordinator: createSurfaceCoordinator(),
        workspaceManager: {
          async prepareProfile() {
            return {
              id: "profile-watch",
              name: "desktop-main",
              rootPath: process.cwd(),
              profilePath: `${process.cwd()}/profile`,
              downloadsPath: `${process.cwd()}/downloads`,
              artifactsPath: `${process.cwd()}/artifacts`,
              scratchPath: `${process.cwd()}/scratch`,
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
            async detectNewItems() {
              detectCalls += 1;
              return null;
            }
          };
        }
      } as never
    });

    await service.scan(storedRule.id);

    assert.equal(detectCalls, 0);
    assert.equal(storedRule.status, "backoff");
    assert.match(String(storedRule.lastError ?? ""), /storage_guard_triggered/i);

    const health = buildWatchHealth(storedRule);
    assert.equal(health?.budgetStatus, "paused");
    assert.equal(health?.storageGuard?.active, true);
    assert.equal(health?.storageGuard?.maximumUsedPercent, 1);
  } finally {
    if (previousThreshold === undefined) {
      delete process.env.AGENTOS_STORAGE_GUARD_MAX_USED_PERCENT;
    } else {
      process.env.AGENTOS_STORAGE_GUARD_MAX_USED_PERCENT = previousThreshold;
    }
  }
});
