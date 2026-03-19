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
  startBossFixtureServer,
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

async function waitForWatchTasks(baseUrl, watchRuleId, count, timeoutMs = 10000) {
  return waitForValue(async () => {
    const response = await fetch(`${baseUrl}/tasks`);
    const payload = await response.json();
    return payload.tasks.filter((task) => task.triggerSource === `watch:${watchRuleId}`);
  }, (tasks) => tasks.length >= count, timeoutMs);
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

async function waitForValue(read, matcher, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = await read();
    if (matcher(current)) {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Timed out waiting for value");
}

async function waitForWatchDeletion(baseUrl, watchRuleId, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${baseUrl}/watches/${watchRuleId}`);
    if (response.status === 404) {
      return;
    }
    if (response.status !== 200) {
      const body = await response.text();
      throw new Error(`Unexpected status while waiting for watch rule deletion: ${response.status}: ${body}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for watch rule ${watchRuleId} to be deleted`);
}

async function waitForAutomationJob(baseUrl, jobId, matcher, timeoutMs = 10000) {
  return waitForValue(
    async () => {
      const response = await fetch(`${baseUrl}/jobs/${jobId}`);
      const payload = await response.json();
      return payload.job;
    },
    matcher,
    timeoutMs
  );
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

test("daemon startup reconciles running automation jobs left behind by a previous session", async () => {
  const dataDir = await createTempDir();
  const store = new ControlPlaneStore(`${dataDir}/agentos.sqlite`);
  const nextRunAt = new Date(Date.now() + 60_000).toISOString();
  const runningJob = store.putAutomationJob({
    name: "Morning scan",
    kind: "task",
    template: "morning_scan",
    enabled: true,
    status: "running",
    scheduleType: "daily",
    hourOfDay: 9,
    intervalMinutes: null,
    taskSpec: {
      goal: "Review my inbox and draft a morning brief.",
      preferredSurface: "browser",
      workspaceName: "personal-main"
    },
    metadata: {},
    lastRunAt: null,
    lastTaskId: null,
    nextRunAt,
    lastError: null
  });
  store.close();

  const server = await startAgentServer({ dataDir });

  try {
    const recoveredJob = await waitForAutomationJob(
      server.baseUrl,
      runningJob.id,
      (job) => job && job.status === "degraded"
    );
    assert.equal(recoveredJob.status, "degraded");
    assert.match(recoveredJob.lastError, /daemon restarted before automation job completion/i);
    assert.equal(typeof recoveredJob.metadata.recoveredAfterRestartAt, "string");

    const daemonPayload = await (await fetch(`${server.baseUrl}/daemon/status`)).json();
    assert.equal(daemonPayload.daemon.startupRecovery.reconciledRunningJobCount, 1);
    assert.equal(daemonPayload.daemon.startupRecovery.dueJobCountAtStartup, 0);
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

test("watch governance quiet hours downgrade auto-send replies into drafts", async () => {
  const dataDir = await createTempDir();
  const currentHour = new Date().getHours();
  const fakeLivePack = {
    async detectNewItems({ dedupeState }) {
      if (dedupeState.lastFingerprint === "quiet-hours-item-1") {
        return null;
      }

      return {
        fingerprint: "quiet-hours-item-1",
        summary: "Quiet hours message",
        replyText: "Handled during quiet hours",
        inputs: {
          typeTarget: "Message",
          sendTarget: "Send"
        }
      };
    }
  };
  const server = await startAgentServer({
    dataDir,
    livePacks: {
      "quiet-hours-live": fakeLivePack
    }
  });

  try {
    const createResponse = await fetch(`${server.baseUrl}/watches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Always watch the quiet inbox",
        livePack: "quiet-hours-live",
        preferredSurface: "desktop",
        pollIntervalMs: 50,
        inputs: {
          automationPolicy: "allow"
        },
        governance: {
          quietHours: {
            startHour: currentHour,
            endHour: (currentHour + 1) % 24
          }
        }
      })
    });
    const { watch } = await createResponse.json();

    const pendingDraft = await waitForDraft(
      server.baseUrl,
      (draft) => draft.watchRuleId === watch.id && draft.status === "pending"
    );
    assert.equal(pendingDraft.riskDecision.action, "draft");
    assert.ok(
      pendingDraft.riskDecision.reasons.some((reason) => String(reason).includes("quiet hours"))
    );
  } finally {
    await server.close();
  }
});

test("watch governance max auto actions per day downgrades later triggers into drafts", async () => {
  const dataDir = await createTempDir();
  const queuedDetections = [
    {
      fingerprint: "budget-item-1",
      summary: "First automatic action",
      taskSpec: {
        goal: "Handle the first automatic item",
        preferredSurface: "desktop",
        steps: [
          {
            label: "Write a marker file",
            surface: "desktop",
            action: "writeFileText",
            params: { path: "budget-first.txt", text: "first automatic action" },
            checkpoint: false
          }
        ]
      }
    },
    {
      fingerprint: "budget-item-2",
      summary: "Second automatic action",
      taskSpec: {
        goal: "Handle the second automatic item",
        preferredSurface: "desktop",
        steps: [
          {
            label: "Write a marker file",
            surface: "desktop",
            action: "writeFileText",
            params: { path: "budget-second.txt", text: "second automatic action" },
            checkpoint: false
          }
        ]
      }
    }
  ];
  const fakeLivePack = {
    async detectNewItems() {
      return queuedDetections.shift() ?? null;
    }
  };
  const server = await startAgentServer({
    dataDir,
    livePacks: {
      "budget-live": fakeLivePack
    }
  });

  try {
    const createResponse = await fetch(`${server.baseUrl}/watches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Always watch the bounded inbox",
        livePack: "budget-live",
        preferredSurface: "desktop",
        pollIntervalMs: 50,
        inputs: {
          automationPolicy: "allow"
        },
        governance: {
          maxAutoActionsPerDay: 1
        }
      })
    });
    const { watch } = await createResponse.json();

    const triggeredTask = await waitForWatchTask(server.baseUrl, watch.id);
    const completedTask = await waitForTask(server.baseUrl, triggeredTask.id, (task) => task.status === "completed");
    assert.equal(completedTask.status, "completed");

    const pendingDraft = await waitForDraft(
      server.baseUrl,
      (draft) => draft.watchRuleId === watch.id && draft.status === "pending"
    );
    assert.equal(pendingDraft.riskDecision.action, "draft");
    assert.ok(
      pendingDraft.riskDecision.reasons.some((reason) => String(reason).includes("max auto actions per day"))
    );
  } finally {
    await server.close();
  }
});

test("watch governance can degrade immediately after one failure", async () => {
  const dataDir = await createTempDir();
  const fakeLivePack = {
    async detectNewItems() {
      throw new Error("governance failure");
    }
  };
  const server = await startAgentServer({
    dataDir,
    livePacks: {
      "governance-failure-live": fakeLivePack
    }
  });

  try {
    const createResponse = await fetch(`${server.baseUrl}/watches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Always watch the fragile inbox",
        livePack: "governance-failure-live",
        preferredSurface: "desktop",
        pollIntervalMs: 50,
        governance: {
          maxConsecutiveFailures: 1
        }
      })
    });
    const { watch } = await createResponse.json();

    const degraded = await waitForWatchRule(server.baseUrl, watch.id, (current) => current.status === "degraded");
    assert.equal(degraded.health.failureCount, 1);
    assert.match(String(degraded.lastError ?? ""), /governance failure/);
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

