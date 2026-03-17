import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";

import { ControlPlaneStore } from "../src/runtime/store.js";
import { LivePackRegistry } from "../src/runtime/live-pack-registry.js";
import { SurfaceRegistry } from "../src/runtime/surface-registry.js";
import type { WatchRule, WorkspaceProfile } from "../src/types/runtime-schema.js";
import {
  createTempDir,
  startAgentServer,
  startDocsFilesFixtureServer,
  startMailFixtureServer,
  startSlackFixtureServer,
  waitForTask
} from "./helpers.js";

const execFileAsync = promisify(execFile);

async function waitForWatchTask(baseUrl, watchRuleId, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${baseUrl}/tasks`);
    const payload = await response.json();
    const found = payload.tasks.find((task) => task.triggerSource === `watch:${watchRuleId}`);
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for watch task from ${watchRuleId}`);
}

async function waitForWatchRule(baseUrl, watchRuleId, matcher, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${baseUrl}/watches/${watchRuleId}`);
    const payload = await response.json();
    if (matcher(payload.watch)) {
      return payload.watch;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for watch rule ${watchRuleId}`);
}

async function waitForDraft(baseUrl, matcher, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${baseUrl}/drafts`);
    const payload = await response.json();
    const found = payload.drafts.find(matcher);
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Timed out waiting for draft");
}

test("watch rules trigger deduped tasks and can be enabled or disabled", async () => {
  const dataDir = await createTempDir();
  const fakeLivePack = {
    async detectNewItems({ dedupeState }) {
      if (dedupeState.lastFingerprint === "fake-item-1") {
        return null;
      }

      return {
        fingerprint: "fake-item-1",
        summary: "A fake unread item arrived.",
        inputs: {
          typeText: "Handled from watch"
        }
      };
    }
  };
  const server = await startAgentServer({
    dataDir,
    livePacks: {
      "fake-live": fakeLivePack
    }
  });

  try {
    await fetch(`${server.baseUrl}/skills/watch-waiter`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        surfaceScope: "desktop",
        triggerTerms: ["watch waiter"],
        anchors: [],
        actionTemplate: [
          {
            label: "Wait briefly",
            surface: "desktop",
            action: "wait",
            params: { ms: 20 },
            checkpoint: false
          }
        ],
        successCriteria: [],
        recoveryHints: []
      })
    });

    const createResponse = await fetch(`${server.baseUrl}/watches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Always watch the fake inbox and respond",
        livePack: "fake-live",
        preferredSurface: "desktop",
        skillName: "watch-waiter",
        workspaceName: "watch-main",
        pollIntervalMs: 50
      })
    });
    const { watch } = await createResponse.json();
    assert.equal(watch.livePack, "fake-live");
    assert.equal(watch.enabled, true);

    const triggeredTask = await waitForWatchTask(server.baseUrl, watch.id);
    const completed = await waitForTask(server.baseUrl, triggeredTask.id, (task) => task.status === "completed");
    assert.equal(completed.status, "completed");

    await new Promise((resolve) => setTimeout(resolve, 300));
    const tasksPayload = await (await fetch(`${server.baseUrl}/tasks`)).json();
    assert.equal(tasksPayload.tasks.filter((task) => task.triggerSource === `watch:${watch.id}`).length, 1);

    const disabledPayload = await (
      await fetch(`${server.baseUrl}/watches/${watch.id}/disable`, { method: "POST" })
    ).json();
    assert.equal(disabledPayload.watch.enabled, false);
    assert.equal(disabledPayload.watch.status, "disabled");

    const enabledPayload = await (
      await fetch(`${server.baseUrl}/watches/${watch.id}/enable`, { method: "POST" })
    ).json();
    assert.equal(enabledPayload.watch.enabled, true);
    assert.equal(enabledPayload.watch.status, "watching");
  } finally {
    await server.close();
  }
});

