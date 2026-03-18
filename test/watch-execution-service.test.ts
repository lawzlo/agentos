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