test("conversation threads escalate after failed auto-send and approval resets the same thread", async () => {
  const dataDir = await createTempDir();
  const queuedDetections = [
    {
      fingerprint: "thread-a-msg-1",
      summary: "Thread A first follow-up",
      replyText: "Thanks, I saw this.",
      inputs: {
        typeTarget: "Message",
        sendTarget: "Send"
      },
      metadata: {
        threadKey: "thread-a",
        replyThreadKey: "thread-a",
        messageId: "thread-a-msg-1",
        sender: "Candidate",
        direction: "inbound",
        receivedAt: new Date().toISOString(),
        requiresAttention: true
      },
      taskSpec: {
        goal: "Send the first reply for thread A",
        preferredSurface: "desktop",
        steps: [
          {
            label: "Write first reply receipt",
            surface: "desktop",
            action: "writeFileText",
            params: {
              path: "thread-a/first.txt",
              text: "first"
            },
            checkpoint: false
          }
        ]
      }
    },
    {
      fingerprint: "thread-a-msg-2",
      summary: "Thread A second follow-up",
      replyText: "Thanks, I saw this.",
      inputs: {
        typeTarget: "Message",
        sendTarget: "Send"
      },
      metadata: {
        threadKey: "thread-a",
        replyThreadKey: "thread-a",
        messageId: "thread-a-msg-2",
        sender: "Candidate",
        direction: "inbound",
        receivedAt: new Date().toISOString(),
        requiresAttention: true
      },
      taskSpec: {
        goal: "Send the second reply for thread A",
        preferredSurface: "desktop",
        steps: [
          {
            label: "Read a missing file to fail",
            surface: "desktop",
            action: "readFileText",
            params: {
              path: "thread-a/missing.txt"
            },
            checkpoint: false
          }
        ]
      }
    },
    {
      fingerprint: "thread-a-msg-3",
      summary: "Thread A third follow-up",
      replyText: "Thanks, I saw this.",
      inputs: {
        typeTarget: "Message",
        sendTarget: "Send"
      },
      metadata: {
        threadKey: "thread-a",
        replyThreadKey: "thread-a",
        messageId: "thread-a-msg-3",
        sender: "Candidate",
        direction: "inbound",
        receivedAt: new Date().toISOString(),
        requiresAttention: true
      },
      taskSpec: {
        goal: "Prepare the approved reply for thread A",
        preferredSurface: "desktop",
        steps: [
          {
            label: "Write approved reply receipt",
            surface: "desktop",
            action: "writeFileText",
            params: {
              path: "thread-a/approved.txt",
              text: "approved"
            },
            checkpoint: false
          }
        ]
      }
    },
    {
      fingerprint: "thread-a-msg-4",
      summary: "Thread A fourth follow-up",
      replyText: "Thanks, I saw this.",
      inputs: {
        typeTarget: "Message",
        sendTarget: "Send"
      },
      metadata: {
        threadKey: "thread-a",
        replyThreadKey: "thread-a",
        messageId: "thread-a-msg-4",
        sender: "Candidate",
        direction: "inbound",
        receivedAt: new Date().toISOString(),
        requiresAttention: true
      },
      taskSpec: {
        goal: "Send the recovery reply for thread A",
        preferredSurface: "desktop",
        steps: [
          {
            label: "Write recovery reply receipt",
            surface: "desktop",
            action: "writeFileText",
            params: {
              path: "thread-a/recovered.txt",
              text: "recovered"
            },
            checkpoint: false
          }
        ]
      }
    }
  ];
  const fakeLivePack = {
    async detectNewItems() {
      return queuedDetections.shift() ?? null;
    }
  };
  const server = await startAgentServer({
    dataDir,
    livePacks: {
      "threaded-live": fakeLivePack
    }
  });

  try {
    const createResponse = await fetch(`${server.baseUrl}/watches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Always watch the threaded inbox and reply automatically",
        livePack: "threaded-live",
        preferredSurface: "desktop",
        pollIntervalMs: 50,
        governance: {
          replyPolicy: "auto_send"
        }
      })
    });
    const { watch } = await createResponse.json();

    const firstTasks = await waitForWatchTasks(server.baseUrl, watch.id, 1);
    const firstTask = firstTasks[0];
    const firstCompleted = await waitForTask(server.baseUrl, firstTask.id, (task) => task.status === "completed");
    assert.equal(firstCompleted.status, "completed");

    const secondTasks = await waitForWatchTasks(server.baseUrl, watch.id, 2);
    const secondTask = secondTasks.find((task) => task.id !== firstTask.id);
    if (!secondTask) {
      throw new Error("Expected a second watch task after the first auto-send.");
    }
    const failedTask = await waitForTask(server.baseUrl, secondTask.id, (task) => task.status === "failed");
    assert.equal(failedTask.status, "failed");

    const escalatedWatch = await waitForWatchRule(
      server.baseUrl,
      watch.id,
      (current) => current.status === "backoff" && current.health.threadFailureCount === 1 && Boolean(current.health.threadEscalatedAt)
    );
    assert.equal(escalatedWatch.health.threadKey, "thread-a");
    assert.match(String(escalatedWatch.lastError ?? ""), /ENOENT|no such file/i);

    const pendingDraft = await waitForDraft(
      server.baseUrl,
      (draft) => draft.watchRuleId === watch.id && draft.fingerprint === "thread-a-msg-3" && draft.status === "pending",
      15000
    );
    assert.equal(pendingDraft.riskDecision.action, "draft");
    assert.ok(
      pendingDraft.riskDecision.reasons.some((reason) => String(reason).includes("re-approval after a failed auto-send"))
    );

    const awaitingApproval = await waitForWatchRule(
      server.baseUrl,
      watch.id,
      (current) => current.status === "awaiting_approval" && current.health.threadFailureCount === 1
    );
    assert.equal(awaitingApproval.health.threadKey, "thread-a");
    assert.equal(awaitingApproval.health.activeDraftId, pendingDraft.id);

    const approvedResponse = await fetch(`${server.baseUrl}/drafts/${pendingDraft.id}/approve`, {
      method: "POST"
    });
    const approvedPayload = await approvedResponse.json();
    const approvedTask = await waitForTask(server.baseUrl, approvedPayload.draft.taskId, (task) => task.status === "completed");
    assert.equal(approvedTask.status, "completed");

    const resetWatch = await waitForWatchRule(
      server.baseUrl,
      watch.id,
      (current) => current.health.threadFailureCount === 0 && current.health.threadEscalatedAt == null
    );
    assert.equal(resetWatch.health.threadKey, "thread-a");

    const fourthTasks = await waitForWatchTasks(server.baseUrl, watch.id, 4, 15000);
    const recoveryTask = fourthTasks.find(
      (task) => ![firstTask.id, secondTask.id, approvedPayload.draft.taskId].includes(task.id)
    );
    if (!recoveryTask) {
      throw new Error("Expected a recovery auto-send task after approval reset the thread.");
    }
    const recovered = await waitForTask(server.baseUrl, recoveryTask.id, (task) => task.status === "completed");
    assert.equal(recovered.status, "completed");

    const finalWatch = await waitForWatchRule(
      server.baseUrl,
      watch.id,
      (current) => current.health.threadFailureCount === 0 && current.health.threadEscalatedAt == null
    );
    assert.equal(finalWatch.health.threadKey, "thread-a");
    assert.equal(finalWatch.health.lastInboundMessageId, "thread-a-msg-4");
    assert.ok(finalWatch.health.lastAgentActionAt);
  } finally {
    await server.close();
  }
});

test("approve-once reply leases stay scoped to a single conversation thread", async () => {
  const dataDir = await createTempDir();
  const queuedDetections = [
    {
      fingerprint: "thread-a-msg-1",
      summary: "Thread A initial reply",
      replyText: "Thanks, I saw this.",
      inputs: {
        typeTarget: "Message",
        sendTarget: "Send"
      },
      metadata: {
        threadKey: "thread-a",
        replyThreadKey: "thread-a",
        messageId: "thread-a-msg-1",
        sender: "Candidate A",
        direction: "inbound",
        receivedAt: new Date().toISOString(),
        requiresAttention: true
      },
      taskSpec: {
        goal: "Handle thread A reply after approval",
        preferredSurface: "desktop",
        steps: [
          {
            label: "Write thread A receipt",
            surface: "desktop",
            action: "writeFileText",
            params: {
              path: "thread-a/reply.txt",
              text: "thread-a"
            },
            checkpoint: false
          }
        ]
      }
    },
    {
      fingerprint: "thread-b-msg-1",
      summary: "Thread B needs approval too",
      replyText: "Thanks, I saw this.",
      inputs: {
        typeTarget: "Message",
        sendTarget: "Send"
      },
      metadata: {
        threadKey: "thread-b",
        replyThreadKey: "thread-b",
        messageId: "thread-b-msg-1",
        sender: "Candidate B",
        direction: "inbound",
        receivedAt: new Date().toISOString(),
        requiresAttention: true
      },
      taskSpec: {
        goal: "Handle thread B reply only after approval",
        preferredSurface: "desktop",
        steps: [
          {
            label: "Write thread B receipt",
            surface: "desktop",
            action: "writeFileText",
            params: {
              path: "thread-b/reply.txt",
              text: "thread-b"
            },
            checkpoint: false
          }
        ]
      }
    }
  ];
  const fakeLivePack = {
    async detectNewItems() {
      return queuedDetections.shift() ?? null;
    }
  };
  const server = await startAgentServer({
    dataDir,
    livePacks: {
      "threaded-lease-live": fakeLivePack
    }
  });

  try {
    const createResponse = await fetch(`${server.baseUrl}/watches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Always watch the threaded inbox and use approve once",
        livePack: "threaded-lease-live",
        preferredSurface: "desktop",
        pollIntervalMs: 50,
        governance: {
          replyPolicy: "approve_once_then_auto",
          replyApprovalWindowMs: 600000
        }
      })
    });
    const { watch } = await createResponse.json();

    const firstDraft = await waitForDraft(
      server.baseUrl,
      (draft) => draft.watchRuleId === watch.id && draft.fingerprint === "thread-a-msg-1" && draft.status === "pending"
    );
    assert.equal(firstDraft.metadata.replyThreadKey, "thread-a");

    const approvedResponse = await fetch(`${server.baseUrl}/drafts/${firstDraft.id}/approve`, {
      method: "POST"
    });
    const approvedPayload = await approvedResponse.json();
    const approvedWatchPayload = await (await fetch(`${server.baseUrl}/watches/${watch.id}`)).json();
    assert.equal(approvedWatchPayload.watch.health.threadKey, "thread-a");
    assert.ok(approvedWatchPayload.watch.health.replyLeaseExpiresAt);
    const completed = await waitForTask(server.baseUrl, approvedPayload.draft.taskId, (task) => task.status === "completed");
    assert.equal(completed.status, "completed");

    const secondDraft = await waitForDraft(
      server.baseUrl,
      (draft) => draft.watchRuleId === watch.id && draft.fingerprint === "thread-b-msg-1" && draft.status === "pending",
      15000
    );
    assert.equal(secondDraft.metadata.replyThreadKey, "thread-b");
    assert.equal(secondDraft.riskDecision.action, "draft");

    const tasksPayload = await (await fetch(`${server.baseUrl}/tasks`)).json();
    assert.equal(tasksPayload.tasks.filter((task) => task.triggerSource === `watch:${watch.id}`).length, 1);

    const pendingWatch = await waitForWatchRule(
      server.baseUrl,
      watch.id,
      (current) => current.status === "awaiting_approval" && current.health.threadKey === "thread-b"
    );
    assert.equal(pendingWatch.health.activeDraftId, secondDraft.id);
    assert.equal(pendingWatch.health.replyLeaseExpiresAt, null);
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
    assert.equal(typeof doctorPayload.doctor.readyLivePackCount, "number");
    assert.equal(typeof doctorPayload.doctor.blockedLivePackCount, "number");

    const packsPayload = await (await fetch(`${server.baseUrl}/packs`)).json();
    assert.ok(packsPayload.packs.some((pack) => pack.name === "generic-mail-browser"));
    assert.ok(packsPayload.packs.some((pack) => pack.name === "slack-desktop"));
    assert.ok(packsPayload.packs.some((pack) => pack.name === "slack-browser"));
    assert.ok(packsPayload.packs.some((pack) => pack.name === "wechat-desktop"));
    assert.ok(packsPayload.packs.some((pack) => pack.name === "generic-mail-desktop"));
    assert.ok(packsPayload.packs.some((pack) => pack.name === "boss-browser"));
    assert.ok(packsPayload.packs.some((pack) => pack.name === "google-drive-browser"));
    assert.ok(packsPayload.packs.some((pack) => pack.name === "google-docs-browser"));
    assert.ok(packsPayload.packs.some((pack) => pack.name === "feishu-docs-browser"));
    assert.equal(packsPayload.packs.find((pack) => pack.name === "slack-browser")?.defaultReplyPolicy, "auto_send");
    assert.equal(packsPayload.packs.find((pack) => pack.name === "generic-mail-browser")?.defaultReplyPolicy, "draft_first");
    assert.equal(packsPayload.packs.find((pack) => pack.name === "boss-browser")?.defaultReplyPolicy, "draft_first");
    assert.equal(packsPayload.packs.find((pack) => pack.name === "slack-browser")?.category, "conversation");
    assert.equal(packsPayload.packs.find((pack) => pack.name === "google-docs-browser")?.category, "documents");
    assert.equal(packsPayload.packs.find((pack) => pack.name === "google-drive-browser")?.category, "files");
    assert.ok(packsPayload.packs.find((pack) => pack.name === "slack-browser")?.capabilities.includes("thread_context"));
    assert.ok(packsPayload.packs.find((pack) => pack.name === "boss-browser")?.capabilities.includes("candidate_review"));
    assert.ok(Array.isArray(packsPayload.packs.find((pack) => pack.name === "slack-browser")?.healthChecks));
    assert.equal(typeof packsPayload.packs.find((pack) => pack.name === "slack-browser")?.ready, "boolean");
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