test("completed tasks can be taught into watch profiles and replayed by a live rule", async () => {
  const dataDir = await createTempDir();
  const fakeLivePack = {
    async detectNewItems({ dedupeState }) {
      if (dedupeState.lastFingerprint === "taught-item-1") {
        return null;
      }

      return {
        fingerprint: "taught-item-1",
        summary: "A taught watch item arrived.",
        inputs: {
          waitText: "Inbox item"
        }
      };
    }
  };
  const server = await startAgentServer({
    dataDir,
    livePacks: {
      "fake-taught": fakeLivePack
    }
  });

  try {
    const createTaskResponse = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Learn a watch-ready desktop flow",
        preferredSurface: "desktop",
        inputs: {
          waitText: "Inbox item"
        },
        steps: [
          {
            label: "Pause briefly",
            surface: "desktop",
            action: "wait",
            params: { ms: 10 },
            checkpoint: false
          }
        ]
      })
    });
    const learnedTask = (await createTaskResponse.json()).task;
    const completedLearnedTask = await waitForTask(server.baseUrl, learnedTask.id, (task) => task.status === "completed");
    assert.equal(completedLearnedTask.status, "completed");

    const teachResponse = await fetch(`${server.baseUrl}/watches/from-task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: learnedTask.id,
        goal: "Always watch the taught inbox",
        livePack: "fake-taught",
        workspaceName: "taught-watch-main",
        triggerTexts: ["Inbox item"]
      })
    });
    const { watch } = await teachResponse.json();
    assert.equal(watch.watchProfile.metadata.learnedFromTaskId, learnedTask.id);
    assert.equal(watch.watchProfile.actionTemplate[0].action, "wait");
    assert.ok(watch.watchProfile.triggerTexts.includes("Inbox item"));

    const triggeredTask = await waitForWatchTask(server.baseUrl, watch.id);
    const completedTriggeredTask = await waitForTask(server.baseUrl, triggeredTask.id, (task) => task.status === "completed");
    assert.equal(completedTriggeredTask.status, "completed");
    assert.equal(completedTriggeredTask.plan[0].action, "wait");
  } finally {
    await server.close();
  }
});

test("watch packs can enrich detected items with context before creating a task", async () => {
  const dataDir = await createTempDir();
  const fakeLivePack = {
    async detectNewItems({ dedupeState }) {
      if (dedupeState.lastFingerprint === "context-item-1") {
        return null;
      }

      return {
        fingerprint: "context-item-1",
        summary: "Thread A",
        inputs: {
          watchItemText: "Thread A"
        }
      };
    },
    async extractContext() {
      return {
        inputs: {
          watchContext: "Customer asked about pricing",
          typeText: "Following up from watch"
        }
      };
    }
  };
  const server = await startAgentServer({
    dataDir,
    livePacks: {
      "context-live": fakeLivePack
    }
  });

  try {
    await fetch(`${server.baseUrl}/skills/context-watch-skill`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        surfaceScope: "desktop",
        triggerTerms: ["context watch"],
        anchors: [],
        actionTemplate: [
          {
            label: "Wait briefly",
            surface: "desktop",
            action: "wait",
            params: { ms: 20 },
            checkpoint: false
          }
        ],
        successCriteria: [],
        recoveryHints: []
      })
    });

    const createResponse = await fetch(`${server.baseUrl}/watches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Always watch the contextual inbox and react",
        livePack: "context-live",
        preferredSurface: "desktop",
        skillName: "context-watch-skill",
        workspaceName: "context-main",
        pollIntervalMs: 50
      })
    });
    const { watch } = await createResponse.json();

    const triggeredTask = await waitForWatchTask(server.baseUrl, watch.id);
    const completed = await waitForTask(server.baseUrl, triggeredTask.id, (task) => task.status === "completed");
    assert.equal(completed.taskSpec.inputs.watchItemText, "Thread A");
    assert.equal(completed.taskSpec.inputs.watchContext, "Customer asked about pricing");
    assert.equal(completed.taskSpec.inputs.typeText, "Following up from watch");
  } finally {
    await server.close();
  }
});

test("watch failures enter backoff and record retry metadata", async () => {
  const dataDir = await createTempDir();
  const fakeLivePack = {
    async detectNewItems() {
      throw new Error("watch source unavailable");
    }
  };
  const server = await startAgentServer({
    dataDir,
    livePacks: {
      "broken-live": fakeLivePack
    }
  });

  try {
    const createResponse = await fetch(`${server.baseUrl}/watches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Always watch the broken inbox",
        livePack: "broken-live",
        preferredSurface: "desktop",
        pollIntervalMs: 1000
      })
    });
    const { watch } = await createResponse.json();

    const backedOff = await waitForWatchRule(
      server.baseUrl,
      watch.id,
      (current) => current.status === "backoff" && Number(current.dedupeState?.failureCount ?? 0) >= 1
    );
    assert.equal(backedOff.status, "backoff");
    assert.match(backedOff.lastError, /watch source unavailable/);
    assert.ok(Number(backedOff.dedupeState.backoffMs) >= 1000);
    assert.ok(Number(backedOff.dedupeState.retryAfter) > Date.now());
  } finally {
    await server.close();
  }
});

test("draft-only watch rules create pending drafts that can be approved into tasks", async () => {
  const dataDir = await createTempDir();
  const fakeLivePack = {
    async detectNewItems({ dedupeState }) {
      if (dedupeState.lastFingerprint === "draft-item-1") {
        return null;
      }

      return {
        fingerprint: "draft-item-1",
        summary: "Draft review required",
        taskSpec: {
          goal: "Review a drafted reply",
          preferredSurface: "desktop",
          steps: [
            {
              label: "Wait briefly",
              surface: "desktop",
              action: "wait",
              params: { ms: 10 },
              checkpoint: false
            }
          ]
        }
      };
    }
  };
  const server = await startAgentServer({
    dataDir,
    livePacks: {
      "draft-live": fakeLivePack
    }
  });

  try {
    const createResponse = await fetch(`${server.baseUrl}/watches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Always watch the draft-only inbox",
        livePack: "draft-live",
        preferredSurface: "desktop",
        pollIntervalMs: 50,
        inputs: {
          automationPolicy: "confirm_required"
        }
      })
    });
    const { watch } = await createResponse.json();

    const pendingDraft = await waitForDraft(server.baseUrl, (draft) => draft.watchRuleId === watch.id && draft.status === "pending");
    assert.equal(pendingDraft.status, "pending");
    assert.equal(pendingDraft.riskDecision.action, "draft");

    const watchPending = await waitForWatchRule(server.baseUrl, watch.id, (current) => current.status === "awaiting_approval");
    assert.equal(watchPending.health.state, "healthy");
    assert.equal(watchPending.health.activeDraftId, pendingDraft.id);

    const approvedResponse = await fetch(`${server.baseUrl}/drafts/${pendingDraft.id}/approve`, {
      method: "POST"
    });
    const approvedPayload = await approvedResponse.json();
    assert.equal(approvedPayload.draft.status, "approved");
    assert.ok(approvedPayload.draft.taskId);

    const completed = await waitForTask(server.baseUrl, approvedPayload.draft.taskId, (task) => task.status === "completed");
    assert.equal(completed.status, "completed");
  } finally {
    await server.close();
  }
});

test("watch retry clears backoff state and allows a recovered pack to trigger", async () => {
  const dataDir = await createTempDir();
  let shouldFail = true;
  const fakeLivePack = {
    async detectNewItems({ dedupeState }) {
      if (shouldFail) {
        throw new Error("temporary outage");
      }
      if (dedupeState.lastFingerprint === "retry-item-1") {
        return null;
      }
      return {
        fingerprint: "retry-item-1",
        summary: "Retry succeeded",
        taskSpec: {
          goal: "Run after retry",
          preferredSurface: "desktop",
          steps: [
            {
              label: "Wait briefly",
              surface: "desktop",
              action: "wait",
              params: { ms: 10 },
              checkpoint: false
            }
          ]
        }
      };
    }
  };
  const server = await startAgentServer({
    dataDir,
    livePacks: {
      "retry-live": fakeLivePack
    }
  });

  try {
    const createResponse = await fetch(`${server.baseUrl}/watches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Always watch the retry inbox",
        livePack: "retry-live",
        preferredSurface: "desktop",
        pollIntervalMs: 1000
      })
    });
    const { watch } = await createResponse.json();

    await waitForWatchRule(server.baseUrl, watch.id, (current) => current.status === "backoff");
    shouldFail = false;

    const retryResponse = await fetch(`${server.baseUrl}/watches/${watch.id}/retry`, {
      method: "POST"
    });
    const retryPayload = await retryResponse.json();
    assert.equal(retryPayload.watch.status, "watching");
    assert.equal(retryPayload.watch.health.failureCount, 0);

    const triggeredTask = await waitForWatchTask(server.baseUrl, watch.id);
    const completed = await waitForTask(server.baseUrl, triggeredTask.id, (task) => task.status === "completed");
    assert.equal(completed.status, "completed");
  } finally {
    await server.close();
  }
});

test("doctor and packs endpoints expose live runtime diagnostics", async () => {
  const dataDir = await createTempDir();
  const server = await startAgentServer({ dataDir });

  try {
    const doctorPayload = await (await fetch(`${server.baseUrl}/doctor`)).json();
    assert.equal(typeof doctorPayload.doctor.ok, "boolean");
    assert.ok(Array.isArray(doctorPayload.doctor.warnings));

    const packsPayload = await (await fetch(`${server.baseUrl}/packs`)).json();
    assert.ok(packsPayload.packs.some((pack) => pack.name === "generic-mail-browser"));
    assert.ok(packsPayload.packs.some((pack) => pack.name === "slack-desktop"));
    assert.ok(packsPayload.packs.some((pack) => pack.name === "slack-browser"));
    assert.ok(packsPayload.packs.some((pack) => pack.name === "wechat-desktop"));
    assert.ok(packsPayload.packs.some((pack) => pack.name === "generic-mail-desktop"));
    assert.ok(packsPayload.packs.some((pack) => pack.name === "google-drive-browser"));
    assert.ok(packsPayload.packs.some((pack) => pack.name === "google-docs-browser"));
    assert.ok(packsPayload.packs.some((pack) => pack.name === "feishu-docs-browser"));
  } finally {
    await server.close();
  }
});

test("slack browser watch rules infer the browser pack and auto-send low-risk replies", async () => {
  const dataDir = await createTempDir();
  const slack = await startSlackFixtureServer();
  const server = await startAgentServer({ dataDir });

  try {
    const createResponse = await fetch(`${server.baseUrl}/watches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Always watch Slack and reply to unread threads",
        preferredSurface: "browser",
        workspaceName: "slack-browser-main",
        pollIntervalMs: 50,
        inputs: {
          startUrl: `${slack.url}/slack`
        }
      })
    });
    const { watch } = await createResponse.json();
    assert.equal(watch.livePack, "slack-browser");

    const triggeredTask = await waitForWatchTask(server.baseUrl, watch.id);
    const completed = await waitForTask(server.baseUrl, triggeredTask.id, (task) => task.status === "completed");
    assert.equal(completed.status, "completed");

    const state = await slack.getState();
    assert.equal(state.sentReplies.length, 1);
    assert.equal(state.sentReplies[0].message, "Got it. I will follow up shortly.");

    await new Promise((resolve) => setTimeout(resolve, 300));
    const tasksPayload = await (await fetch(`${server.baseUrl}/tasks`)).json();
    assert.equal(tasksPayload.tasks.filter((task) => task.triggerSource === `watch:${watch.id}`).length, 1);
  } finally {
    await server.close();
    await slack.close();
  }
});