test("slack browser watch rules can prefill replies without sending them", async () => {
  const dataDir = await createTempDir();
  const slack = await startSlackFixtureServer();
  const server = await startAgentServer({ dataDir });

  try {
    const createResponse = await fetch(`${server.baseUrl}/watches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Always watch Slack and prefill replies to unread threads",
        preferredSurface: "browser",
        workspaceName: "slack-browser-prefill-main",
        pollIntervalMs: 50,
        governance: {
          replyPolicy: "prefill_first"
        },
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
    assert.equal(completed.taskSpec.inputs.autoSend, false);
    assert.equal(completed.plan.some((step) => /send/i.test(String(step.label ?? ""))), false);

    const state = await waitForValue(() => slack.getState(), (current) => String(current.draftText ?? "").trim().length > 0);
    assert.equal(state.sentReplies.length, 0);
    assert.equal(state.draftText, "Got it. I will follow up shortly.");

    const draftsPayload = await (await fetch(`${server.baseUrl}/drafts`)).json();
    assert.equal(draftsPayload.drafts.filter((draft) => draft.watchRuleId === watch.id).length, 0);
  } finally {
    await server.close();
    await slack.close();
  }
});

test("watch rules degrade with a manual step when a live pack requires sign-in", async () => {
  const dataDir = await createTempDir();
  const fakeLivePack = {
    async detectNewItems() {
      return {
        fingerprint: "manual-sign-in-1",
        summary: "Slack needs sign-in",
        metadata: {
          surface: "browser",
          requiresAttention: true,
          requiresManualIntervention: true,
          manualInterventionKind: "login",
          manualInterventionDetail: "Slack is asking for sign-in before AgentOS can continue watching it.",
          manualInterventionAction: "Open Slack in the AgentOS browser workspace and sign in once, then retry the watch."
        }
      };
    }
  };
  const server = await startAgentServer({
    dataDir,
    livePacks: {
      "manual-sign-in-live": fakeLivePack
    }
  });

  try {
    const createResponse = await fetch(`${server.baseUrl}/watches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Always watch this app and handle new items",
        livePack: "manual-sign-in-live",
        preferredSurface: "browser",
        workspaceName: "manual-sign-in-main",
        pollIntervalMs: 50
      })
    });
    const { watch } = await createResponse.json();
    assert.equal(watch.livePack, "manual-sign-in-live");

    const degraded = await waitForWatchRule(
      server.baseUrl,
      watch.id,
      (current) => current.status === "degraded" && current.health.attentionKind === "login"
    );
    assert.match(String(degraded.lastError ?? ""), /sign-in|sign in|登录/i);
    assert.match(String(degraded.health.attentionDetail ?? ""), /Slack/i);
    assert.match(String(degraded.health.attentionAction ?? ""), /sign in/i);

    await new Promise((resolve) => setTimeout(resolve, 300));
    const tasksPayload = await (await fetch(`${server.baseUrl}/tasks`)).json();
    const draftsPayload = await (await fetch(`${server.baseUrl}/drafts`)).json();
    assert.equal(tasksPayload.tasks.filter((task) => task.triggerSource === `watch:${watch.id}`).length, 0);
    assert.equal(draftsPayload.drafts.filter((draft) => draft.watchRuleId === watch.id).length, 0);
  } finally {
    await server.close();
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
        id: "nav-threads",
        surface: "desktop",
        kind: "text",
        text: "@ Threads",
        role: "button",
        bounds: { x: 10, y: 10, width: 140, height: 24, centerX: 80, centerY: 22 },
        confidence: 0.8,
        sourceHints: { source: "ocr", ariaLabel: "Threads" },
        isInteractive: true
      },
      {
        id: "nav-drafts",
        surface: "desktop",
        kind: "text",
        text: "Drafts & sent",
        role: "button",
        bounds: { x: 10, y: 40, width: 140, height: 24, centerX: 80, centerY: 52 },
        confidence: 0.8,
        sourceHints: { source: "ocr" },
        isInteractive: true
      },
      {
        id: "thread-acme",
        surface: "desktop",
        kind: "text",
        text: "Unread: Acme renewal",
        role: "button",
        bounds: { x: 10, y: 10, width: 140, height: 24, centerX: 80, centerY: 22 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", ariaLabel: "Unread thread Acme renewal", actions: ["AXPress"] },
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
        confidence: 0.98,
        sourceHints: { source: "accessibility", placeholder: "Message", actions: ["AXPress"] },
        isInteractive: true
      },
      {
        id: "send",
        surface: "desktop",
        kind: "text",
        text: "Send",
        role: "button",
        bounds: { x: 260, y: 200, width: 60, height: 32, centerX: 290, centerY: 216 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", actions: ["AXPress"] },
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
  assert.equal(detection?.metadata?.threadKey, "acme renewal");
  const openCandidate = detection?.metadata?.openCandidate as { sourceHints?: { source?: string } } | undefined;
  assert.equal(openCandidate?.sourceHints?.source, "accessibility");

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
  assert.equal(context?.metadata?.threadKey, "acme renewal");
  assert.equal(context?.metadata?.sender, "Customer");
  assert.equal(Array.isArray(context?.taskSpec?.steps), true);
  assert.equal(context?.taskSpec?.steps?.[0]?.action, "clickTarget");
  assert.equal(context?.taskSpec?.steps?.[2]?.params?.text, "{{typeText}}");
});

test("slack desktop pack ignores detections when Slack is not the foreground app", async () => {
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({})
  });
  const pack = registry.get("slack-desktop");
  const rule: WatchRule = {
    id: "watch-slack-background",
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
    id: "profile-slack-background",
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
    worldState: {
      version: 1,
      surface: "desktop",
      workspaceId: "workspace-terminal",
      appContext: {
        appName: "Terminal",
        windows: [{ title: "Terminal" }]
      },
      capture: null,
      ocrBlocks: [],
      interactionCandidates: [
        {
          id: "thread-bad-read",
          surface: "desktop",
          kind: "text",
          text: "# bonkr",
          role: "button",
          bounds: { x: 10, y: 10, width: 120, height: 24, centerX: 70, centerY: 22 },
          confidence: 0.8,
          sourceHints: { source: "ocr", ariaLabel: "Unread thread bonkr" },
          isInteractive: true
        }
      ],
      visibleText: "Terminal\nnode --trace-warnings\n# bonkr",
      recentActions: [],
      summary: "Terminal",
      timestamp: new Date().toISOString()
    } as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {} as never
  });

  assert.equal(detection, null);
});