test("slack browser watch rules draft high-risk replies instead of auto-sending", async () => {
  const dataDir = await createTempDir();
  const slack = await startSlackFixtureServer({
    threadTitle: "Invoice follow-up",
    messages: ["Customer: Please pay invoice 123 today."]
  });
  const server = await startAgentServer({ dataDir });

  try {
    const createResponse = await fetch(`${server.baseUrl}/watches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Always watch Slack and reply to unread threads",
        preferredSurface: "browser",
        workspaceName: "slack-browser-main",
        pollIntervalMs: 50,
        inputs: {
          startUrl: `${slack.url}/slack`
        }
      })
    });
    const { watch } = await createResponse.json();
    assert.equal(watch.livePack, "slack-browser");

    const pendingDraft = await waitForDraft(
      server.baseUrl,
      (draft) => draft.watchRuleId === watch.id && draft.livePack === "slack-browser" && draft.status === "pending"
    );
    assert.equal(pendingDraft.riskDecision.action, "draft");

    const state = await slack.getState();
    assert.equal(state.sentReplies.length, 0);

    const watchPending = await waitForWatchRule(server.baseUrl, watch.id, (current) => current.status === "awaiting_approval");
    assert.equal(watchPending.health.activeDraftId, pendingDraft.id);
  } finally {
    await server.close();
    await slack.close();
  }
});

test("slack desktop pack can detect unread threads and build reply steps from a desktop world state", async () => {
  let opened = false;
  const initialWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-slack",
    appContext: {
      appName: "Slack",
      windows: [{ title: "Slack" }]
    },
    capture: null,
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "thread-acme",
        surface: "desktop",
        kind: "text",
        text: "Unread: Acme renewal",
        role: "text",
        bounds: { x: 10, y: 10, width: 140, height: 24, centerX: 80, centerY: 22 },
        confidence: 0.8,
        sourceHints: { source: "ocr" },
        isInteractive: true
      }
    ],
    visibleText: "Slack\nUnread threads\nUnread: Acme renewal\nCustomer: Can you share pricing?",
    recentActions: [],
    summary: "Slack unread sidebar",
    timestamp: new Date().toISOString()
  };
  const threadWorldState = {
    ...initialWorldState,
    interactionCandidates: [
      {
        id: "thread-acme",
        surface: "desktop",
        kind: "text",
        text: "Acme renewal",
        role: "text",
        bounds: { x: 10, y: 10, width: 140, height: 24, centerX: 80, centerY: 22 },
        confidence: 0.8,
        sourceHints: { source: "ocr" },
        isInteractive: true
      },
      {
        id: "compose",
        surface: "desktop",
        kind: "text",
        text: "Message",
        role: "textbox",
        bounds: { x: 10, y: 200, width: 240, height: 32, centerX: 130, centerY: 216 },
        confidence: 0.8,
        sourceHints: { source: "ocr", placeholder: "Message" },
        isInteractive: true
      },
      {
        id: "send",
        surface: "desktop",
        kind: "text",
        text: "Send",
        role: "button",
        bounds: { x: 260, y: 200, width: 60, height: 32, centerX: 290, centerY: 216 },
        confidence: 0.8,
        sourceHints: { source: "ocr" },
        isInteractive: true
      }
    ],
    visibleText: "Slack\nConversation: Acme renewal\nCustomer: Can you share pricing?\nTeammate: Keep it short.\nMessage\nSend"
  };
  const fakeSurface = {
    async observe() {
      return opened ? threadWorldState : initialWorldState;
    },
    async act({ step }) {
      if (step.action === "clickTarget") {
        opened = true;
      }
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("slack-desktop");
  const rule: WatchRule = {
    id: "watch-slack-desktop",
    goal: "Always watch Slack and reply to unread threads",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "slack-desktop-main",
    skillName: null,
    appTarget: "Slack",
    livePack: "slack-desktop",
    pollIntervalMs: 1000,
    watchProfile: {},
    taskInputs: {},
    dedupeState: {},
    lastObservedAt: null,
    lastTriggeredAt: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const workspace: WorkspaceProfile = {
    id: "profile-slack",
    name: "slack-desktop-main",
    rootPath: "/tmp/slack-desktop-main",
    profilePath: "/tmp/slack-desktop-main/profile",
    downloadsPath: "/tmp/slack-desktop-main/downloads",
    artifactsPath: "/tmp/slack-desktop-main/artifacts",
    scratchPath: "/tmp/slack-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: initialWorldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {} as never
  });
  assert.equal(detection?.summary, "Acme renewal");

  const context = await pack?.extractContext?.({
    rule,
    worldState: initialWorldState as never,
    detection: detection as never,
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: { isConfigured: () => false }
    } as never
  });
  assert.equal(context?.inputs?.typeTarget, "Message");
  assert.equal(context?.inputs?.sendTarget, "Send");
  assert.equal(Array.isArray(context?.taskSpec?.steps), true);
  assert.equal(context?.taskSpec?.steps?.[0]?.action, "clickTarget");
  assert.equal(context?.taskSpec?.steps?.[2]?.params?.text, "{{typeText}}");
});

test("wechat desktop pack can detect unread conversations and build reply steps from a desktop world state", async () => {
  let opened = false;
  const initialWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-wechat",
    appContext: {
      appName: "WeChat",
      windows: [{ title: "WeChat" }]
    },
    capture: null,
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "thread-zhangsan",
        surface: "desktop",
        kind: "text",
        text: "未读: 张三",
        role: "text",
        bounds: { x: 10, y: 10, width: 160, height: 24, centerX: 90, centerY: 22 },
        confidence: 0.88,
        sourceHints: { source: "ocr" },
        isInteractive: true
      }
    ],
    visibleText: "微信\n最近聊天\n未读\n张三\n客户: 明天下午方便吗？",
    recentActions: [],
    summary: "WeChat unread list",
    timestamp: new Date().toISOString()
  };
  const threadWorldState = {
    ...initialWorldState,
    interactionCandidates: [
      {
        id: "thread-zhangsan",
        surface: "desktop",
        kind: "text",
        text: "张三",
        role: "text",
        bounds: { x: 10, y: 10, width: 160, height: 24, centerX: 90, centerY: 22 },
        confidence: 0.88,
        sourceHints: { source: "ocr" },
        isInteractive: true
      },
      {
        id: "compose",
        surface: "desktop",
        kind: "text",
        text: "输入消息",
        role: "textbox",
        bounds: { x: 10, y: 210, width: 240, height: 32, centerX: 130, centerY: 226 },
        confidence: 0.84,
        sourceHints: { source: "ocr", placeholder: "输入消息" },
        isInteractive: true
      },
      {
        id: "send",
        surface: "desktop",
        kind: "text",
        text: "发送",
        role: "button",
        bounds: { x: 260, y: 210, width: 60, height: 32, centerX: 290, centerY: 226 },
        confidence: 0.84,
        sourceHints: { source: "ocr" },
        isInteractive: true
      }
    ],
    visibleText: "微信\n张三\n客户: 明天下午方便吗？\n我: 我先确认一下时间。\n输入消息\n发送"
  };
  const fakeSurface = {
    async observe() {
      return opened ? threadWorldState : initialWorldState;
    },
    async act({ step }) {
      if (step.action === "clickTarget") {
        opened = true;
      }
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("wechat-desktop");
  const rule: WatchRule = {
    id: "watch-wechat-desktop",
    goal: "Always watch WeChat and reply to unread conversations",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "wechat-desktop-main",
    skillName: null,
    appTarget: "WeChat",
    livePack: "wechat-desktop",
    pollIntervalMs: 1000,
    watchProfile: {},
    taskInputs: {},
    dedupeState: {},
    lastObservedAt: null,
    lastTriggeredAt: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const workspace: WorkspaceProfile = {
    id: "profile-wechat",
    name: "wechat-desktop-main",
    rootPath: "/tmp/wechat-desktop-main",
    profilePath: "/tmp/wechat-desktop-main/profile",
    downloadsPath: "/tmp/wechat-desktop-main/downloads",
    artifactsPath: "/tmp/wechat-desktop-main/artifacts",
    scratchPath: "/tmp/wechat-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: initialWorldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {} as never
  });
  assert.equal(detection?.summary, "张三");

  const context = await pack?.extractContext?.({
    rule,
    worldState: initialWorldState as never,
    detection: detection as never,
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: { isConfigured: () => false }
    } as never
  });
  assert.equal(context?.inputs?.typeTarget, "输入消息");
  assert.equal(context?.inputs?.sendTarget, "发送");
  assert.equal(context?.context?.[0], "客户: 明天下午方便吗？");
  assert.equal(Array.isArray(context?.taskSpec?.steps), true);
  assert.equal(context?.taskSpec?.steps?.[0]?.action, "clickTarget");
  assert.equal(context?.taskSpec?.steps?.[2]?.params?.text, "{{typeText}}");
});

test("mail browser watch rules infer the browser pack, draft replies, and can be approved into tasks", async () => {
  const dataDir = await createTempDir();
  const mail = await startMailFixtureServer();
  const server = await startAgentServer({ dataDir });

  try {
    const createResponse = await fetch(`${server.baseUrl}/watches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Always watch email and reply to unread messages",
        preferredSurface: "browser",
        workspaceName: "mail-browser-main",
        pollIntervalMs: 50,
        inputs: {
          startUrl: `${mail.url}/mail`
        }
      })
    });
    const { watch } = await createResponse.json();
    assert.equal(watch.livePack, "generic-mail-browser");

    const pendingDraft = await waitForDraft(
      server.baseUrl,
      (draft) => draft.watchRuleId === watch.id && draft.livePack === "generic-mail-browser" && draft.status === "pending"
    );
    assert.equal(pendingDraft.riskDecision.action, "draft");

    let state = await mail.getState();
    assert.equal(state.sentReplies.length, 0);

    const approvedResponse = await fetch(`${server.baseUrl}/drafts/${pendingDraft.id}/approve`, {
      method: "POST"
    });
    const approvedPayload = await approvedResponse.json();
    assert.equal(approvedPayload.draft.status, "approved");

    const completed = await waitForTask(server.baseUrl, approvedPayload.draft.taskId, (task) => task.status === "completed");
    assert.equal(completed.status, "completed");

    state = await mail.getState();
    assert.equal(state.sentReplies.length, 1);
    assert.equal(state.sentReplies[0].message, "Thanks for your email. I received it and will follow up shortly.");
  } finally {
    await server.close();
    await mail.close();
  }
});