test("slack desktop pack ignores OCR-only detections when no accessibility candidates are available", async () => {
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({})
  });
  const pack = registry.get("slack-desktop");
  const rule: WatchRule = {
    id: "watch-slack-ocr-only",
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
    id: "profile-slack-ocr-only",
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
    worldState: {
      version: 1,
      surface: "desktop",
      workspaceId: "workspace-slack-ocr-only",
      appContext: {
        appName: "Slack",
        windows: [{ title: "Slack" }]
      },
      capture: null,
      ocrBlocks: [],
      interactionCandidates: [
        {
          id: "ocr-close",
          surface: "desktop",
          kind: "text",
          text: "close button",
          role: "button",
          bounds: { x: 12, y: 12, width: 24, height: 24, centerX: 24, centerY: 24 },
          confidence: 0.72,
          sourceHints: { source: "ocr" },
          isInteractive: true
        },
        {
          id: "ocr-thread",
          surface: "desktop",
          kind: "text",
          text: "# bonkr",
          role: "button",
          bounds: { x: 32, y: 96, width: 120, height: 24, centerX: 92, centerY: 108 },
          confidence: 0.76,
          sourceHints: { source: "ocr" },
          isInteractive: true
        }
      ],
      visibleText: "Slack\nclose button\n# bonkr",
      recentActions: [],
      summary: "Slack with 0 accessibility candidates and 2 OCR observations",
      timestamp: new Date().toISOString()
    } as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {} as never
  });

  assert.equal(detection, null);
});