test("google drive browser watch rules infer the browser pack and trigger upload workflows", async () => {
  const dataDir = await createTempDir();
  const fixture = await startDocsFilesFixtureServer();
  const server = await startAgentServer({ dataDir });
  const uploadFilePath = `${dataDir}/drive-watch.txt`;
  await fs.writeFile(uploadFilePath, "Drive watch payload", "utf8");

  try {
    const createResponse = await fetch(`${server.baseUrl}/watches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Always watch Google Drive for pending uploads and process them.",
        preferredSurface: "browser",
        workspaceName: "drive-watch-main",
        pollIntervalMs: 50,
        inputs: {
          startUrl: `${fixture.url}/google-drive`,
          uploadTarget: "Upload to Drive",
          uploadPath: uploadFilePath
        }
      })
    });
    const { watch } = await createResponse.json();
    assert.equal(watch.livePack, "google-drive-browser");

    const triggeredTask = await waitForWatchTask(server.baseUrl, watch.id);
    const completed = await waitForTask(server.baseUrl, triggeredTask.id, (task) => task.status === "completed");
    assert.equal(completed.status, "completed");

    const state = await fixture.getState();
    assert.equal(state.googleDriveUploadedFileName, "drive-watch.txt");
    assert.equal(state.googleDriveUploadedFileContent, "Drive watch payload");
  } finally {
    await server.close();
    await fixture.close();
  }
});

test("google docs browser watch rules infer the browser pack and trigger document edit workflows", async () => {
  const dataDir = await createTempDir();
  const fixture = await startDocsFilesFixtureServer();
  const server = await startAgentServer({ dataDir });

  try {
    const createResponse = await fetch(`${server.baseUrl}/watches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Always watch Google Docs for documents that need updates.",
        preferredSurface: "browser",
        workspaceName: "google-docs-watch-main",
        pollIntervalMs: 50,
        inputs: {
          startUrl: `${fixture.url}/google-docs`,
          documentTarget: "Google Docs editor",
          documentText: "Google Docs watch update from AgentOS",
          saveTarget: "Save Google Doc"
        }
      })
    });
    const { watch } = await createResponse.json();
    assert.equal(watch.livePack, "google-docs-browser");

    const triggeredTask = await waitForWatchTask(server.baseUrl, watch.id);
    const completed = await waitForTask(server.baseUrl, triggeredTask.id, (task) => task.status === "completed");
    assert.equal(completed.status, "completed");

    const state = await fixture.getState();
    assert.equal(state.googleDocsDocument, "Google Docs watch update from AgentOS");
  } finally {
    await server.close();
    await fixture.close();
  }
});