test("slack desktop pack skips reply context extraction when composer is missing", async () => {
  let opened = false;
  const initialWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-slack-missing-composer",
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
        text: "Unread thread Acme renewal",
        role: "row",
        bounds: { x: 10, y: 10, width: 180, height: 24, centerX: 100, centerY: 22 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", ariaLabel: "Unread thread Acme renewal", actions: ["AXPress"] },
        isInteractive: true
      }
    ],
    visibleText: "Slack\nUnread\nAcme renewal",
    recentActions: [],
    summary: "Slack unread list",
    timestamp: new Date().toISOString()
  };
  const threadWorldState = {
    ...initialWorldState,
    interactionCandidates: [
      {
        id: "thread-acme-open",
        surface: "desktop",
        kind: "text",
        text: "Acme renewal",
        role: "row",
        bounds: { x: 10, y: 10, width: 180, height: 24, centerX: 100, centerY: 22 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", ariaLabel: "Acme renewal", actions: ["AXPress"] },
        isInteractive: true
      }
    ],
    visibleText: "Slack\nAcme renewal\nCustomer: Any update?"
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
    id: "watch-slack-missing-composer",
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
    id: "profile-slack-missing-composer",
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

  assert.equal(context, null);
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
        role: "button",
        bounds: { x: 10, y: 10, width: 160, height: 24, centerX: 90, centerY: 22 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", ariaLabel: "未读会话 张三", actions: ["AXPress"] },
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
        role: "button",
        bounds: { x: 10, y: 10, width: 160, height: 24, centerX: 90, centerY: 22 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", ariaLabel: "张三", actions: ["AXPress"] },
        isInteractive: true
      },
      {
        id: "compose",
        surface: "desktop",
        kind: "text",
        text: "输入消息",
        role: "textbox",
        bounds: { x: 10, y: 210, width: 240, height: 32, centerX: 130, centerY: 226 },
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
        bounds: { x: 260, y: 210, width: 60, height: 32, centerX: 290, centerY: 226 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", actions: ["AXPress"] },
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
  assert.equal(detection?.metadata?.threadKey, "张三");
  const openCandidate = detection?.metadata?.openCandidate as { sourceHints?: { source?: string } } | undefined;
  assert.equal(openCandidate?.sourceHints?.source, "accessibility");

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
  assert.equal(context?.metadata?.threadKey, "张三");
  assert.equal(context?.metadata?.sender, "客户");
  assert.equal(Array.isArray(context?.taskSpec?.steps), true);
  assert.equal(context?.taskSpec?.steps?.[0]?.action, "clickTarget");
  assert.equal(context?.taskSpec?.steps?.[2]?.params?.text, "{{typeText}}");
});

test("wechat desktop pack ignores detections when WeChat is not the foreground app", async () => {
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({})
  });
  const pack = registry.get("wechat-desktop");
  const rule: WatchRule = {
    id: "watch-wechat-background",
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
    id: "profile-wechat-background",
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
    worldState: {
      version: 1,
      surface: "desktop",
      workspaceId: "workspace-terminal",
      appContext: {
        appName: "Terminal",
        windows: [{ title: "Terminal" }]
      },
      capture: null,
      ocrBlocks: [],
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
        }
      ],
      visibleText: "Terminal\nnpm test\n未读: 张三",
      recentActions: [],
      summary: "Terminal",
      timestamp: new Date().toISOString()
    } as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {} as never
  });

  assert.equal(detection, null);
});

test("boss browser pack can extract candidate thread context and build approval-first reply steps", async () => {
  let opened = false;
  const initialWorldState = {
    version: 1,
    surface: "browser",
    workspaceId: "workspace-boss",
    appContext: {
      title: "BOSS直聘",
      url: "http://boss.local/boss"
    },
    capture: null,
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "boss-candidate",
        surface: "browser",
        kind: "link",
        text: "新候选人: 李雷 · 产品经理",
        role: "link",
        bounds: { x: 10, y: 10, width: 220, height: 28, centerX: 120, centerY: 24 },
        confidence: 0.88,
        sourceHints: { source: "browser", ariaLabel: "新候选人: 李雷 产品经理", href: "/boss/candidate?id=li-lei" },
        isInteractive: true
      }
    ],
    visibleText: "BOSS直聘\n新候选人\n新候选人: 李雷 · 产品经理\n5年经验 · 上海\n候选人: 方便聊下这个岗位吗？",
    recentActions: [],
    summary: "BOSS candidate list",
    timestamp: new Date().toISOString()
  };
  const threadWorldState = {
    ...initialWorldState,
    appContext: {
      title: "李雷 - BOSS直聘",
      url: "http://boss.local/boss/candidate?id=li-lei"
    },
    interactionCandidates: [
      {
        id: "reply-box",
        surface: "browser",
        kind: "textarea",
        text: "",
        role: "textbox",
        bounds: { x: 10, y: 260, width: 260, height: 72, centerX: 140, centerY: 296 },
        confidence: 0.86,
        sourceHints: { source: "browser", placeholder: "发送消息给李雷", tag: "textarea" },
        isInteractive: true
      },
      {
        id: "send",
        surface: "browser",
        kind: "button",
        text: "发送",
        role: "button",
        bounds: { x: 280, y: 260, width: 64, height: 32, centerX: 312, centerY: 276 },
        confidence: 0.86,
        sourceHints: { source: "browser", ariaLabel: "发送消息", tag: "button" },
        isInteractive: true
      }
    ],
    visibleText: "BOSS直聘\n李雷\n产品经理\n5年经验\n上海\n候选人: 方便聊下这个岗位吗？\n发送消息给李雷\n发送\n在线沟通"
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
      browser: fakeSurface as never
    })
  });
  const pack = registry.get("boss-browser");
  const rule: WatchRule = {
    id: "watch-boss-browser",
    goal: "Always watch BOSS直聘 and reply to candidate messages",
    enabled: true,
    status: "watching",
    preferredSurface: "browser",
    workspaceName: "boss-browser-main",
    skillName: null,
    appTarget: null,
    livePack: "boss-browser",
    pollIntervalMs: 1000,
    watchProfile: {},
    taskInputs: {
      startUrl: "http://boss.local/boss"
    },
    dedupeState: {},
    lastObservedAt: null,
    lastTriggeredAt: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const workspace: WorkspaceProfile = {
    id: "profile-boss",
    name: "boss-browser-main",
    rootPath: "/tmp/boss-browser-main",
    profilePath: "/tmp/boss-browser-main/profile",
    downloadsPath: "/tmp/boss-browser-main/downloads",
    artifactsPath: "/tmp/boss-browser-main/artifacts",
    scratchPath: "/tmp/boss-browser-main/scratch",
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
  assert.equal(detection?.summary, "李雷 · 产品经理");
  assert.equal(detection?.metadata?.threadKey, "李雷 · 产品经理");
  assert.equal(detection?.metadata?.sender, "候选人");
  assert.equal(detection?.metadata?.direction, "inbound");

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
  assert.equal(context?.inputs?.typeTarget, "发送消息给李雷");
  assert.equal(context?.inputs?.sendTarget, "发送");
  assert.equal(context?.metadata?.threadKey, "李雷 · 产品经理");
  assert.equal(context?.metadata?.sender, "候选人");
  assert.equal(context?.taskSpec?.skillName, null);
  assert.equal(Array.isArray(context?.taskSpec?.steps), true);
  assert.equal(context?.taskSpec?.steps?.[0]?.action, "clickTarget");
  assert.equal(context?.taskSpec?.steps?.[2]?.params?.text, "{{typeText}}");
  assert.equal(context?.context?.some((line) => line.includes("候选人: 方便聊下这个岗位吗？")), true);
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

test("boss browser watch rules infer the browser pack and trigger candidate review workflows", async () => {
  const dataDir = await createTempDir();
  const boss = await startBossFixtureServer();
  const server = await startAgentServer({ dataDir });

  try {
    const createResponse = await fetch(`${server.baseUrl}/watches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Always watch BOSS直聘 for new candidates and review them.",
        preferredSurface: "browser",
        workspaceName: "boss-browser-main",
        pollIntervalMs: 50,
        inputs: {
          startUrl: `${boss.url}/boss`
        }
      })
    });
    const { watch } = await createResponse.json();
    assert.equal(watch.livePack, "boss-browser");

    const triggeredTask = await waitForWatchTask(server.baseUrl, watch.id);
    const completed = await waitForTask(server.baseUrl, triggeredTask.id, (task) => task.status === "completed");
    assert.equal(completed.status, "completed");
    assert.equal(completed.taskSpec.skillName, "boss-open-candidate");
    assert.match(String(completed.taskSpec.inputs.openTarget ?? ""), /李雷/u);

    const state = await boss.getState();
    assert.equal(state.sentReplies.length, 0);
    assert.equal(state.viewedCandidateId, state.candidateId);
    assert.ok(state.viewCount >= 1);
  } finally {
    await server.close();
    await boss.close();
  }
});

test("boss browser watch rules draft candidate replies and approved drafts send messages", async () => {
  const dataDir = await createTempDir();
  const boss = await startBossFixtureServer();
  const server = await startAgentServer({ dataDir });

  try {
    const createResponse = await fetch(`${server.baseUrl}/watches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Always watch BOSS直聘 and reply to candidate messages",
        preferredSurface: "browser",
        workspaceName: "boss-browser-reply-main",
        pollIntervalMs: 50,
        inputs: {
          startUrl: `${boss.url}/boss`
        }
      })
    });
    const { watch } = await createResponse.json();
    assert.equal(watch.livePack, "boss-browser");

    const pendingDraft = await waitForDraft(
      server.baseUrl,
      (draft) => draft.watchRuleId === watch.id && draft.livePack === "boss-browser" && draft.status === "pending"
    );
    assert.equal(pendingDraft.riskDecision.action, "draft");

    let state = await boss.getState();
    assert.equal(state.sentReplies.length, 0);

    const approvedResponse = await fetch(`${server.baseUrl}/drafts/${pendingDraft.id}/approve`, {
      method: "POST"
    });
    const approvedPayload = await approvedResponse.json();
    assert.equal(approvedPayload.draft.status, "approved");

    const completed = await waitForTask(server.baseUrl, approvedPayload.draft.taskId, (task) => task.status === "completed");
    assert.equal(completed.status, "completed");
    assert.equal(completed.taskSpec.skillName, null);

    state = await boss.getState();
    assert.equal(state.sentReplies.length, 1);
    assert.equal(state.sentReplies[0].message, "你好，我已看到你的信息，会尽快查看并和你沟通后续。");
  } finally {
    await server.close();
    await boss.close();
  }
});