test("feishu docs browser watch rules infer the browser pack and trigger document edit workflows", async () => {
  const dataDir = await createTempDir();
  const fixture = await startDocsFilesFixtureServer();
  const server = await startAgentServer({ dataDir });

  try {
    const createResponse = await fetch(`${server.baseUrl}/watches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "一直盯飞书文档，有待处理文档就更新。",
        preferredSurface: "browser",
        workspaceName: "feishu-docs-watch-main",
        pollIntervalMs: 50,
        inputs: {
          startUrl: `${fixture.url}/feishu-docs`,
          documentTarget: "飞书文档编辑区",
          documentText: "飞书文档 Watch 更新内容",
          saveTarget: "保存到飞书"
        }
      })
    });
    const { watch } = await createResponse.json();
    assert.equal(watch.livePack, "feishu-docs-browser");

    const triggeredTask = await waitForWatchTask(server.baseUrl, watch.id);
    const completed = await waitForTask(server.baseUrl, triggeredTask.id, (task) => task.status === "completed");
    assert.equal(completed.status, "completed");

    const state = await fixture.getState();
    assert.equal(state.feishuDocsDocument, "飞书文档 Watch 更新内容");
  } finally {
    await server.close();
    await fixture.close();
  }
});

test("mail desktop pack can detect unread messages and build reply steps from a desktop world state", async () => {
  let opened = false;
  const initialWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-mail",
    appContext: {
      appName: "Mail",
      windows: [{ title: "Inbox" }]
    },
    capture: null,
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "mail-thread",
        surface: "desktop",
        kind: "text",
        text: "未读邮件: 项目更新",
        role: "text",
        bounds: { x: 10, y: 10, width: 180, height: 24, centerX: 100, centerY: 22 },
        confidence: 0.9,
        sourceHints: { source: "ocr" },
        isInteractive: true
      }
    ],
    visibleText: "收件箱\n未读邮件\n项目更新\n客户: 请发一下最新进展",
    recentActions: [],
    summary: "Mail inbox",
    timestamp: new Date().toISOString()
  };
  const threadWorldState = {
    ...initialWorldState,
    interactionCandidates: [
      {
        id: "mail-thread",
        surface: "desktop",
        kind: "text",
        text: "项目更新",
        role: "text",
        bounds: { x: 10, y: 10, width: 180, height: 24, centerX: 100, centerY: 22 },
        confidence: 0.9,
        sourceHints: { source: "ocr" },
        isInteractive: true
      },
      {
        id: "compose",
        surface: "desktop",
        kind: "text",
        text: "回复",
        role: "textbox",
        bounds: { x: 10, y: 210, width: 240, height: 32, centerX: 130, centerY: 226 },
        confidence: 0.84,
        sourceHints: { source: "ocr", placeholder: "回复" },
        isInteractive: true
      },
      {
        id: "send",
        surface: "desktop",
        kind: "text",
        text: "发送",
        role: "button",
        bounds: { x: 260, y: 210, width: 60, height: 32, centerX: 290, centerY: 226 },
        confidence: 0.84,
        sourceHints: { source: "ocr" },
        isInteractive: true
      }
    ],
    visibleText: "邮件\n项目更新\n客户: 请发一下最新进展\n我: 稍后给你整理一版。\n回复\n发送"
  };
  const fakeSurface = {
    async observe() {
      return opened ? threadWorldState : initialWorldState;
    },
    async act({ step }) {
      if (step.action === "clickTarget") {
        opened = true;
      }
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("generic-mail-desktop");
  const rule: WatchRule = {
    id: "watch-mail-desktop",
    goal: "Always watch email and reply to unread messages",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "mail-desktop-main",
    skillName: null,
    appTarget: "Mail",
    livePack: "generic-mail-desktop",
    pollIntervalMs: 1000,
    watchProfile: {},
    taskInputs: {},
    dedupeState: {},
    lastObservedAt: null,
    lastTriggeredAt: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const workspace: WorkspaceProfile = {
    id: "profile-mail",
    name: "mail-desktop-main",
    rootPath: "/tmp/mail-desktop-main",
    profilePath: "/tmp/mail-desktop-main/profile",
    downloadsPath: "/tmp/mail-desktop-main/downloads",
    artifactsPath: "/tmp/mail-desktop-main/artifacts",
    scratchPath: "/tmp/mail-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: initialWorldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {} as never
  });
  assert.equal(detection?.summary, "项目更新");

  const context = await pack?.extractContext?.({
    rule,
    worldState: initialWorldState as never,
    detection: detection as never,
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: { isConfigured: () => false }
    } as never
  });
  assert.equal(context?.inputs?.typeTarget, "回复");
  assert.equal(context?.inputs?.sendTarget, "发送");
  assert.equal(context?.context?.[0], "客户: 请发一下最新进展");
  assert.equal(Array.isArray(context?.taskSpec?.steps), true);
  assert.equal(context?.taskSpec?.steps?.[0]?.action, "clickTarget");
  assert.equal(context?.taskSpec?.steps?.[2]?.params?.text, "{{typeText}}");
});

test("daemon startup requeues queued tasks and marks in-flight tasks as interrupted", async () => {
  const dataDir = await createTempDir();
  const store = new ControlPlaneStore(`${dataDir}/agentos.sqlite`);

  try {
    const queued = store.createTask({
      goal: "Queued before daemon restart",
      preferredSurface: "desktop",
      steps: [
        {
          label: "Wait shortly",
          surface: "desktop",
          action: "wait",
          params: { ms: 10 },
          checkpoint: false
        }
      ]
    });
    const running = store.createTask({
      goal: "Running before daemon restart",
      preferredSurface: "desktop",
      steps: [
        {
          label: "Wait later",
          surface: "desktop",
          action: "wait",
          params: { ms: 10 },
          checkpoint: false
        }
      ]
    });
    store.updateTask(running.id, { status: "running" });
  } finally {
    store.close();
  }

  const server = await startAgentServer({ dataDir });
  try {
    const tasksPayload = await (await fetch(`${server.baseUrl}/tasks`)).json();
    const interrupted = tasksPayload.tasks.find((task) => task.goal === "Running before daemon restart");
    assert.equal(interrupted.status, "interrupted");

    const queuedTask = tasksPayload.tasks.find((task) => task.goal === "Queued before daemon restart");
    const completed = await waitForTask(server.baseUrl, queuedTask.id, (task) => task.status === "completed");
    assert.equal(completed.status, "completed");
  } finally {
    await server.close();
  }
});

test("cli can inspect daemon state and manage watch rules", async () => {
  const dataDir = await createTempDir();
  const fakeLivePack = {
    async detectNewItems({ dedupeState }) {
      if (dedupeState.lastFingerprint === "cli-item-1") {
        return null;
      }

      return {
        fingerprint: "cli-item-1",
        summary: "CLI watch event",
        inputs: {}
      };
    }
  };
  const server = await startAgentServer({
    dataDir,
    livePacks: {
      "cli-live": fakeLivePack
    }
  });

  try {
    await fetch(`${server.baseUrl}/skills/cli-watch-skill`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        surfaceScope: "desktop",
        triggerTerms: [],
        anchors: [],
        actionTemplate: [
          {
            label: "CLI wait",
            surface: "desktop",
            action: "wait",
            params: { ms: 20 },
            checkpoint: false
          }
        ],
        successCriteria: [],
        recoveryHints: []
      })
    });

    const env = {
      ...process.env,
      AGENTOS_BASE_URL: server.baseUrl,
      AGENTOS_DATA_DIR: dataDir
    };

    const statusResult = await execFileAsync(process.execPath, ["dist/bin/agentos.js", "daemon", "status", "--json"], {
      cwd: process.cwd(),
      env
    });
    const daemonStatus = JSON.parse(statusResult.stdout);
    assert.equal(daemonStatus.running, true);

    const addResult = await execFileAsync(
      process.execPath,
      [
        "dist/bin/agentos.js",
        "watch",
        "add",
        "Always watch the CLI inbox and react",
        "--pack",
        "cli-live",
        "--skill",
        "cli-watch-skill",
        "--workspace",
        "cli-main",
        "--interval",
        "50",
        "--json"
      ],
      {
        cwd: process.cwd(),
        env
      }
    );
    const watch = JSON.parse(addResult.stdout);
    assert.equal(watch.livePack, "cli-live");

    const listResult = await execFileAsync(process.execPath, ["dist/bin/agentos.js", "watch", "ls", "--json"], {
      cwd: process.cwd(),
      env
    });
    const watches = JSON.parse(listResult.stdout);
    assert.ok(watches.some((entry) => entry.id === watch.id));

    const triggeredTask = await waitForWatchTask(server.baseUrl, watch.id);
    const completed = await waitForTask(server.baseUrl, triggeredTask.id, (task) => task.status === "completed");
    assert.equal(completed.status, "completed");
  } finally {
    await server.close();
  }
});

test("cli can teach a completed task into a watch rule", async () => {
  const dataDir = await createTempDir();
  const fakeLivePack = {
    async detectNewItems({ dedupeState }) {
      if (dedupeState.lastFingerprint === "cli-taught-item-1") {
        return null;
      }

      return {
        fingerprint: "cli-taught-item-1",
        summary: "CLI taught watch event",
        inputs: {
          waitText: "CLI inbox item"
        }
      };
    }
  };
  const server = await startAgentServer({
    dataDir,
    livePacks: {
      "cli-taught": fakeLivePack
    }
  });

  try {
    const taskResponse = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Create a task that will become a watch profile",
        preferredSurface: "desktop",
        inputs: {
          waitText: "CLI inbox item"
        },
        steps: [
          {
            label: "CLI wait",
            surface: "desktop",
            action: "wait",
            params: { ms: 10 },
            checkpoint: false
          }
        ]
      })
    });
    const task = (await taskResponse.json()).task;
    await waitForTask(server.baseUrl, task.id, (current) => current.status === "completed");

    const env = {
      ...process.env,
      AGENTOS_BASE_URL: server.baseUrl,
      AGENTOS_DATA_DIR: dataDir
    };

    const teachResult = await execFileAsync(
      process.execPath,
      [
        "dist/bin/agentos.js",
        "watch",
        "teach",
        task.id,
        "Always watch the CLI taught inbox",
        "--pack",
        "cli-taught",
        "--workspace",
        "cli-taught-main",
        "--trigger",
        "CLI inbox item",
        "--json"
      ],
      {
        cwd: process.cwd(),
        env
      }
    );
    const watch = JSON.parse(teachResult.stdout);
    assert.equal(watch.livePack, "cli-taught");
    assert.equal(watch.watchProfile.metadata.learnedFromTaskId, task.id);

    const triggeredTask = await waitForWatchTask(server.baseUrl, watch.id);
    const completed = await waitForTask(server.baseUrl, triggeredTask.id, (current) => current.status === "completed");
    assert.equal(completed.status, "completed");
  } finally {
    await server.close();
  }
});