test("boss browser watch rules can auto-send follow-ups after one approval when reply policy allows it", async () => {
  const dataDir = await createTempDir();
  const boss = await startBossFixtureServer();
  const server = await startAgentServer({ dataDir });

  try {
    const createResponse = await fetch(`${server.baseUrl}/watches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Always watch BOSS直聘 and reply to candidate messages",
        preferredSurface: "browser",
        workspaceName: "boss-browser-reply-auto-main",
        pollIntervalMs: 50,
        governance: {
          replyPolicy: "approve_once_then_auto",
          replyApprovalWindowMs: 600000
        },
        inputs: {
          startUrl: `${boss.url}/boss`
        }
      })
    });
    const { watch } = await createResponse.json();

    const pendingDraft = await waitForDraft(
      server.baseUrl,
      (draft) => draft.watchRuleId === watch.id && draft.livePack === "boss-browser" && draft.status === "pending"
    );
    const approvedResponse = await fetch(`${server.baseUrl}/drafts/${pendingDraft.id}/approve`, {
      method: "POST"
    });
    const approvedPayload = await approvedResponse.json();
    const firstCompleted = await waitForTask(server.baseUrl, approvedPayload.draft.taskId, (task) => task.status === "completed");
    assert.equal(firstCompleted.status, "completed");

    let state = await waitForValue(() => boss.getState(), (current) => current.sentReplies.length === 1);
    assert.equal(state.sentReplies[0].message, "你好，我已看到你的信息，会尽快查看并和你沟通后续。");

    await boss.pushIncomingMessage("候选人: 我这周三下午可以沟通。");

    state = await waitForValue(() => boss.getState(), (current) => current.sentReplies.length === 2, 15000);
    assert.equal(state.sentReplies[1].message, "你好，我已看到你的信息，会尽快查看并和你沟通后续。");

    const draftsPayload = await (await fetch(`${server.baseUrl}/drafts`)).json();
    assert.equal(draftsPayload.drafts.filter((draft) => draft.watchRuleId === watch.id).length, 1);

    const tasksPayload = await (await fetch(`${server.baseUrl}/tasks`)).json();
    assert.equal(tasksPayload.tasks.filter((task) => task.triggerSource === `watch:${watch.id}`).length, 2);
  } finally {
    await server.close();
    await boss.close();
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

test("google drive browser watch rules can route download requests to the download workflow", async () => {
  const dataDir = await createTempDir();
  const fixture = await startDocsFilesFixtureServer();
  const server = await startAgentServer({ dataDir });

  try {
    const createResponse = await fetch(`${server.baseUrl}/watches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Always watch Google Drive for pending downloads and process them.",
        preferredSurface: "browser",
        workspaceName: "drive-download-watch-main",
        pollIntervalMs: 50,
        watchProfile: {
          triggerTexts: ["pending download", "download request", "download shared file"]
        },
        inputs: {
          startUrl: `${fixture.url}/google-drive`,
          downloadTarget: "Download shared file",
          downloadFileName: "drive-watch-report.txt"
        }
      })
    });
    const { watch } = await createResponse.json();
    assert.equal(watch.livePack, "google-drive-browser");

    const triggeredTask = await waitForWatchTask(server.baseUrl, watch.id);
    const completed = await waitForTask(server.baseUrl, triggeredTask.id, (task) => task.status === "completed");
    assert.equal(completed.status, "completed");
    assert.equal(completed.taskSpec.skillName, "google-drive-download-file");

    const downloadedFilePath = `${dataDir}/workspace-profiles/drive-download-watch-main/downloads/drive-watch-report.txt`;
    const downloadedContent = await fs.readFile(downloadedFilePath, "utf8");
    assert.match(downloadedContent, /Quarterly report/u);
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

test("watch deletion removes the rule and subsequent lookups return 404", async () => {
  const dataDir = await createTempDir();
  const fakeLivePack = {
    async detectNewItems() {
      return null;
    }
  };
  const server = await startAgentServer({
    dataDir,
    livePacks: {
      "delete-live": fakeLivePack
    }
  });

  try {
    const createResponse = await fetch(`${server.baseUrl}/watches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Watch this dummy goal",
        livePack: "delete-live",
        preferredSurface: "desktop",
        workspaceName: "delete-main",
        pollIntervalMs: 50
      })
    });
    const { watch } = await createResponse.json();

    const deleteResponse = await fetch(`${server.baseUrl}/watches/${watch.id}`, {
      method: "DELETE"
    });
    const deletePayload = await deleteResponse.json();
    assert.equal(deletePayload.ok, true);

    await waitForWatchDeletion(server.baseUrl, watch.id);

    const getResponse = await fetch(`${server.baseUrl}/watches/${watch.id}`);
    assert.equal(getResponse.status, 404);
    const notFoundPayload = await getResponse.json();
    assert.equal(notFoundPayload.error, "Watch rule not found");
  } finally {
    await server.close();
  }
});

test("watch deletion waits for in-flight scans before deleting", async () => {
  const dataDir = await createTempDir();
  let resolveScanHold = () => {};
  const scanHold = new Promise<void>((resolve) => {
    resolveScanHold = resolve;
  });
  let scanStarted = false;
  let notifyScanStarted = () => {};
  const scanStartedSignal = new Promise<void>((resolve) => {
    notifyScanStarted = () => {
      if (!scanStarted) {
        scanStarted = true;
        resolve();
      }
    };
  });

  const server = await startAgentServer({
    dataDir,
    livePacks: {
      "delete-race-live": {
        async detectNewItems() {
          notifyScanStarted();
          await scanHold;
          return null;
        }
      }
    }
  });

  try {
    const createResponse = await fetch(`${server.baseUrl}/watches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Watch this dummy goal",
        livePack: "delete-race-live",
        preferredSurface: "desktop",
        workspaceName: "delete-race-main",
        pollIntervalMs: 50
      })
    });
    const { watch } = await createResponse.json();

    await Promise.race([
      scanStartedSignal,
      new Promise((_, reject) => setTimeout(() => reject(new Error("scan did not start")), 500))
    ]);

    const releaseScanHandle = setTimeout(() => resolveScanHold(), 30);
    const deleteResponse = await fetch(`${server.baseUrl}/watches/${watch.id}`, {
      method: "DELETE"
    });
    clearTimeout(releaseScanHandle);
    resolveScanHold();

    const deletePayload = await deleteResponse.json();
    assert.equal(deleteResponse.status, 200);
    assert.equal(deletePayload.ok, true);
    await waitForWatchDeletion(server.baseUrl, watch.id);

    const listResponse = await fetch(`${server.baseUrl}/watches`);
    const listPayload = await listResponse.json();
    assert.equal(
      listPayload.watches.some((candidate) => candidate.id === watch.id),
      false
    );
  } finally {
    resolveScanHold();
    await server.close();
  }
});

test("unknown watch rule endpoints return 404", async () => {
  const dataDir = await createTempDir();
  const server = await startAgentServer({ dataDir });

  try {
    const missingId = "no-such-watch-rule";

    const inspectResponse = await fetch(`${server.baseUrl}/watches/${missingId}`);
    assert.equal(inspectResponse.status, 404);
    const inspectPayload = await inspectResponse.json();
    assert.equal(inspectPayload.error, "Watch rule not found");

    const healthResponse = await fetch(`${server.baseUrl}/watches/${missingId}/health`);
    assert.equal(healthResponse.status, 404);
    const healthPayload = await healthResponse.json();
    assert.match(healthPayload.error, /Watch rule not found/);

    const enableResponse = await fetch(`${server.baseUrl}/watches/${missingId}/enable`, {
      method: "POST"
    });
    assert.equal(enableResponse.status, 404);
    const enablePayload = await enableResponse.json();
    assert.match(enablePayload.error, /Watch rule not found/);
  } finally {
    await server.close();
  }
});
