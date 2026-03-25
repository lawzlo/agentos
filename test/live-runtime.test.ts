import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";

import { ControlPlaneStore } from "../src/runtime/store.js";
import {
  LivePackRegistry,
  analyzeConversationPack,
  analyzeDesktopConversationPackWithVision
} from "../src/runtime/live-pack-registry.js";
import { SurfaceRegistry } from "../src/runtime/surface-registry.js";
import type { RuntimeStep, WatchRule, WorkspaceProfile } from "../src/types/runtime-schema.js";
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

function createPngHeaderBuffer(width: number, height: number) {
  const header = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

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

async function writePngHeader(path, width, height) {
  const header = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0);
  Buffer.from("IHDR").copy(header, 12);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  await fs.writeFile(path, header);
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

    const triggeredTask = await waitForWatchTask(server.baseUrl, watch.id, 20000);
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

    const triggeredTask = await waitForWatchTask(server.baseUrl, watch.id, 20000);
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

    const triggeredTask = await waitForWatchTask(server.baseUrl, watch.id, 20000);
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
    assert.ok(packsPayload.packs.some((pack) => pack.name === "outlook-desktop"));
    assert.ok(packsPayload.packs.some((pack) => pack.name === "generic-mail-desktop"));
    assert.ok(packsPayload.packs.some((pack) => pack.name === "boss-browser"));
    assert.ok(packsPayload.packs.some((pack) => pack.name === "google-drive-browser"));
    assert.ok(packsPayload.packs.some((pack) => pack.name === "google-docs-browser"));
    assert.ok(packsPayload.packs.some((pack) => pack.name === "feishu-docs-browser"));
    assert.equal(packsPayload.packs.find((pack) => pack.name === "slack-browser")?.defaultReplyPolicy, "auto_send");
    assert.equal(packsPayload.packs.find((pack) => pack.name === "outlook-desktop")?.defaultReplyPolicy, "draft_first");
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
      if (step.action === "clickTarget" || step.action === "clickAt") {
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
      modelClient: {
        isConfigured: () => false,
        supportsImageJson: () => true,
        analyzeImageJson: async () => {
          throw new Error("vision should be skipped when browser compose is already grounded");
        }
      }
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

test("slack desktop pack continues inbox observation even when AX readiness is unavailable", async () => {
  let observeCalls = 0;
  const fakeSurface = {
    async waitForAppReady() {
      return {
        ready: false,
        frontmostApp: "Slack",
        accessibilityCandidateCount: 0
      };
    },
    async observe() {
      observeCalls += 1;
      return {
        version: 1,
        surface: "desktop",
        workspaceId: "workspace-slack-ready",
        appContext: {
          appName: "Slack",
          windows: [{ title: "Slack" }]
        },
        capture: null,
        ocrBlocks: [],
        interactionCandidates: [],
        visibleText: "Slack",
        recentActions: [],
        summary: "Slack",
        timestamp: new Date().toISOString()
      };
    },
    async act() {
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
    id: "watch-slack-ready",
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
    id: "profile-slack-ready",
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

  const worldState = await pack?.observeInbox?.({
    rule,
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {} as never
  });

  assert.equal(worldState?.appContext?.appName, "Slack");
  assert.equal(observeCalls, 1);
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
      if (step.action === "clickTarget" || step.action === "clickAt") {
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

test("slack desktop pack can use visual model analysis to build a prefill task without AX candidates", async () => {
  const worldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-slack-vision",
    appContext: {
      appName: "Slack",
      windows: [
        {
          ownerName: "Slack",
          windowName: "Slack",
          bounds: { x: 80, y: 20, width: 1200, height: 820, centerX: 680, centerY: 430 }
        }
      ]
    },
    capture: {
      id: "artifact-slack-vision",
      taskId: "task-slack-vision",
      traceId: null,
      kind: "screenshot",
      label: "Slack vision state",
      path: "/tmp/slack-vision.png",
      metadata: {},
      createdAt: new Date().toISOString()
    },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Slack\nHome\nDMs\nBonkr v\nMessage Jingwen Sun",
    recentActions: [],
    summary: "Slack",
    timestamp: new Date().toISOString()
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({})
  });
  const pack = registry.get("slack-desktop");
  const rule: WatchRule = {
    id: "watch-slack-vision-detect",
    goal: "Always watch Slack and prefill replies",
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
    id: "profile-slack-vision",
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
    worldState: worldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async () => ({
          scene: "thread",
          sceneEvidence: "Unread direct message is visible and composer is open",
          recommendedRecoveryAction: "none",
          recoveryControl: { present: false, evidence: "", approxBox: null },
          openThread: "Bonkr v",
          visibleUnreadThreads: [
            {
              name: "Bonkr v",
              evidence: "Unread highlight in DM list",
              replyable: true,
              conversationKind: "direct",
              shouldReply: true,
              replyReason: "Unread direct message awaiting a reply.",
              latestSnippet: "Can you take a look at this?",
              priority: "high",
              approxBox: { x: 0.03, y: 0.2, width: 0.22, height: 0.06 }
            }
          ],
          composer: {
            present: true,
            evidence: "Message input box at the bottom",
            approxBox: { x: 0.28, y: 0.9, width: 0.64, height: 0.08 }
          }
        })
      }
    } as never
  });

  assert.equal(detection?.summary, "Bonkr v");
  assert.equal(detection?.inputs?.threadTitle, "Bonkr v");
  assert.equal(Number.isFinite(Number(detection?.inputs?.openX ?? NaN)), true);
  assert.equal(Number.isFinite(Number(detection?.inputs?.composeX ?? NaN)), true);
  assert.deepEqual(detection?.taskSpec?.steps.map((step) => step.label), [
    "Focus Slack",
    "Dismiss stray Slack overlay",
    "Open unread Slack thread",
    "Wait for Slack thread to open",
    "Focus Slack composer area",
    "Type Slack reply",
    "Verify Slack prefill"
  ]);
});

test("slack desktop pack recovers foreign views before selecting an unread thread", async () => {
  let recovered = false;
  const actions: string[] = [];
  const foreignWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-slack-recover",
    appContext: {
      appName: "Slack",
      windows: [
        {
          ownerName: "Slack",
          windowName: "Slack",
          bounds: { x: 80, y: 20, width: 1200, height: 820, centerX: 680, centerY: 430 }
        }
      ]
    },
    capture: { path: "/tmp/slack-foreign-view.png" },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Slack\nProfile\nMessage\nFiles",
    recentActions: [],
    summary: "Slack profile pane",
    timestamp: new Date().toISOString()
  };
  const listWorldState = {
    ...foreignWorldState,
    capture: { path: "/tmp/slack-list-view.png" },
    visibleText: "Slack\nDMs\nUnread\nBonkr v\nCan you take a look at this?"
  };
  const fakeSurface = {
    async observe() {
      return recovered ? listWorldState : foreignWorldState;
    },
    async act({ step }: { step: RuntimeStep }) {
      actions.push(`${step.action}:${String(step.label ?? step.id ?? "")}`);
      if (step.action === "clickAt" && String(step.label ?? "").includes("Recover Slack to conversation list")) {
        recovered = true;
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
    id: "watch-slack-recover",
    goal: "Always watch Slack and prefill replies",
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
    id: "profile-slack-recover",
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
    worldState: foreignWorldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async () => {
          if (!recovered) {
            return {
              scene: "foreign_view",
              sceneEvidence: "Profile pane is covering the DM list",
              recommendedRecoveryAction: "recover_to_list",
              recoveryControl: {
                present: true,
                evidence: "DM list entry is visible in the left rail",
                approxBox: { x: 0.07, y: 0.2, width: 0.12, height: 0.04 }
              },
              openThread: null,
              bestUnreadThread: {
                present: false,
                name: "",
                evidence: "",
                replyable: false,
                conversationKind: "unknown",
                shouldReply: false,
                replyReason: "",
                latestSnippet: "",
                priority: "low",
                approxBox: null
              },
              composer: { present: false, evidence: "", approxBox: null }
            };
          }
          return {
            scene: "list",
            sceneEvidence: "Unread DM is visible in the sidebar",
            recommendedRecoveryAction: "none",
            recoveryControl: { present: false, evidence: "", approxBox: null },
            openThread: null,
            bestUnreadThread: {
              present: true,
              name: "Bonkr v",
              evidence: "Unread highlight in DM list",
              replyable: true,
              conversationKind: "direct",
              shouldReply: true,
              replyReason: "Unread DM awaiting a reply",
              latestSnippet: "Can you take a look at this?",
              priority: "high",
              approxBox: { x: 0.04, y: 0.22, width: 0.22, height: 0.06 }
            },
            composer: {
              present: true,
              evidence: "Message input at the bottom",
              approxBox: { x: 0.28, y: 0.9, width: 0.64, height: 0.08 }
            }
          };
        }
      }
    } as never
  });

  assert.equal(detection?.summary, "Bonkr v");
  assert.equal((detection?.metadata as { recoveryAttempts?: unknown } | undefined)?.recoveryAttempts, 1);
  assert.equal(actions.includes("clickAt:Recover Slack to conversation list"), true);
});

test("wechat desktop pack can detect unread conversations and build reply steps from a desktop world state", async () => {
  const initialWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-wechat",
    appContext: {
      appName: "WeChat",
      windows: [
        {
          ownerName: "WeChat",
          windowName: "WeChat",
          bounds: { x: 100, y: 40, width: 900, height: 700, centerX: 550, centerY: 390 }
        }
      ]
    },
    capture: { path: "/tmp/wechat-thread-detect.png" },
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
  const fakeSurface = {
    async observe() {
      return initialWorldState;
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
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async () => ({
          openThread: "当前会话",
          visibleUnreadThreads: [
            {
              name: "张三",
              evidence: "red unread badge",
              approxSidebarY: 0.18,
              approxBox: { x: 0.08, y: 0.16, width: 0.26, height: 0.07 }
            }
          ],
          composer: {
            present: true,
            evidence: "bottom input area",
            approxBox: { x: 0.33, y: 0.82, width: 0.56, height: 0.12 }
          }
        })
      }
    } as never
  });
  assert.equal(detection?.summary, "张三");
  assert.equal(detection?.metadata?.threadKey, "张三");
  assert.equal(Number.isFinite(Number((detection?.metadata as { openPoint?: { x?: unknown } } | undefined)?.openPoint?.x ?? NaN)), true);

  const context = await pack?.extractContext?.({
    rule,
    worldState: initialWorldState as never,
    detection: detection as never,
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {} as never
  });
  assert.equal(Number(context?.inputs?.composeX ?? 0) > 0, true);
  assert.equal(Number(context?.inputs?.composeY ?? 0) > 0, true);
  assert.equal(context?.inputs?.threadTitle, "张三");
  assert.equal((context?.context ?? []).includes("客户: 明天下午方便吗？"), true);
  assert.equal(context?.metadata?.threadKey, "张三");
  assert.equal(context?.metadata?.threadVerificationDeferred, true);
  assert.equal(Array.isArray(context?.taskSpec?.steps), true);
  assert.equal(context?.taskSpec?.steps?.[0]?.action, "focusApp");
  assert.equal(context?.taskSpec?.steps?.[1]?.action, "pressKey");
  assert.equal(context?.taskSpec?.steps?.[2]?.action, "clickAt");
  assert.equal(context?.taskSpec?.steps?.[3]?.action, "wait");
  const verifyThreadExpect = context?.taskSpec?.steps?.[3]?.expect as {
    visualCheck?: { type?: string; targetThread?: string };
  } | undefined;
  const verifyPrefillExpectShifted = context?.taskSpec?.steps?.[6]?.expect as {
    visualCheck?: { type?: string; replyPreview?: string };
  } | undefined;
  assert.equal(verifyThreadExpect?.visualCheck?.type, "wechat_thread");
  assert.equal(verifyThreadExpect?.visualCheck?.targetThread, "{{threadTitle}}");
  assert.equal(context?.taskSpec?.steps?.[4]?.action, "clickAt");
  assert.equal(context?.taskSpec?.steps?.[5]?.action, "typeText");
  assert.equal(context?.taskSpec?.steps?.[6]?.action, "wait");
  assert.equal(verifyPrefillExpectShifted?.visualCheck?.type, "wechat_prefill");
  assert.equal(verifyPrefillExpectShifted?.visualCheck?.replyPreview, "{{typeTextPreview}}");
});

test("wechat desktop pack recovers foreign views with a visible recovery control before scanning unread conversations", async () => {
  let recovered = false;
  const actions: string[] = [];
  const foreignWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-wechat-foreign-view",
    appContext: {
      appName: "WeChat",
      windows: [
        {
          ownerName: "WeChat",
          windowName: "WeChat",
          bounds: { x: 100, y: 40, width: 900, height: 700, centerX: 550, centerY: 390 }
        }
      ]
    },
    capture: { path: "/tmp/wechat-foreign-view.png" },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "WeChat\nMinimized Groups",
    recentActions: [],
    summary: "WeChat minimized groups",
    timestamp: new Date().toISOString()
  };
  const chatListWorldState = {
    ...foreignWorldState,
    capture: { path: "/tmp/wechat-chat-list.png" },
    visibleText: "WeChat\n张三\n未读\n客户: 明天下午方便吗？",
    summary: "WeChat unread list"
  };
  const fakeSurface = {
    async observe() {
      return recovered ? chatListWorldState : foreignWorldState;
    },
    async act({ step }: { step: RuntimeStep }) {
      actions.push(`${step.action}:${String(step.label ?? step.id ?? "")}`);
      if (step.action === "clickAt" && String(step.label ?? "").includes("Recover WeChat to chat list")) {
        recovered = true;
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
    id: "watch-wechat-recover-click",
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
    id: "profile-wechat-recover-click",
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
    worldState: foreignWorldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }: { schemaName?: string }) => {
          if (schemaName === "agentos_wechat_thread_grounding") {
            return {
              targetVisible: true,
              evidence: "Exact 张三 row visible in left sidebar",
              clickPoint: { x: 0.15, y: 0.18 },
              rowBox: { x: 0.06, y: 0.14, width: 0.26, height: 0.08 }
            };
          }
          if (!recovered) {
            return {
              scene: "foreign_view",
              sceneEvidence: "Minimized Groups page",
              recommendedRecoveryAction: "recover_to_list",
              recoveryControl: {
                present: true,
                evidence: "top-left back arrow",
                approxBox: { x: 0.03, y: 0.06, width: 0.05, height: 0.05 }
              },
              openThread: null,
              visibleUnreadThreads: [],
              composer: {
                present: false,
                evidence: "",
                approxBox: null
              }
            };
          }
          return {
            scene: "chat_list",
            sceneEvidence: "left chat list visible",
            recommendedRecoveryAction: "none",
            recoveryControl: {
              present: false,
              evidence: "",
              approxBox: null
            },
            openThread: null,
            visibleUnreadThreads: [
              {
                name: "张三",
                evidence: "red unread badge",
                approxSidebarY: 0.18,
                replyable: true,
                threadKind: "chat",
                conversationKind: "direct",
                shouldReply: true,
                replyReason: "Direct question from contact",
                latestSnippet: "明天下午方便吗？",
                priority: "high",
                approxBox: { x: 0.08, y: 0.16, width: 0.26, height: 0.08 }
              }
            ],
            composer: {
              present: true,
              evidence: "bottom input area",
              approxBox: { x: 0.33, y: 0.82, width: 0.56, height: 0.12 }
            }
          };
        }
      }
    } as never
  });

  assert.equal(detection?.summary, "张三");
  assert.equal((detection?.metadata as { recoveryAttempts?: unknown } | undefined)?.recoveryAttempts, 1);
  assert.equal(actions.includes("clickAt:Recover WeChat to chat list"), true);
});

test("wechat desktop pack falls back to Escape recovery when no recovery control is visible", async () => {
  let recovered = false;
  const actions: string[] = [];
  const foreignWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-wechat-foreign-view-escape",
    appContext: {
      appName: "WeChat",
      windows: [
        {
          ownerName: "WeChat",
          windowName: "WeChat",
          bounds: { x: 100, y: 40, width: 900, height: 700, centerX: 550, centerY: 390 }
        }
      ]
    },
    capture: { path: "/tmp/wechat-foreign-view-escape.png" },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "WeChat\nOfficial Accounts article",
    recentActions: [],
    summary: "WeChat official account article",
    timestamp: new Date().toISOString()
  };
  const chatListWorldState = {
    ...foreignWorldState,
    capture: { path: "/tmp/wechat-chat-list-escape.png" },
    visibleText: "WeChat\n李四\n未读\n在吗？",
    summary: "WeChat unread list"
  };
  const fakeSurface = {
    async observe() {
      return recovered ? chatListWorldState : foreignWorldState;
    },
    async act({ step }: { step: RuntimeStep }) {
      actions.push(`${step.action}:${String(step.label ?? step.id ?? "")}`);
      if (step.action === "pressKey" && String(step.params?.key ?? "") === "Escape") {
        recovered = true;
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
    id: "watch-wechat-recover-escape",
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
    id: "profile-wechat-recover-escape",
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
    worldState: foreignWorldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }: { schemaName?: string }) => {
          if (schemaName === "agentos_wechat_thread_grounding") {
            return {
              targetVisible: true,
              evidence: "Exact 李四 row visible in left sidebar",
              clickPoint: { x: 0.15, y: 0.24 },
              rowBox: { x: 0.06, y: 0.2, width: 0.26, height: 0.08 }
            };
          }
          if (!recovered) {
            return {
              scene: "foreign_view",
              sceneEvidence: "Official account article",
              recommendedRecoveryAction: "recover_to_list",
              recoveryControl: {
                present: false,
                evidence: "",
                approxBox: null
              },
              openThread: null,
              visibleUnreadThreads: [],
              composer: {
                present: false,
                evidence: "",
                approxBox: null
              }
            };
          }
          return {
            scene: "chat_list",
            sceneEvidence: "left chat list visible",
            recommendedRecoveryAction: "none",
            recoveryControl: {
              present: false,
              evidence: "",
              approxBox: null
            },
            openThread: null,
            visibleUnreadThreads: [
              {
                name: "李四",
                evidence: "red unread badge",
                approxSidebarY: 0.24,
                replyable: true,
                threadKind: "chat",
                conversationKind: "direct",
                shouldReply: true,
                replyReason: "Direct message asking a question",
                latestSnippet: "在吗？",
                priority: "high",
                approxBox: { x: 0.08, y: 0.22, width: 0.26, height: 0.08 }
              }
            ],
            composer: {
              present: true,
              evidence: "bottom input area",
              approxBox: { x: 0.33, y: 0.82, width: 0.56, height: 0.12 }
            }
          };
        }
      }
    } as never
  });

  assert.equal(detection?.summary, "李四");
  assert.equal(actions.includes("pressKey:Dismiss WeChat foreign view"), true);
});

test("wechat desktop pack can fall back to the window composer region when vision sees no composer box", async () => {
  const initialWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-wechat-fallback",
    appContext: {
      appName: "WeChat",
      windows: [
        {
          ownerName: "WeChat",
          windowName: "WeChat",
          bounds: { x: 100, y: 40, width: 900, height: 700, centerX: 550, centerY: 390 }
        }
      ]
    },
    capture: { path: "/tmp/wechat-composer-fallback.png" },
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "thread-tan-badge",
        surface: "desktop",
        kind: "text",
        text: "2",
        role: "text",
        bounds: { x: 150, y: 160, width: 20, height: 20, centerX: 160, centerY: 170 },
        confidence: 0.95,
        sourceHints: { source: "ocr" },
        isInteractive: true
      },
      {
        id: "thread-tan",
        surface: "desktop",
        kind: "text",
        text: "Tan",
        role: "text",
        bounds: { x: 180, y: 160, width: 80, height: 24, centerX: 220, centerY: 172 },
        confidence: 0.96,
        sourceHints: { source: "ocr-wechat-list" },
        isInteractive: true
      }
    ],
    visibleText: "WeChat\n未读\nTan\n11:15",
    recentActions: [],
    summary: "WeChat inbox",
    timestamp: new Date().toISOString()
  };
  const fakeSurface = {
    async observe() {
      return initialWorldState;
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("wechat-desktop");
  const rule: WatchRule = {
    id: "watch-wechat-desktop-fallback",
    goal: "Always watch WeChat and prefill replies for unread conversations without sending",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "wechat-desktop-main",
    skillName: null,
    appTarget: "WeChat",
    livePack: "wechat-desktop",
    pollIntervalMs: 1000,
    watchProfile: {
      governance: {
        replyPolicy: "prefill_first"
      }
    },
    taskInputs: {},
    dedupeState: {},
    lastObservedAt: null,
    lastTriggeredAt: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const workspace: WorkspaceProfile = {
    id: "profile-wechat-fallback",
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
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async () => ({
          openThread: "[25P5] 自娱自乐群 (52)",
          visibleUnreadThreads: [
            {
              name: "Tan",
              evidence: "red unread badge",
              approxSidebarY: 0.22,
              approxBox: { x: 0.08, y: 0.19, width: 0.26, height: 0.08 }
            }
          ],
          composer: {
            present: false,
            evidence: "",
            approxBox: null
          }
        })
      }
    } as never
  });
  assert.equal(detection?.summary, "Tan");
  assert.equal(Number(detection?.inputs?.composeX ?? 0) > 0, true);
  assert.equal(Number(detection?.inputs?.composeY ?? 0) > 0, true);
  assert.equal(Array.isArray(detection?.taskSpec?.steps), true);
});

test("wechat desktop extractContext reuses prior visual analysis without a second vision call", async () => {
  let opened = false;
  let analyzeCalls = 0;
  const initialWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-wechat-vision-reuse",
    appContext: {
      appName: "WeChat",
      windows: [
        {
          ownerName: "WeChat",
          windowName: "WeChat",
          bounds: { x: 100, y: 40, width: 900, height: 700, centerX: 550, centerY: 390 }
        }
      ]
    },
    capture: { path: "/tmp/wechat-vision-reuse-before.png" },
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "thread-unread",
        surface: "desktop",
        kind: "text",
        text: "硅谷 AI+ 和 TA ...",
        role: "button",
        bounds: { x: 220, y: 180, width: 180, height: 32, centerX: 310, centerY: 196 },
        confidence: 0.96,
        sourceHints: { source: "ocr-wechat-sidebar" },
        isInteractive: true
      }
    ],
    visibleText: "WeChat\n硅谷 AI+ 和 TA ...",
    recentActions: [],
    summary: "WeChat",
    timestamp: new Date().toISOString()
  };
  const threadWorldState = {
    ...initialWorldState,
    capture: { path: "/tmp/wechat-vision-reuse-after.png" },
    interactionCandidates: [
      {
        id: "compose",
        surface: "desktop",
        kind: "text",
        text: "输入消息",
        role: "textbox",
        bounds: { x: 600, y: 640, width: 240, height: 36, centerX: 720, centerY: 658 },
        confidence: 0.98,
        sourceHints: { source: "ocr-wechat-compose", placeholder: "输入消息" },
        isInteractive: true
      },
      {
        id: "send",
        surface: "desktop",
        kind: "text",
        text: "发送",
        role: "button",
        bounds: { x: 860, y: 640, width: 48, height: 28, centerX: 884, centerY: 654 },
        confidence: 0.97,
        sourceHints: { source: "ocr" },
        isInteractive: true
      }
    ],
    visibleText: "WeChat\n输入消息\n发送",
    timestamp: new Date().toISOString()
  };
  const fakeSurface = {
    async waitForAppReady() {
      return {
        ready: true,
        frontmostApp: "WeChat",
        accessibilityCandidateCount: 0
      };
    },
    async observe() {
      return opened ? threadWorldState : initialWorldState;
    },
    async act({ step }) {
      if (step.action === "clickTarget" || step.action === "clickAt") {
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
    id: "watch-wechat-vision-reuse",
    goal: "Always watch WeChat and prefill replies for unread conversations without sending",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "wechat-desktop-main",
    skillName: null,
    appTarget: "WeChat",
    livePack: "wechat-desktop",
    pollIntervalMs: 1000,
    watchProfile: {
      governance: {
        replyPolicy: "prefill_first"
      }
    },
    taskInputs: {},
    dedupeState: {},
    lastObservedAt: null,
    lastTriggeredAt: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const workspace: WorkspaceProfile = {
    id: "profile-wechat-vision-reuse",
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

  const context = await pack?.extractContext?.({
    rule,
    worldState: initialWorldState as never,
    detection: {
      fingerprint: "wechat-vision-reuse",
      summary: "硅谷 AI+ 和 TA ...",
      text: "硅谷 AI+ 和 TA ...",
      context: ["现有上下文"],
      inputs: {
        openTarget: "硅谷 AI+ 和 TA ...",
        threadTitle: "硅谷 AI+ 和 TA ..."
      },
      metadata: {
        visualAnalysis: {
          openThread: null,
          visibleUnreadThreads: [
            {
              name: "硅谷 AI+ 和 TA ...",
              evidence: "red unread badge on the row",
              approxSidebarY: 0.22,
              approxBox: { x: 0.08, y: 0.19, width: 0.26, height: 0.08 }
            }
          ],
          composer: {
            present: true,
            evidence: "input area visible",
            approxBox: { x: 0.33, y: 0.8, width: 0.56, height: 0.12 }
          }
        }
      },
      taskSpec: {
        preferredSurface: "desktop",
        steps: [
          {
            label: "Focus WeChat",
            surface: "desktop",
            action: "focusApp",
            params: {
              name: "WeChat"
            }
          }
        ]
      }
    } as never,
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        isConfigured: () => true,
        supportsImageJson: () => true,
        analyzeImageJson: async () => {
          analyzeCalls += 1;
          throw new Error("extractContext should not request a second WeChat vision pass");
        }
      }
    } as never
  });

  assert.equal(analyzeCalls, 0);
  assert.equal(context?.inputs?.threadTitle, "硅谷 AI+ 和 TA ...");
  assert.equal(context?.context?.[0], "现有上下文");
  assert.equal(context?.metadata?.threadVerificationDeferred, true);
  assert.equal(Array.isArray(context?.taskSpec?.steps), true);
});

test("wechat desktop pack requires vision analysis to detect unread conversations", async () => {
  const initialWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-wechat-ocr",
    appContext: {
      appName: "WeChat",
      windows: [
        {
          ownerName: "WeChat",
          windowName: "WeChat",
          bounds: { x: 0, y: 0, width: 900, height: 700, centerX: 450, centerY: 350 }
        }
      ],
      accessibilityCandidateCount: 0
    },
    capture: null,
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "ocr-badge-lisi",
        surface: "desktop",
        kind: "text",
        text: "1",
        role: "text",
        bounds: { x: 36, y: 140, width: 18, height: 18, centerX: 45, centerY: 149 },
        confidence: 0.94,
        sourceHints: { source: "ocr" },
        isInteractive: true
      },
      {
        id: "ocr-thread-lisi",
        surface: "desktop",
        kind: "text",
        text: "李四",
        role: "text",
        bounds: { x: 80, y: 140, width: 120, height: 30, centerX: 140, centerY: 155 },
        confidence: 0.94,
        sourceHints: { source: "ocr" },
        isInteractive: true
      }
    ],
    visibleText: "微信\n最近聊天\n未读\n李四\n客户: 方便的话回个电话\n",
    recentActions: [],
    summary: "WeChat OCR unread list",
    timestamp: new Date().toISOString()
  };
  const fakeSurface = {
    async observe() {
      return initialWorldState;
    },
    async waitForAppReady() {
      return {
        ready: true,
        frontmostApp: "WeChat",
        accessibilityCandidateCount: 0
      };
    },
    async focus() {
      return { focused: "WeChat" };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("wechat-desktop");
  const rule: WatchRule = {
    id: "watch-wechat-desktop-ocr",
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
    id: "profile-wechat-ocr",
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
  assert.equal(detection, null);
});

test("wechat desktop pack can use visual model analysis to identify unread threads", async () => {
  const worldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-wechat-vision",
    appContext: {
      appName: "WeChat",
      windows: [
        {
          ownerName: "WeChat",
          windowName: "WeChat",
          bounds: { x: 100, y: 40, width: 900, height: 700, centerX: 550, centerY: 390 }
        }
      ]
    },
    capture: {
      id: "artifact-vision",
      taskId: "task-vision",
      traceId: null,
      kind: "screenshot",
      label: "WeChat vision state",
      path: "/tmp/wechat-vision.png",
      metadata: {},
      createdAt: new Date().toISOString()
    },
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "thread-wechat-pay",
        surface: "desktop",
        kind: "text",
        text: "WeChat Pay...",
        role: "text",
        bounds: { x: 210, y: 398, width: 120, height: 24, centerX: 270, centerY: 410 },
        confidence: 0.9,
        sourceHints: { source: "ocr-wechat-list" },
        isInteractive: true
      }
    ],
    visibleText: "WeChat\nWeChat Pay...",
    recentActions: [],
    summary: "WeChat",
    timestamp: new Date().toISOString()
  };

  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({})
  });
  const pack = registry.get("wechat-desktop");
  const rule: WatchRule = {
    id: "watch-wechat-vision-detect",
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
    id: "profile-wechat-vision",
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
    worldState: worldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async () => ({
          openThread: "[25P5] 自娱自乐群 (52)",
          visibleUnreadThreads: [
            {
              name: "WeChat Pay...",
              evidence: "badge",
              approxSidebarY: 0.54,
              replyable: true,
              threadKind: "chat",
              conversationKind: "direct",
              shouldReply: true,
              replyReason: "The visible unread row is a direct chat waiting for a response.",
              latestSnippet: "Can you check the payment update?",
              priority: "high",
              approxBox: { x: 0.08, y: 0.5, width: 0.26, height: 0.08 }
            }
          ],
          composer: {
            present: true,
            evidence: "bottom input area",
            approxBox: { x: 0.31, y: 0.85, width: 0.66, height: 0.12 }
          }
        })
      }
    } as never
  });

  assert.equal(detection?.summary, "WeChat Pay...");
  assert.equal(detection?.inputs?.openTarget, "WeChat Pay...");
  assert.deepEqual(detection?.context?.slice(0, 2), [
    "Can you check the payment update?",
    "The visible unread row is a direct chat waiting for a response."
  ]);
  assert.equal(Number.isFinite(Number((detection?.metadata as { openPoint?: { x?: unknown } } | undefined)?.openPoint?.x ?? NaN)), true);
  assert.equal(
    Array.isArray((detection?.metadata?.visualAnalysis as { visibleUnreadThreads?: unknown[] } | undefined)?.visibleUnreadThreads),
    true
  );
});

test("wechat desktop pack skips noisy group threads and prefers reply-worthy direct chats", async () => {
  const worldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-wechat-vision-priority",
    appContext: {
      appName: "WeChat",
      windows: [
        {
          ownerName: "WeChat",
          windowName: "WeChat",
          bounds: { x: 100, y: 40, width: 900, height: 700, centerX: 550, centerY: 390 }
        }
      ]
    },
    capture: {
      id: "artifact-vision-priority",
      taskId: "task-vision-priority",
      traceId: null,
      kind: "screenshot",
      label: "WeChat vision priority state",
      path: "/tmp/wechat-vision-priority.png",
      metadata: {},
      createdAt: new Date().toISOString()
    },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "WeChat\n硅谷 AI+ 和 TA 的朋友们 (499)\nTan",
    recentActions: [],
    summary: "WeChat",
    timestamp: new Date().toISOString()
  };

  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({})
  });
  const pack = registry.get("wechat-desktop");
  const rule: WatchRule = {
    id: "watch-wechat-vision-priority",
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
    id: "profile-wechat-vision-priority",
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
    worldState: worldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async () => ({
          openThread: "Official Accounts",
          visibleUnreadThreads: [
            {
              name: "硅谷 AI+ 和 TA 的朋友们 (499)",
              evidence: "red badge with link shares",
              approxSidebarY: 0.76,
              replyable: true,
              threadKind: "chat",
              conversationKind: "group",
              shouldReply: false,
              replyReason: "Large noisy group with passive link shares and no direct ask.",
              latestSnippet: "Clawbot 教程链接",
              priority: "low",
              approxBox: { x: 0.07, y: 0.71, width: 0.28, height: 0.09 }
            },
            {
              name: "Tan",
              evidence: "red unread badge on the row",
              approxSidebarY: 0.22,
              replyable: true,
              threadKind: "chat",
              conversationKind: "direct",
              shouldReply: true,
              replyReason: "Direct unread message that clearly expects a reply.",
              latestSnippet: "你今晚方便看下这个方案吗？",
              priority: "high",
              approxBox: { x: 0.08, y: 0.19, width: 0.26, height: 0.08 }
            }
          ],
          composer: {
            present: true,
            evidence: "bottom input area",
            approxBox: { x: 0.31, y: 0.85, width: 0.66, height: 0.12 }
          }
        })
      }
    } as never
  });

  assert.equal(detection?.summary, "Tan");
  assert.equal(detection?.inputs?.openTarget, "Tan");
  assert.deepEqual(detection?.context?.slice(0, 2), [
    "你今晚方便看下这个方案吗？",
    "Direct unread message that clearly expects a reply."
  ]);
});

test("wechat desktop pack can scroll the conversation list to find unread threads beyond the first screen", async () => {
  let observeCount = 0;
  const actions: string[] = [];
  const initialWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-wechat-scroll",
    appContext: {
      appName: "WeChat",
      windows: [
        {
          ownerName: "WeChat",
          windowName: "WeChat",
          bounds: { x: 100, y: 40, width: 900, height: 700, centerX: 550, centerY: 390 }
        }
      ]
    },
    capture: { path: "/tmp/wechat-scroll-initial.png" },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "WeChat\n清华互助群\nOfficial Accounts",
    recentActions: [],
    summary: "WeChat",
    timestamp: new Date().toISOString()
  };
  const scrolledWorldState = {
    ...initialWorldState,
    capture: { path: "/tmp/wechat-scroll-pass-1.png" },
    visibleText: "WeChat\nTan\n输入消息"
  };
  const fakeSurface = {
    async observe() {
      observeCount += 1;
      return scrolledWorldState;
    },
    async act({ step }) {
      actions.push(String(step?.action ?? ""));
      return { ok: true };
    }
  };
  let analyzeCalls = 0;
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("wechat-desktop");
  const rule: WatchRule = {
    id: "watch-wechat-scroll",
    goal: "Always watch WeChat and prefill replies for unread conversations without sending",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "wechat-desktop-main",
    skillName: null,
    appTarget: "WeChat",
    livePack: "wechat-desktop",
    pollIntervalMs: 1000,
    watchProfile: {
      governance: {
        replyPolicy: "prefill_first"
      }
    },
    taskInputs: {},
    dedupeState: {},
    lastObservedAt: null,
    lastTriggeredAt: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const workspace: WorkspaceProfile = {
    id: "profile-wechat-scroll",
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
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async ({ imagePath }) => {
          analyzeCalls += 1;
          if (String(imagePath).includes("initial")) {
            return {
              openThread: null,
              visibleUnreadThreads: [
                {
                  name: "清华互助群",
                  evidence: "group row with forwarded content",
                  approxSidebarY: 0.28,
                  approxBox: { x: 0.08, y: 0.24, width: 0.28, height: 0.08 },
                  replyable: true,
                  threadKind: "chat",
                  conversationKind: "group",
                  shouldReply: false,
                  replyReason: "No direct question or mention visible.",
                  latestSnippet: "转发内容",
                  priority: "low"
                }
              ],
              composer: {
                present: false,
                evidence: "",
                approxBox: null
              }
            };
          }
          return {
            openThread: null,
            visibleUnreadThreads: [
              {
                name: "Tan",
                evidence: "direct unread badge",
                approxSidebarY: 0.36,
                approxBox: { x: 0.08, y: 0.32, width: 0.26, height: 0.08 },
                replyable: true,
                threadKind: "chat",
                conversationKind: "direct",
                shouldReply: true,
                replyReason: "Direct unread message waiting for a response.",
                latestSnippet: "晚上有空聊一下吗？",
                priority: "high"
              }
            ],
            composer: {
              present: true,
              evidence: "bottom input composer visible",
              approxBox: { x: 0.34, y: 0.8, width: 0.56, height: 0.12 }
            }
          };
        }
      }
    } as never
  });

  assert.equal(detection?.summary, "Tan");
  assert.equal(detection?.metadata?.scrollPasses, 1);
  assert.equal(analyzeCalls, 3);
  assert(actions.includes("clickAt"));
  assert(actions.includes("scroll"));
});

test("wechat desktop pack clamps vision unread click targets back into the left sidebar", async () => {
  const worldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-wechat-vision-clamp",
    appContext: {
      appName: "WeChat",
      windows: [
        {
          ownerName: "WeChat",
          windowName: "WeChat",
          bounds: { x: 100, y: 40, width: 900, height: 700, centerX: 550, centerY: 390 }
        }
      ]
    },
    capture: {
      id: "artifact-vision-clamp",
      taskId: "task-vision-clamp",
      traceId: null,
      kind: "screenshot",
      label: "WeChat vision clamp state",
      path: "/tmp/wechat-vision-clamp.png",
      metadata: {},
      createdAt: new Date().toISOString()
    },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "WeChat\nTan",
    recentActions: [],
    summary: "WeChat",
    timestamp: new Date().toISOString()
  };

  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({})
  });
  const pack = registry.get("wechat-desktop");
  const rule: WatchRule = {
    id: "watch-wechat-vision-clamp",
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
    id: "profile-wechat-vision-clamp",
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
    worldState: worldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async () => ({
          openThread: "Current thread",
          visibleUnreadThreads: [
            {
              name: "Tan",
              evidence: "badge",
              approxSidebarY: 0.16,
              approxBox: { x: 0.58, y: 0.12, width: 0.18, height: 0.08 }
            }
          ],
          composer: {
            present: true,
            evidence: "bottom input area",
            approxBox: { x: 0.31, y: 0.85, width: 0.66, height: 0.12 }
          }
        })
      }
    } as never
  });

  assert.equal(detection?.summary, "Tan");
  assert.equal(
    Math.round(Number((detection?.metadata as { openPoint?: { x?: unknown } } | undefined)?.openPoint?.x ?? 0)),
    298
  );
});

test("wechat desktop pack prefers target-specific vision grounding for the click point", async () => {
  const worldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-wechat-vision-grounding",
    appContext: {
      appName: "WeChat",
      windows: [
        {
          ownerName: "WeChat",
          windowName: "WeChat",
          bounds: { x: 100, y: 40, width: 900, height: 700, centerX: 550, centerY: 390 }
        }
      ]
    },
    capture: {
      id: "artifact-vision-grounding",
      taskId: "task-vision-grounding",
      traceId: null,
      kind: "screenshot",
      label: "WeChat vision grounding state",
      path: "/tmp/wechat-vision-grounding.png",
      metadata: {},
      createdAt: new Date().toISOString()
    },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "WeChat\nTan",
    recentActions: [],
    summary: "WeChat",
    timestamp: new Date().toISOString()
  };

  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({})
  });
  const pack = registry.get("wechat-desktop");
  const rule: WatchRule = {
    id: "watch-wechat-vision-grounding",
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
    id: "profile-wechat-vision-grounding",
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

  let analyzeCalls = 0;
  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: worldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }: { schemaName?: string }) => {
          analyzeCalls += 1;
          if (schemaName === "agentos_wechat_thread_grounding") {
            return {
              targetVisible: true,
              evidence: "Exact Tan row visible in left sidebar",
              clickPoint: { x: 0.16, y: 0.18 },
              rowBox: { x: 0.06, y: 0.14, width: 0.26, height: 0.08 }
            };
          }
          return {
            openThread: "Current thread",
            visibleUnreadThreads: [
              {
                name: "Tan",
                evidence: "badge",
                approxSidebarY: 0.16,
                approxBox: { x: 0.58, y: 0.12, width: 0.18, height: 0.08 }
              }
            ],
            composer: {
              present: true,
              evidence: "bottom input area",
              approxBox: { x: 0.31, y: 0.85, width: 0.66, height: 0.12 }
            }
          };
        }
      }
    } as never
  });

  assert.equal(analyzeCalls, 2);
  assert.equal(detection?.summary, "Tan");
  assert.equal(
    Math.round(Number((detection?.metadata as { openPoint?: { x?: unknown } } | undefined)?.openPoint?.x ?? 0)),
    244
  );
  assert.equal(
    Math.round(Number((detection?.metadata as { openPoint?: { y?: unknown } } | undefined)?.openPoint?.y ?? 0)),
    166
  );
});

test("wechat desktop pack maps vision click targets into on-screen window coordinates for window-local captures", async () => {
  const capturePath = "/tmp/wechat-vision-window-local.png";
  await writePngHeader(capturePath, 3024, 1964);
  const worldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-wechat-vision-window-local",
    appContext: {
      appName: "WeChat",
      windows: [
        {
          ownerName: "WeChat",
          windowName: "WeChat",
          windowNumber: 88,
          bounds: { x: 100, y: 40, width: 900, height: 700, centerX: 550, centerY: 390 }
        }
      ]
    },
    capture: {
      id: "artifact-vision-window-local",
      taskId: "task-vision-window-local",
      traceId: null,
      kind: "screenshot",
      label: "WeChat vision window-local state",
      path: capturePath,
      metadata: { windowNumber: 88 },
      createdAt: new Date().toISOString()
    },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "WeChat\nTan",
    recentActions: [],
    summary: "WeChat",
    timestamp: new Date().toISOString()
  };

  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({})
  });
  const pack = registry.get("wechat-desktop");
  const rule: WatchRule = {
    id: "watch-wechat-vision-window-local",
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
    id: "profile-wechat-vision-window-local",
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
    worldState: worldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }: { schemaName?: string }) => {
          if (schemaName === "agentos_wechat_thread_grounding") {
            return {
              targetVisible: true,
              evidence: "Exact Tan row visible in left sidebar",
              clickPoint: { x: 0.16, y: 0.18 },
              rowBox: { x: 0.06, y: 0.14, width: 0.26, height: 0.08 }
            };
          }
          return {
            openThread: "Current thread",
            visibleUnreadThreads: [
              {
                name: "Tan",
                evidence: "badge",
                approxSidebarY: 0.16,
                approxBox: { x: 0.08, y: 0.14, width: 0.26, height: 0.08 }
              }
            ],
            composer: {
              present: true,
              evidence: "bottom input area",
              approxBox: { x: 0.31, y: 0.85, width: 0.66, height: 0.12 }
            }
          };
        }
      }
    } as never
  });

  assert.equal(
    Math.round(Number((detection?.metadata as { openPoint?: { x?: unknown } } | undefined)?.openPoint?.x ?? 0)),
    244
  );
  assert.equal(
    Math.round(Number((detection?.metadata as { openPoint?: { y?: unknown } } | undefined)?.openPoint?.y ?? 0)),
    166
  );
});

test("wechat desktop pack normalizes pixel-based thread grounding output from vision models", async () => {
  const capturePath = "/tmp/wechat-vision-pixel-grounding.png";
  await writePngHeader(capturePath, 3024, 1964);
  const worldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-wechat-vision-pixel-grounding",
    appContext: {
      appName: "WeChat",
      windows: [
        {
          ownerName: "WeChat",
          windowName: "WeChat",
          windowNumber: 88,
          bounds: { x: 100, y: 40, width: 900, height: 700, centerX: 550, centerY: 390 }
        }
      ],
      captureWindowNumber: 88
    },
    capture: {
      id: "artifact-vision-pixel-grounding",
      taskId: "task-vision-pixel-grounding",
      traceId: null,
      kind: "screenshot",
      label: "WeChat vision pixel grounding state",
      path: capturePath,
      metadata: { windowNumber: 88 },
      createdAt: new Date().toISOString()
    },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "WeChat\n徐畅",
    recentActions: [],
    summary: "WeChat",
    timestamp: new Date().toISOString()
  };

  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({})
  });
  const pack = registry.get("wechat-desktop");
  const rule: WatchRule = {
    id: "watch-wechat-pixel-grounding",
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
    id: "profile-wechat-pixel-grounding",
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
    worldState: worldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }: { schemaName?: string }) => {
          if (schemaName === "agentos_wechat_thread_grounding") {
            return {
              targetVisible: true,
              evidence: "The 徐畅 row is visible and returned in pixel coordinates",
              clickPoint: { x: 200, y: 145 },
              rowBox: { x: 79, y: 117, width: 245, height: 56 }
            };
          }
          return {
            openThread: "Current thread",
            visibleUnreadThreads: [
              {
                name: "徐畅",
                evidence: "red unread badge on the row",
                approxSidebarY: 0.18,
                replyable: true,
                threadKind: "chat",
                conversationKind: "direct",
                shouldReply: true,
                replyReason: "direct message with unread badge",
                latestSnippet: "阔以！跟林老师学习🤙",
                priority: "high",
                approxBox: { x: 0.08, y: 0.14, width: 0.26, height: 0.08 }
              }
            ],
            composer: {
              present: true,
              evidence: "bottom input area",
              approxBox: { x: 0.31, y: 0.85, width: 0.66, height: 0.12 }
            }
          };
        }
      }
    } as never
  });

  assert.equal(detection?.summary, "徐畅");
  assert.equal(
    Math.round(Number((detection?.metadata as { openPoint?: { x?: unknown } } | undefined)?.openPoint?.x ?? 0)),
    160
  );
  assert.equal(
    Math.round(Number((detection?.metadata as { openPoint?: { y?: unknown } } | undefined)?.openPoint?.y ?? 0)),
    92
  );
});

test("wechat desktop pack falls back to the first-pass unread row point when thread grounding diverges too far", async () => {
  const worldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-wechat-grounding-fallback",
    appContext: {
      appName: "WeChat",
      windows: [
        {
          ownerName: "WeChat",
          windowName: "WeChat",
          bounds: { x: 100, y: 40, width: 900, height: 700, centerX: 550, centerY: 390 }
        }
      ]
    },
    capture: {
      id: "artifact-grounding-fallback",
      taskId: "task-grounding-fallback",
      traceId: null,
      kind: "screenshot",
      label: "WeChat grounding fallback state",
      path: "/tmp/wechat-grounding-fallback.png",
      metadata: {},
      createdAt: new Date().toISOString()
    },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "WeChat\n徐畅",
    recentActions: [],
    summary: "WeChat",
    timestamp: new Date().toISOString()
  };

  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({})
  });
  const pack = registry.get("wechat-desktop");
  const rule: WatchRule = {
    id: "watch-wechat-grounding-fallback",
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
    id: "profile-wechat-grounding-fallback",
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
    worldState: worldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }: { schemaName?: string }) => {
          if (schemaName === "agentos_wechat_thread_grounding") {
            return {
              targetVisible: true,
              evidence: "A distant row was grounded incorrectly",
              clickPoint: { x: 0.42, y: 0.62 },
              rowBox: { x: 0.34, y: 0.56, width: 0.12, height: 0.08 }
            };
          }
          return {
            openThread: "Current thread",
            visibleUnreadThreads: [
              {
                name: "徐畅",
                evidence: "red unread badge on the row",
                approxSidebarY: 0.18,
                replyable: true,
                threadKind: "chat",
                conversationKind: "direct",
                shouldReply: true,
                replyReason: "direct message with unread badge",
                latestSnippet: "阔以！跟林老师学习🤙",
                priority: "high",
                approxBox: { x: 0.08, y: 0.14, width: 0.26, height: 0.08 }
              }
            ],
            composer: {
              present: true,
              evidence: "bottom input area",
              approxBox: { x: 0.31, y: 0.85, width: 0.66, height: 0.12 }
            }
          };
        }
      }
    } as never
  });

  assert.equal(detection?.summary, "徐畅");
  assert.equal(
    Math.round(Number((detection?.metadata as { openPoint?: { x?: unknown } } | undefined)?.openPoint?.x ?? 0)),
    289
  );
  assert.equal(
    Math.round(Number((detection?.metadata as { openPoint?: { y?: unknown } } | undefined)?.openPoint?.y ?? 0)),
    166
  );
});

test("wechat desktop vision analysis can ignore timestamps and URL snippets in the conversation list", async () => {
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: {} as never
    })
  });
  const pack = registry.get("wechat-desktop");
  const rule: WatchRule = {
    id: "watch-wechat-desktop-ocr-ranking",
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
    id: "profile-wechat-ocr-ranking",
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
  const worldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-wechat-ocr-ranking",
    appContext: {
      appName: "WeChat",
      captureWindowNumber: 7,
      windows: [
        {
          ownerName: "WeChat",
          windowName: "WeChat",
          windowNumber: 7,
          bounds: { x: 320, y: 40, width: 900, height: 700, centerX: 770, centerY: 390 }
        }
      ],
      accessibilityCandidateCount: 0
    },
    capture: { path: "/tmp/wechat-vision-ranking.png" },
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "ocr-badge-official-accounts",
        surface: "desktop",
        kind: "text",
        text: "2",
        role: "text",
        bounds: { x: 80, y: 120, width: 18, height: 18, centerX: 89, centerY: 129 },
        confidence: 0.95,
        sourceHints: { source: "ocr" },
        isInteractive: true
      },
      {
        id: "ocr-thread-official-accounts",
        surface: "desktop",
        kind: "text",
        text: "Official Accounts",
        role: "text",
        bounds: { x: 120, y: 120, width: 180, height: 28, centerX: 210, centerY: 134 },
        confidence: 0.95,
        sourceHints: { source: "ocr" },
        isInteractive: true
      },
      {
        id: "ocr-date",
        surface: "desktop",
        kind: "text",
        text: "03/11",
        role: "text",
        bounds: { x: 360, y: 120, width: 60, height: 24, centerX: 390, centerY: 132 },
        confidence: 0.98,
        sourceHints: { source: "ocr" },
        isInteractive: true
      },
      {
        id: "ocr-url",
        surface: "desktop",
        kind: "text",
        text: "https://apps.apple.co..",
        role: "text",
        bounds: { x: 140, y: 160, width: 240, height: 24, centerX: 260, centerY: 172 },
        confidence: 0.95,
        sourceHints: { source: "ocr" },
        isInteractive: true
      }
    ],
    visibleText: "未读\nOfficial Accounts\n03/11\nhttps://apps.apple.co..\n",
    recentActions: [],
    summary: "WeChat OCR capture",
    timestamp: new Date().toISOString()
  };

  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: worldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async () => ({
          openThread: null,
          visibleUnreadThreads: [
            {
              name: "Official Accounts",
              evidence: "red unread badge",
              approxSidebarY: 0.26,
              replyable: false,
              threadKind: "official_account",
              approxBox: { x: 0.08, y: 0.22, width: 0.26, height: 0.08 }
            }
          ],
          composer: {
            present: false,
            evidence: "",
            approxBox: null
          }
        })
      }
    } as never
  });

  assert.equal(detection, null);
});

test("wechat desktop vision analysis does not confuse body text for unread conversations", async () => {
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: {} as never
    })
  });
  const pack = registry.get("wechat-desktop");
  const rule: WatchRule = {
    id: "watch-wechat-desktop-ocr-region-ranking",
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
    id: "profile-wechat-ocr-region-ranking",
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
  const worldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-wechat-ocr-region-ranking",
    appContext: {
      appName: "WeChat",
      captureWindowNumber: 11,
      windows: [
        {
          ownerName: "WeChat",
          windowName: "WeChat",
          windowNumber: 11,
          bounds: { x: 0, y: 0, width: 900, height: 700, centerX: 450, centerY: 350 }
        }
      ],
      accessibilityCandidateCount: 0
    },
    capture: { path: "/tmp/wechat-vision-region-ranking.png" },
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "ocr-badge-official-accounts",
        surface: "desktop",
        kind: "text",
        text: "1",
        role: "text",
        bounds: { x: 150, y: 140, width: 18, height: 18, centerX: 159, centerY: 149 },
        confidence: 0.95,
        sourceHints: { source: "ocr" },
        isInteractive: true
      },
      {
        id: "ocr-thread-official-accounts",
        surface: "desktop",
        kind: "text",
        text: "Official Accounts",
        role: "text",
        bounds: { x: 210, y: 140, width: 180, height: 28, centerX: 210, centerY: 140 },
        confidence: 0.95,
        sourceHints: { source: "ocr-wechat-list" },
        isInteractive: true
      },
      {
        id: "ocr-compose-input",
        surface: "desktop",
        kind: "text",
        text: "输入",
        role: "text",
        bounds: { x: 560, y: 610, width: 100, height: 30, centerX: 560, centerY: 610 },
        confidence: 0.93,
        sourceHints: { source: "ocr-wechat-compose" },
        isInteractive: true
      }
    ],
    visibleText: "未读\nOfficial Accounts\n输入\n",
    recentActions: [],
    summary: "WeChat OCR capture",
    timestamp: new Date().toISOString()
  };

  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: worldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async () => ({
          openThread: "[25P5] 自娱自乐群 (52)",
          visibleUnreadThreads: [
            {
              name: "Official Accounts",
              evidence: "red unread badge",
              approxSidebarY: 0.28,
              replyable: false,
              threadKind: "official_account",
              approxBox: { x: 0.08, y: 0.24, width: 0.26, height: 0.08 }
            }
          ],
          composer: {
            present: false,
            evidence: "",
            approxBox: null
          }
        })
      }
    } as never
  });

  assert.equal(detection, null);
});

test("wechat desktop pack returns null when vision sees no visible unread conversations", async () => {
  const initialWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-wechat-scroll-search",
    appContext: {
      appName: "WeChat",
      windows: [
        {
          ownerName: "WeChat",
          windowName: "WeChat",
          bounds: { x: 100, y: 40, width: 900, height: 700, centerX: 550, centerY: 390 }
        }
      ],
      accessibilityCandidateCount: 0
    },
    capture: null,
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "微信\n最近聊天\n文件传输助手\n工作群\n",
    recentActions: [],
    summary: "WeChat conversation list",
    timestamp: new Date().toISOString()
  };
  const fakeSurface = {
    async observe() {
      return initialWorldState;
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("wechat-desktop");
  const rule: WatchRule = {
    id: "watch-wechat-scroll-search",
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
    id: "profile-wechat-scroll-search",
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
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async () => ({
          openThread: "工作群",
          visibleUnreadThreads: [],
          composer: {
            present: true,
            evidence: "bottom input area",
            approxBox: { x: 0.31, y: 0.85, width: 0.66, height: 0.12 }
          }
        })
      }
    } as never
  });

  assert.equal(detection, null);
});

test("wechat desktop pack ignores standalone badge numbers as unread thread names", async () => {
  const worldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-wechat-vision-ignore-badge",
    appContext: {
      appName: "WeChat",
      windows: [
        {
          ownerName: "WeChat",
          windowName: "WeChat",
          bounds: { x: 100, y: 40, width: 900, height: 700, centerX: 550, centerY: 390 }
        }
      ]
    },
    capture: {
      id: "artifact-vision-ignore-badge",
      taskId: "task-vision-ignore-badge",
      traceId: null,
      kind: "screenshot",
      label: "WeChat vision ignore badge state",
      path: "/tmp/wechat-vision-ignore-badge.png",
      metadata: {},
      createdAt: new Date().toISOString()
    },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "WeChat\n33\nL",
    recentActions: [],
    summary: "WeChat",
    timestamp: new Date().toISOString()
  };

  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({})
  });
  const pack = registry.get("wechat-desktop");
  const rule: WatchRule = {
    id: "watch-wechat-ignore-badge",
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
    id: "profile-wechat-ignore-badge",
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
    worldState: worldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }: { schemaName?: string }) => {
          if (schemaName === "agentos_wechat_thread_grounding") {
            return {
              targetVisible: true,
              evidence: "The L row is visible in the left sidebar",
              clickPoint: { x: 0.18, y: 0.22 },
              rowBox: { x: 0.08, y: 0.18, width: 0.26, height: 0.08 }
            };
          }
          return {
            openThread: "Current thread",
            visibleUnreadThreads: [
              {
                name: "33",
                evidence: "top app badge",
                approxSidebarY: 0.12,
                approxBox: { x: 0.02, y: 0.1, width: 0.06, height: 0.06 }
              },
              {
                name: "L",
                evidence: "red unread badge on the row",
                approxSidebarY: 0.22,
                approxBox: { x: 0.08, y: 0.18, width: 0.26, height: 0.08 }
              }
            ],
            composer: {
              present: true,
              evidence: "bottom input area",
              approxBox: { x: 0.31, y: 0.85, width: 0.66, height: 0.12 }
            }
          };
        }
      }
    } as never
  });

  assert.equal(detection?.summary, "L");
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

test("wechat desktop pack can continue observing even when accessibility candidates are missing", async () => {
  let observeCalls = 0;
  const fakeSurface = {
    async waitForAppReady() {
      return {
        ready: false,
        frontmostApp: "WeChat",
        accessibilityCandidateCount: 0
      };
    },
    async observe() {
      observeCalls += 1;
      return {
        version: 1,
        surface: "desktop",
        workspaceId: "workspace-wechat-ready",
        appContext: {
          appName: "WeChat",
          windows: [{ title: "WeChat" }]
        },
        capture: null,
        ocrBlocks: [],
        interactionCandidates: [],
        visibleText: "微信",
        recentActions: [],
        summary: "WeChat",
        timestamp: new Date().toISOString()
      };
    },
    async act() {
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
    id: "watch-wechat-ready",
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
    id: "profile-wechat-ready",
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

  const worldState = await pack?.observeInbox?.({
    rule,
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {} as never
  });

  assert.equal(worldState?.appContext?.appName, "WeChat");
  assert.equal(observeCalls, 1);
});

test("wechat desktop pack derives the default app target when a saved rule omits it", async () => {
  let readinessAppName: string | null = null;
  const fakeSurface = {
    async waitForAppReady({ appName }: { appName: string }) {
      readinessAppName = appName;
      return {
        ready: false,
        frontmostApp: appName,
        accessibilityCandidateCount: 0
      };
    },
    async observe() {
      return {
        version: 1,
        surface: "desktop",
        workspaceId: "workspace-wechat-implicit-target",
        appContext: {
          appName: "WeChat",
          windows: [{ title: "WeChat" }],
          accessibilityCandidateCount: 0
        },
        capture: null,
        ocrBlocks: [],
        interactionCandidates: [],
        visibleText: "微信",
        recentActions: [],
        summary: "WeChat",
        timestamp: new Date().toISOString()
      };
    },
    async act() {
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
    id: "watch-wechat-implicit-target",
    goal: "Always watch WeChat and reply to unread conversations",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "wechat-desktop-main",
    skillName: null,
    appTarget: null,
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
    id: "profile-wechat-implicit-target",
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

  const worldState = await pack?.observeInbox?.({
    rule,
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {} as never
  });

  assert.equal(worldState?.appContext?.appName, "WeChat");
  assert.equal(readinessAppName, "WeChat");
});

test("outlook desktop pack can detect unread mail and build reply steps from a desktop world state", async () => {
  let opened = false;
  const initialWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [{ title: "Inbox - Microsoft Outlook" }]
    },
    capture: null,
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "thread-project-update",
        surface: "desktop",
        kind: "text",
        text: "Project update",
        role: "row",
        bounds: { x: 10, y: 10, width: 220, height: 28, centerX: 120, centerY: 24 },
        confidence: 0.98,
        sourceHints: {
          source: "accessibility",
          ariaLabel: "Unread email Project update from Customer",
          windowTitle: "Inbox - Microsoft Outlook",
          actions: ["AXPress"]
        },
        isInteractive: true
      }
    ],
    visibleText: "Outlook\nFocused Inbox\nUnread\nProject update\nCustomer: Please send the latest update",
    recentActions: [],
    summary: "Microsoft Outlook unread list",
    timestamp: new Date().toISOString()
  };
  const threadWorldState = {
    ...initialWorldState,
    interactionCandidates: [
      {
        id: "thread-project-update-open",
        surface: "desktop",
        kind: "text",
        text: "Project update",
        role: "row",
        bounds: { x: 10, y: 10, width: 220, height: 28, centerX: 120, centerY: 24 },
        confidence: 0.98,
        sourceHints: {
          source: "accessibility",
          ariaLabel: "Project update",
          windowTitle: "Inbox - Microsoft Outlook",
          actions: ["AXPress"]
        },
        isInteractive: true
      },
      {
        id: "reply-editor",
        surface: "desktop",
        kind: "text",
        text: "Reply",
        role: "textbox",
        bounds: { x: 10, y: 210, width: 260, height: 34, centerX: 140, centerY: 227 },
        confidence: 0.98,
        sourceHints: {
          source: "accessibility",
          placeholder: "Reply",
          windowTitle: "Inbox - Microsoft Outlook",
          actions: ["AXPress"]
        },
        isInteractive: true
      },
      {
        id: "send",
        surface: "desktop",
        kind: "text",
        text: "Send",
        role: "button",
        bounds: { x: 280, y: 210, width: 60, height: 32, centerX: 310, centerY: 226 },
        confidence: 0.98,
        sourceHints: {
          source: "accessibility",
          ariaLabel: "Send",
          windowTitle: "Inbox - Microsoft Outlook",
          actions: ["AXPress"]
        },
        isInteractive: true
      }
    ],
    visibleText: "Outlook\nProject update\nCustomer: Please send the latest update\nMe: I will send it shortly.\nReply\nSend"
  };
  const fakeSurface = {
    async observe() {
      return opened ? threadWorldState : initialWorldState;
    },
    async act({ step }) {
      if (step.action === "clickTarget" || step.action === "clickAt") {
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
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-desktop",
    goal: "Always watch Outlook and prefill replies for unread mail",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
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
  assert.equal(detection?.summary, "Project update");
  assert.equal(detection?.metadata?.threadKey, "project update");
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
  assert.equal(context?.inputs?.typeTarget, "Reply");
  assert.equal(context?.inputs?.sendTarget, "Send");
  assert.equal(context?.context?.[0], "Customer: Please send the latest update");
  assert.equal(context?.metadata?.threadKey, "project update");
  assert.equal(context?.metadata?.sender, "Customer");
  assert.equal(Array.isArray(context?.taskSpec?.steps), true);
  assert.equal(context?.taskSpec?.steps?.[0]?.action, "focusApp");
  assert.equal(context?.taskSpec?.steps?.[1]?.action, "focusTarget");
  assert.equal(context?.taskSpec?.steps?.[1]?.params?.allowBoundsFallback, true);
  assert.equal(context?.taskSpec?.steps?.[2]?.action, "typeIntoTarget");
  assert.equal(context?.taskSpec?.steps?.[2]?.params?.text, "{{typeText}}");
  assert.equal(context?.taskSpec?.steps?.[2]?.params?.inputMethod, "paste");
  const verifyExpect = (context?.taskSpec?.steps?.[3]?.expect ?? null) as {
    regionTextAnyVisible?: Array<{ region?: string; text?: string }>;
  } | null;
  assert.equal(Array.isArray(verifyExpect?.regionTextAnyVisible), true);
  assert.deepEqual(
    (verifyExpect?.regionTextAnyVisible ?? []).map((entry) => entry.region),
    ["{{composeVerifyRegion}}", "{{composeVerifyRegion}}", "{{composeVerifyRegion}}", "{{composeVerifyRegion}}"]
  );
  assert.deepEqual(
    (verifyExpect?.regionTextAnyVisible ?? []).map((entry) => entry.text),
    ["{{typeTextPreview}}", "{{typeTextMiddlePreview}}", "{{typeTextTailPreview}}", "{{typeTextSuffixPreview}}"]
  );
});

test("outlook desktop analysis does not treat a generic reading-pane textbox as a composer", () => {
  const worldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-generic-textbox",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [{ title: "Inbox - Microsoft Outlook" }]
    },
    capture: null,
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "thread-project-update-open",
        surface: "desktop",
        kind: "text",
        text: "Project update",
        role: "row",
        bounds: { x: 10, y: 10, width: 220, height: 28, centerX: 120, centerY: 24 },
        confidence: 0.98,
        sourceHints: {
          source: "accessibility",
          ariaLabel: "Project update",
          windowTitle: "Inbox - Microsoft Outlook",
          actions: ["AXPress"]
        },
        isInteractive: true
      },
      {
        id: "approval-comment-field",
        surface: "desktop",
        kind: "element",
        text: "",
        role: "textbox",
        bounds: { x: 540, y: 240, width: 260, height: 42, centerX: 670, centerY: 261 },
        confidence: 0.98,
        sourceHints: {
          source: "accessibility",
          ariaLabel: "Comment",
          windowTitle: "Inbox - Microsoft Outlook",
          actions: ["AXPress"]
        },
        isInteractive: true
      }
    ],
    visibleText: "Outlook\nProject update\nCustomer: Any update?\nComment",
    recentActions: [],
    summary: "Microsoft Outlook thread with a generic text field",
    timestamp: new Date().toISOString()
  };

  const analysis = analyzeConversationPack("outlook-desktop", worldState as never);
  assert.equal(analysis?.composeCandidate, null);
});

test("outlook desktop analysis can synthesize a compose candidate from visible compose chrome when AX is missing", () => {
  const worldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-compose-window-fallback",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [
        {
          title: "Inbox - Microsoft Outlook",
          ownerName: "Microsoft Outlook",
          bounds: { x: 100, y: 40, width: 1280, height: 820, centerX: 740, centerY: 450 }
        }
      ]
    },
    capture: null,
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Outlook\nSend\nFrom:\nTo:\nSubject:\nRe: credibility guide for Tan",
    recentActions: [],
    summary: "Microsoft Outlook thread with visible compose chrome",
    timestamp: new Date().toISOString()
  };

  const analysis = analyzeConversationPack("outlook-desktop", worldState as never);
  assert.equal(analysis?.composeCandidate?.text, "Outlook reply body");
  assert.equal(analysis?.composeCandidate?.interactive, true);
  assert.equal(Number(analysis?.composeCandidate?.bounds?.centerY ?? 0) > 0, true);
});

test("outlook desktop pack does not discard a visible unread row just because the reading pane suggests recover_to_list", async () => {
  const capturePath = `/tmp/outlook-detect-visible-unread-${Date.now()}.png`;
  await fs.writeFile(capturePath, createPngHeaderBuffer(1343, 768));

  const worldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-visible-unread",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [
        {
          title: "Inbox - Microsoft Outlook",
          ownerName: "Microsoft Outlook",
          bounds: { x: 0, y: 0, width: 1343, height: 768 }
        }
      ]
    },
    capture: { path: capturePath },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Outlook\nInbox\nNP\nBug 报告: 创建汇报总账...",
    recentActions: [],
    summary: "Microsoft Outlook reading pane with a visible unread row",
    timestamp: new Date().toISOString()
  };
  const fakeSurface = {
    async observe() {
      return worldState;
    },
    async act() {
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-visible-unread",
    goal: "Always watch Outlook and prefill replies for unread mail",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-visible-unread",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  let analyzeCalls = 0;
  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: worldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }) => {
          analyzeCalls += 1;
          if (schemaName === "agentos_outlook_desktop_visual") {
            return {
              scene: "thread",
              sceneEvidence: "Reading pane is open, but an unread row with a blue dot is still visible in the center list.",
              recommendedRecoveryAction: "recover_to_list",
              recoveryControl: {
                present: false,
                evidence: "",
                approxBox: null
              },
              openThread: "Jin Wang",
              bestUnreadThread: {
                present: true,
                name: "NP",
                evidence: "Blue unread dot on the NP row in the center message list.",
                replyable: true,
                conversationKind: "mail",
                shouldReply: true,
                replyReason: "Bug report email likely needs a response.",
                latestSnippet: "Bug 报告: 创建汇报总账...",
                priority: "high",
                approxBox: { x: 0.122, y: 0.525, width: 0.17, height: 0.052 }
              },
              composer: {
                present: false,
                evidence: "",
                approxBox: null
              }
            };
          }

          if (schemaName === "agentos_outlook_thread_grounding") {
            return {
              targetVisible: false,
              evidence: "Use the provided unread row bounds directly.",
              clickPoint: null,
              rowBox: null
            };
          }

          throw new Error(`Unexpected schema: ${schemaName}`);
        }
      }
    } as never
  });

  await fs.unlink(capturePath).catch(() => null);

  assert.equal(detection?.summary, "NP");
  assert.equal(String(detection?.inputs?.openTarget ?? ""), "NP");
  assert.ok(analyzeCalls >= 1);
});

test("outlook desktop visual analysis prefers the currently open thread title over a side-list unread sender when the scene is thread", async () => {
  const capturePath = `/tmp/outlook-thread-preferred-open-${Date.now()}.png`;
  await fs.writeFile(capturePath, createPngHeaderBuffer(1343, 768));

  const worldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-thread-preferred-open",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [
        {
          title: "Inbox - Microsoft Outlook",
          ownerName: "Microsoft Outlook",
          bounds: { x: 0, y: 0, width: 1343, height: 768 }
        }
      ]
    },
    capture: { path: capturePath },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Outlook\nSubject:\nRe: credibility guide for Tan",
    recentActions: [],
    summary: "Microsoft Outlook thread with visible composer and an unrelated unread row",
    timestamp: new Date().toISOString()
  };
  const analysis = await analyzeDesktopConversationPackWithVision({
    packName: "outlook-desktop",
    worldState: worldState as never,
    modelClient: {
      supportsImageJson: () => true,
      analyzeImageJson: async ({ schemaName }) => {
        if (schemaName === "agentos_outlook_desktop_visual") {
          return {
            scene: "thread",
            sceneEvidence: "A reply composer is visible for the current thread while another unread sender remains in the side list.",
            recommendedRecoveryAction: "none",
            recoveryControl: {
              present: false,
              evidence: "",
              approxBox: null
            },
            openThread: "credibility guide for Tan",
            selectedRow: "杨海燕",
            bestUnreadThread: {
              present: true,
              name: "杨海燕",
              evidence: "Blue unread dot next to 杨海燕 in the center message list.",
              replyable: true,
              conversationKind: "mail",
              shouldReply: true,
              replyReason: "Unread personal message in the list.",
              subjectCue: "转专利办理...",
              latestSnippet: "张蓓老师：您好！贵...",
              priority: "medium",
              approxBox: { x: 0.12, y: 0.48, width: 0.2, height: 0.06 }
            },
            composer: {
              present: true,
              evidence: "Reply composer is visible in the reading pane.",
              hasDraftText: false,
              draftPreview: null,
              entryPoint: { x: 0.42, y: 0.46 },
              approxBox: { x: 0.3, y: 0.18, width: 0.48, height: 0.62 }
            }
          };
        }

        throw new Error(`Unexpected schema: ${schemaName}`);
      }
    } as never
  });

  await fs.unlink(capturePath).catch(() => null);

  assert.equal(analysis?.selectedTarget, "credibility guide for Tan");
  assert.equal(String(analysis?.unreadCandidate?.text ?? ""), "杨海燕");
});

test("outlook desktop pack ignores detections when Outlook is not the foreground app", async () => {
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({})
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-background",
    goal: "Always watch Outlook and prefill replies for unread mail",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-background",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
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
          id: "thread-project-update",
          surface: "desktop",
          kind: "text",
          text: "Project update",
          role: "row",
          bounds: { x: 10, y: 10, width: 220, height: 28, centerX: 120, centerY: 24 },
          confidence: 0.98,
          sourceHints: { source: "accessibility", ariaLabel: "Unread email Project update", actions: ["AXPress"] },
          isInteractive: true
        }
      ],
      visibleText: "Terminal\nnpm test\nProject update",
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

test("outlook desktop pack ignores OCR-only detections when no accessibility candidates are available", async () => {
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({})
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-ocr-only",
    goal: "Always watch Outlook and prefill replies for unread mail",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-ocr-only",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: {
      version: 1,
      surface: "desktop",
      workspaceId: "workspace-outlook-ocr-only",
      appContext: {
        appName: "Microsoft Outlook",
        windows: [{ title: "Inbox - Microsoft Outlook" }]
      },
      capture: null,
      ocrBlocks: [],
      interactionCandidates: [
        {
          id: "ocr-thread",
          surface: "desktop",
          kind: "text",
          text: "Project update",
          role: "row",
          bounds: { x: 10, y: 10, width: 220, height: 28, centerX: 120, centerY: 24 },
          confidence: 0.84,
          sourceHints: { source: "ocr" },
          isInteractive: true
        }
      ],
      visibleText: "Outlook\nProject update",
      recentActions: [],
      summary: "Microsoft Outlook with 0 accessibility candidates and 1 OCR observations",
      timestamp: new Date().toISOString()
    } as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {} as never
  });

  assert.equal(detection, null);
});

test("outlook desktop pack skips reply context extraction when composer is missing", async () => {
  let opened = false;
  const initialWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-missing-composer",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [{ title: "Inbox - Microsoft Outlook" }]
    },
    capture: null,
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "thread-project-update",
        surface: "desktop",
        kind: "text",
        text: "Project update",
        role: "row",
        bounds: { x: 10, y: 10, width: 220, height: 28, centerX: 120, centerY: 24 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", ariaLabel: "Unread email Project update", actions: ["AXPress"] },
        isInteractive: true
      }
    ],
    visibleText: "Outlook\nUnread\nProject update",
    recentActions: [],
    summary: "Microsoft Outlook unread list",
    timestamp: new Date().toISOString()
  };
  const threadWorldState = {
    ...initialWorldState,
    interactionCandidates: [
      {
        id: "thread-project-update-open",
        surface: "desktop",
        kind: "text",
        text: "Project update",
        role: "row",
        bounds: { x: 10, y: 10, width: 220, height: 28, centerX: 120, centerY: 24 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", ariaLabel: "Project update", actions: ["AXPress"] },
        isInteractive: true
      }
    ],
    visibleText: "Outlook\nProject update\nCustomer: Any update?"
  };
  const fakeSurface = {
    async observe() {
      return opened ? threadWorldState : initialWorldState;
    },
    async act({ step }) {
      if (step.action === "clickTarget" || step.action === "clickAt") {
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
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-missing-composer",
    goal: "Always watch Outlook and prefill replies for unread mail",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-missing-composer",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
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

test("outlook desktop pack does not use a keyboard shortcut fallback when reply controls cannot be grounded", async () => {
  let opened = false;
  let replyShortcutUsed = false;
  const initialWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-shortcut",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [{ title: "Inbox - Microsoft Outlook" }]
    },
    capture: null,
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "thread-project-update",
        surface: "desktop",
        kind: "text",
        text: "Project update",
        role: "row",
        bounds: { x: 10, y: 10, width: 220, height: 28, centerX: 120, centerY: 24 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", ariaLabel: "Unread email Project update", actions: ["AXPress"] },
        isInteractive: true
      }
    ],
    visibleText: "Outlook\nUnread\nProject update",
    recentActions: [],
    summary: "Microsoft Outlook unread list",
    timestamp: new Date().toISOString()
  };
  const threadWithoutComposer = {
    ...initialWorldState,
    interactionCandidates: [
      {
        id: "thread-project-update-open",
        surface: "desktop",
        kind: "text",
        text: "Project update",
        role: "row",
        bounds: { x: 10, y: 10, width: 220, height: 28, centerX: 120, centerY: 24 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", ariaLabel: "Project update", actions: ["AXPress"] },
        isInteractive: true
      }
    ],
    visibleText: "Outlook\nProject update\nCustomer: Any update?"
  };
  const fakeSurface = {
    async observe() {
      if (!opened) {
        return initialWorldState;
      }
      return threadWithoutComposer;
    },
    async act({ step }) {
      if (step.action === "clickTarget") {
        opened = true;
      }
      if (step.action === "pressKey" && step.params?.key === "r") {
        replyShortcutUsed = true;
      }
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-shortcut",
    goal: "Always watch Outlook and prefill replies for unread mail",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-shortcut",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
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

  assert.equal(replyShortcutUsed, false);
  assert.equal(context, null);
});

test("outlook desktop pack can use visual model analysis to build a prefill task without AX candidates", async () => {
  const worldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-vision",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowName: "Inbox - Outlook",
          bounds: { x: 120, y: 40, width: 1180, height: 820, centerX: 710, centerY: 450 }
        }
      ]
    },
    capture: {
      id: "artifact-outlook-vision",
      taskId: "task-outlook-vision",
      traceId: null,
      kind: "screenshot",
      label: "Outlook vision state",
      path: "/tmp/outlook-vision.png",
      metadata: {},
      createdAt: new Date().toISOString()
    },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Outlook\nInbox\nUnread\nAlice - Need your review",
    recentActions: [],
    summary: "Outlook",
    timestamp: new Date().toISOString()
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({})
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-vision-detect",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-vision",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: worldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async () => ({
          scene: "list",
          sceneEvidence: "Unread message is visible in the inbox list",
          recommendedRecoveryAction: "none",
          recoveryControl: { present: false, evidence: "", approxBox: null },
          openThread: null,
          visibleUnreadThreads: [
            {
              name: "Alice - Need your review",
              evidence: "Unread bold subject row",
              replyable: true,
              conversationKind: "mail",
              shouldReply: true,
              replyReason: "Unread direct email likely needing a response.",
              latestSnippet: "Can you review this draft today?",
              priority: "high",
              approxBox: { x: 0.18, y: 0.22, width: 0.28, height: 0.08 }
            }
          ],
          composer: {
            present: false,
            evidence: "",
            approxBox: null
          }
        })
      }
    } as never
  });

  assert.equal(detection?.summary, "Alice - Need your review");
  assert.equal(detection?.inputs?.threadTitle, "Alice - Need your review");
  assert.equal((detection?.inputs?.openCandidate as { text?: string } | undefined)?.text, "Alice - Need your review");
  assert.equal(Number.isFinite(Number(detection?.inputs?.openX ?? NaN)), true);
  assert.deepEqual(detection?.taskSpec?.steps.map((step) => step.label), [
    "Focus Outlook",
    "Open unread Outlook thread",
    "Wait for Outlook thread to open",
    "Open Outlook reply composer",
    "Wait for Outlook composer",
    "Type Outlook reply",
    "Verify Outlook prefill"
  ]);
});

test("outlook desktop pack waits for a reply button click to reveal the composer before falling back to shortcuts", async () => {
  let opened = false;
  let replyButtonClicked = false;
  let replyShortcutUsed = false;
  const initialWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-reply-button",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [{ title: "Inbox - Microsoft Outlook" }]
    },
    capture: null,
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "thread-project-update",
        surface: "desktop",
        kind: "text",
        text: "Unread email Project update",
        role: "row",
        bounds: { x: 10, y: 10, width: 220, height: 28, centerX: 120, centerY: 24 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", ariaLabel: "Unread email Project update", actions: ["AXPress"] },
        isInteractive: true
      }
    ],
    visibleText: "Outlook\nUnread\nProject update",
    recentActions: [],
    summary: "Microsoft Outlook unread list",
    timestamp: new Date().toISOString()
  };
  const threadWithoutComposer = {
    ...initialWorldState,
    interactionCandidates: [
      {
        id: "thread-project-update-open",
        surface: "desktop",
        kind: "text",
        text: "Project update",
        role: "row",
        bounds: { x: 10, y: 10, width: 220, height: 28, centerX: 120, centerY: 24 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", ariaLabel: "Project update", actions: ["AXPress"] },
        isInteractive: true
      },
      {
        id: "reply-button",
        surface: "desktop",
        kind: "element",
        text: "Reply",
        role: "button",
        bounds: { x: 20, y: 180, width: 80, height: 32, centerX: 60, centerY: 196 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", ariaLabel: "Reply", actions: ["AXPress"] },
        isInteractive: true
      }
    ],
    visibleText: "Outlook\nProject update\nCustomer: Any update?\nReply"
  };
  const threadWithComposer = {
    ...threadWithoutComposer,
    interactionCandidates: [
      threadWithoutComposer.interactionCandidates[0],
      {
        id: "reply-field",
        surface: "desktop",
        kind: "element",
        text: "Reply",
        role: "textbox",
        bounds: { x: 20, y: 220, width: 260, height: 42, centerX: 150, centerY: 241 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", placeholder: "Reply", focused: true, actions: ["AXPress"] },
        isInteractive: true
      },
      {
        id: "send-reply",
        surface: "desktop",
        kind: "element",
        text: "Send",
        role: "button",
        bounds: { x: 300, y: 220, width: 80, height: 32, centerX: 340, centerY: 236 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", ariaLabel: "Send", actions: ["AXPress"] },
        isInteractive: true
      }
    ],
    visibleText: "Outlook\nProject update\nCustomer: Any update?\nReply\nSend"
  };
  const fakeSurface = {
    async observe() {
      if (!opened) {
        return initialWorldState;
      }
      return replyButtonClicked ? threadWithComposer : threadWithoutComposer;
    },
    async act({ step }) {
      if ((step.action === "clickTarget" || step.action === "clickAt") && String(step.label ?? "").includes("Open mail thread")) {
        opened = true;
      }
      if (step.action === "clickTarget" && String(step.label ?? "").includes("Open mail reply composer")) {
        replyButtonClicked = true;
      }
      if (step.action === "pressKey" && step.params?.key === "r") {
        replyShortcutUsed = true;
      }
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-reply-button",
    goal: "Always watch Outlook and prefill replies for unread mail",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-reply-button",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
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

  assert.equal(replyButtonClicked, true);
  assert.equal(replyShortcutUsed, false);
  assert.equal(context?.inputs?.typeTarget, "Reply");
  assert.equal(context?.inputs?.sendTargetQuery, "Send");
  assert.equal(context?.taskSpec?.steps?.[1]?.label, "Focus Outlook composer");
  assert.equal(context?.taskSpec?.steps?.[2]?.params?.clear, true);
});

test("outlook desktop pack retries the reply button when the composer is not visible after the first click", async () => {
  let opened = false;
  let replyButtonClicks = 0;
  let replyShortcutUsed = false;
  const initialWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-reply-retry",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [{ title: "Inbox - Microsoft Outlook" }]
    },
    capture: null,
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "thread-project-update",
        surface: "desktop",
        kind: "text",
        text: "Unread email Project update",
        role: "row",
        bounds: { x: 10, y: 10, width: 220, height: 28, centerX: 120, centerY: 24 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", ariaLabel: "Unread email Project update", actions: ["AXPress"] },
        isInteractive: true
      }
    ],
    visibleText: "Outlook\nUnread\nProject update",
    recentActions: [],
    summary: "Microsoft Outlook unread list",
    timestamp: new Date().toISOString()
  };
  const threadWithoutComposer = {
    ...initialWorldState,
    interactionCandidates: [
      {
        id: "thread-project-update-open",
        surface: "desktop",
        kind: "text",
        text: "Project update",
        role: "row",
        bounds: { x: 10, y: 10, width: 220, height: 28, centerX: 120, centerY: 24 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", ariaLabel: "Project update", actions: ["AXPress"] },
        isInteractive: true
      },
      {
        id: "reply-button",
        surface: "desktop",
        kind: "element",
        text: "Reply",
        role: "button",
        bounds: { x: 20, y: 180, width: 80, height: 32, centerX: 60, centerY: 196 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", ariaLabel: "Reply", actions: ["AXPress"] },
        isInteractive: true
      }
    ],
    visibleText: "Outlook\nProject update\nCustomer: Any update?\nReply"
  };
  const threadWithComposer = {
    ...threadWithoutComposer,
    interactionCandidates: [
      threadWithoutComposer.interactionCandidates[0],
      {
        id: "reply-field",
        surface: "desktop",
        kind: "element",
        text: "Reply",
        role: "textbox",
        bounds: { x: 20, y: 220, width: 260, height: 42, centerX: 150, centerY: 241 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", placeholder: "Reply", focused: true, actions: ["AXPress"] },
        isInteractive: true
      },
      {
        id: "send-reply",
        surface: "desktop",
        kind: "element",
        text: "Send",
        role: "button",
        bounds: { x: 300, y: 220, width: 80, height: 32, centerX: 340, centerY: 236 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", ariaLabel: "Send", actions: ["AXPress"] },
        isInteractive: true
      }
    ],
    visibleText: "Outlook\nProject update\nCustomer: Any update?\nReply\nSend"
  };
  const fakeSurface = {
    async observe() {
      if (!opened) {
        return initialWorldState;
      }
      return replyButtonClicks >= 2 ? threadWithComposer : threadWithoutComposer;
    },
    async act({ step }) {
      if ((step.action === "clickTarget" || step.action === "clickAt") && String(step.label ?? "").includes("Open mail thread")) {
        opened = true;
      }
      if (step.action === "clickTarget" && String(step.label ?? "").includes("Open mail reply composer")) {
        replyButtonClicks += 1;
      }
      if (step.action === "pressKey" && step.params?.key === "r") {
        replyShortcutUsed = true;
      }
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-reply-retry",
    goal: "Always watch Outlook and prefill replies for unread mail",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-reply-retry",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
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

  assert.equal(replyButtonClicks, 2);
  assert.equal(replyShortcutUsed, false);
  assert.equal(context?.inputs?.typeTarget, "Reply");
  assert.equal(context?.taskSpec?.steps?.[1]?.label, "Focus Outlook composer");
});

test("outlook desktop pack can visually ground a reply control when AX reply controls are missing", async () => {
  let opened = false;
  let replyControlClicked = false;
  const initialWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-visual-reply-control",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowName: "Inbox - Microsoft Outlook",
          bounds: { x: 120, y: 40, width: 1180, height: 820, centerX: 710, centerY: 450 }
        }
      ]
    },
    capture: {
      id: "artifact-outlook-visual-reply-control-initial",
      taskId: "task-outlook-visual-reply-control",
      traceId: null,
      kind: "screenshot",
      label: "Outlook list",
      path: "/tmp/outlook-visual-reply-control-initial.png",
      metadata: {},
      createdAt: new Date().toISOString()
    },
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "thread-project-update",
        surface: "desktop",
        kind: "text",
        text: "Unread email Project update",
        role: "row",
        bounds: { x: 240, y: 180, width: 260, height: 40, centerX: 370, centerY: 200 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", ariaLabel: "Unread email Project update", actions: ["AXPress"] },
        isInteractive: true
      }
    ],
    visibleText: "Outlook\nUnread\nProject update",
    recentActions: [],
    summary: "Microsoft Outlook unread list",
    timestamp: new Date().toISOString()
  };
  const threadWithoutComposer = {
    ...initialWorldState,
    capture: {
      ...initialWorldState.capture,
      id: "artifact-outlook-visual-reply-control-thread",
      label: "Outlook thread",
      path: "/tmp/outlook-visual-reply-control-thread.png"
    },
    interactionCandidates: [
      {
        id: "thread-project-update-open",
        surface: "desktop",
        kind: "text",
        text: "Project update",
        role: "row",
        bounds: { x: 240, y: 180, width: 260, height: 40, centerX: 370, centerY: 200 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", ariaLabel: "Project update", actions: ["AXPress"] },
        isInteractive: true
      }
    ],
    visibleText: "Outlook\nProject update\nCustomer: Any update?"
  };
  const threadWithVisualComposer = {
    ...threadWithoutComposer,
    capture: {
      ...threadWithoutComposer.capture,
      id: "artifact-outlook-visual-reply-control-compose",
      label: "Outlook composer",
      path: "/tmp/outlook-visual-reply-control-compose.png"
    },
    visibleText: "Outlook\nProject update\nCustomer: Any update?\nInline reply editor\nSend"
  };
  const fakeSurface = {
    async observe() {
      if (!opened) {
        return initialWorldState;
      }
      return replyControlClicked ? threadWithVisualComposer : threadWithoutComposer;
    },
    async act({ step }) {
      if ((step.action === "clickTarget" || step.action === "clickAt") && String(step.label ?? "").includes("Open mail thread")) {
        opened = true;
      }
      if (step.action === "clickTarget" && String(step.label ?? "").includes("Open mail reply composer")) {
        replyControlClicked = true;
      }
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-visual-reply-control",
    goal: "Always watch Outlook and prefill replies for unread mail",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-visual-reply-control",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
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
      modelClient: {
        isConfigured: () => false,
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }) => {
          if (schemaName === "agentos_outlook_reply_control") {
            return {
              present: true,
              evidence: "Reply action near the top of the reading pane",
              label: "Reply",
              approxBox: { x: 0.56, y: 0.19, width: 0.08, height: 0.04 }
            };
          }
          if (schemaName === "agentos_outlook_desktop_visual") {
            if (replyControlClicked) {
              return {
                scene: "thread",
                sceneEvidence: "A thread is open and an inline reply editor is visible.",
                recommendedRecoveryAction: "none",
                recoveryControl: { present: false, evidence: "", approxBox: null },
                openThread: "Project update",
                bestUnreadThread: {
                  present: false,
                  name: "",
                  evidence: "",
                  replyable: false,
                  conversationKind: "unknown",
                  shouldReply: false,
                  replyReason: "",
                  latestSnippet: "",
                  priority: "low",
                  approxBox: null
                },
                composer: {
                  present: true,
                  evidence: "Inline reply editor",
                  approxBox: { x: 0.42, y: 0.68, width: 0.36, height: 0.14 },
                  entryPoint: { x: 0.61, y: 0.74 }
                },
                targetThreadOpen: true,
                prefillVisible: false
              };
            }
            return {
              scene: "thread",
              sceneEvidence: "A thread is open in the reading pane but no reply composer is visible yet.",
              recommendedRecoveryAction: "none",
              recoveryControl: { present: false, evidence: "", approxBox: null },
              openThread: "Project update",
              bestUnreadThread: {
                present: false,
                name: "",
                evidence: "",
                replyable: false,
                conversationKind: "unknown",
                shouldReply: false,
                replyReason: "",
                latestSnippet: "",
                priority: "low",
                approxBox: null
              },
              composer: {
                present: false,
                evidence: "",
                approxBox: null
              },
              targetThreadOpen: true,
              prefillVisible: false
            };
          }
          throw new Error(`Unexpected schema ${schemaName}`);
        }
      }
    } as never
  });

  assert.equal(replyControlClicked, true);
  assert.equal(context?.inputs?.typeTarget, "Inline reply editor");
  assert.equal(context?.taskSpec?.steps?.[1]?.label, "Focus Outlook composer");
});

test("outlook desktop pack refuses to reuse a visible composer that already contains draft text", async () => {
  const composeCapturePath = `/tmp/outlook-existing-draft-compose-${Date.now()}.png`;
  await fs.writeFile(composeCapturePath, createPngHeaderBuffer(1440, 900));

  const threadWithExistingDraft = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-existing-draft",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowName: "Inbox - Microsoft Outlook",
          bounds: { x: 120, y: 40, width: 1180, height: 820, centerX: 710, centerY: 450 }
        }
      ]
    },
    capture: {
      id: "artifact-outlook-existing-draft",
      taskId: "task-outlook-existing-draft",
      traceId: null,
      kind: "screenshot",
      label: "Outlook existing draft compose",
      path: composeCapturePath,
      metadata: {},
      createdAt: new Date().toISOString()
    },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Outlook\nRe: Project update\nExisting draft reply",
    recentActions: [],
    summary: "Microsoft Outlook thread with existing draft",
    timestamp: new Date().toISOString()
  };

  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: {
        async observe() {
          return threadWithExistingDraft;
        },
        async act() {
          return { ok: true };
        }
      } as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-existing-draft",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
  const detection = {
    summary: "Project update",
    inputs: {
      openTarget: "Project update"
    },
    metadata: {
      visualAnalysis: {
        scene: "thread",
        openThread: "Project update"
      }
    }
  };
  const workspace: WorkspaceProfile = {
    id: "profile-outlook-existing-draft",
    name: "outlook-desktop-main",
    rootPath: "/tmp",
    profilePath: "/tmp/profile",
    downloadsPath: "/tmp/downloads",
    artifactsPath: "/tmp/artifacts",
    scratchPath: "/tmp/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const context = await pack?.extractContext?.({
    rule,
    worldState: threadWithExistingDraft as never,
    detection: detection as never,
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        async analyzeImageJson({ schemaName }: { schemaName: string }) {
          if (schemaName === "agentos_outlook_desktop_visual") {
            return {
              scene: "thread",
              sceneEvidence: "A reply composer is open and already contains draft text.",
              recommendedRecoveryAction: "none",
              recoveryControl: { present: false, evidence: "", approxBox: null },
              openThread: "Project update",
              bestUnreadThread: {
                present: false,
                name: "",
                evidence: "",
                replyable: false,
                conversationKind: "unknown",
                shouldReply: false,
                replyReason: "",
                latestSnippet: "",
                priority: "low",
                approxBox: null
              },
              composer: {
                present: true,
                evidence: "Inline reply editor",
                hasDraftText: true,
                draftPreview: "Existing draft reply",
                approxBox: { x: 0.4, y: 0.18, width: 0.52, height: 0.66 },
                entryPoint: { x: 0.56, y: 0.23 }
              },
              targetThreadOpen: true,
              prefillVisible: false
            };
          }
          throw new Error(`Unexpected schema ${schemaName}`);
        }
      }
    } as never
  });

  assert.equal(context, null);

  await fs.unlink(composeCapturePath).catch(() => {});
});

test("outlook desktop pack does not mistake a quoted original message for authored draft text", async () => {
  const composeCapturePath = `/tmp/outlook-quoted-message-compose-${Date.now()}.png`;
  await fs.writeFile(composeCapturePath, createPngHeaderBuffer(1440, 900));

  const threadWithQuotedMessageOnly = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-quoted-message-only",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowName: "Inbox - Microsoft Outlook",
          bounds: { x: 120, y: 40, width: 1180, height: 820, centerX: 710, centerY: 450 }
        }
      ]
    },
    capture: {
      id: "artifact-outlook-quoted-message-only",
      taskId: "task-outlook-quoted-message-only",
      traceId: null,
      kind: "screenshot",
      label: "Outlook quoted message compose",
      path: composeCapturePath,
      metadata: {},
      createdAt: new Date().toISOString()
    },
    ocrBlocks: [
      {
        id: "ocr-quoted-marker",
        text: "On 1/22/26, 17:35, Lazaro Waters wrote:",
        confidence: 0.92,
        bounds: { x: 550, y: 320, width: 420, height: 28, centerX: 760, centerY: 334 }
      },
      {
        id: "ocr-quoted-body",
        text: "Should i share info?",
        confidence: 0.9,
        bounds: { x: 560, y: 360, width: 220, height: 24, centerX: 670, centerY: 372 }
      }
    ],
    interactionCandidates: [],
    visibleText: "Outlook\nRe: extend runway\nOn 1/22/26, 17:35, Lazaro Waters wrote:\nShould i share info?",
    recentActions: [],
    summary: "Microsoft Outlook thread with quoted original message",
    timestamp: new Date().toISOString()
  };

  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: {
        async observe() {
          return threadWithQuotedMessageOnly;
        },
        async act() {
          return { ok: true };
        }
      } as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-quoted-message-only",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
  const detection = {
    summary: "Lazaro Waters",
    inputs: {
      openTarget: "Lazaro Waters"
    },
    metadata: {
      visualAnalysis: {
        scene: "thread",
        openThread: "Re: extend runway"
      },
      visualThread: {
        subjectCue: "extend runway"
      }
    }
  };
  const workspace: WorkspaceProfile = {
    id: "profile-outlook-quoted-message-only",
    name: "outlook-desktop-main",
    rootPath: "/tmp",
    profilePath: "/tmp/profile",
    downloadsPath: "/tmp/downloads",
    artifactsPath: "/tmp/artifacts",
    scratchPath: "/tmp/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const context = await pack?.extractContext?.({
    rule,
    worldState: threadWithQuotedMessageOnly as never,
    detection: detection as never,
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        async analyzeImageJson({ schemaName }: { schemaName: string }) {
          if (schemaName === "agentos_outlook_desktop_visual") {
            return {
              scene: "thread",
              sceneEvidence: "A reply composer is open and the quoted original message is visible below the caret.",
              recommendedRecoveryAction: "none",
              recoveryControl: { present: false, evidence: "", approxBox: null },
              openThread: "Re: extend runway",
              selectedRow: "Lazaro Waters extend run...",
              bestUnreadThread: {
                present: false,
                name: "",
                evidence: "",
                replyable: false,
                conversationKind: "unknown",
                shouldReply: false,
                replyReason: "",
                latestSnippet: "",
                priority: "low",
                approxBox: null
              },
              composer: {
                present: true,
                evidence: "Inline reply editor",
                hasDraftText: true,
                draftPreview: null,
                approxBox: { x: 0.33, y: 0.2, width: 0.62, height: 0.66 },
                entryPoint: { x: 0.37, y: 0.35 }
              },
              targetThreadOpen: true,
              prefillVisible: false
            };
          }
          throw new Error(`Unexpected schema ${schemaName}`);
        }
      }
    } as never
  });

  assert.ok(context);
  assert.equal(context?.inputs?.typeTarget, "Inline reply editor");

  await fs.unlink(composeCapturePath).catch(() => {});
});

test("outlook desktop pack falls back to a heuristic English draft when model drafting fails", async () => {
  const registry = new LivePackRegistry();
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-draft-fallback",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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

  const draft = await pack?.draftReply?.({
    rule,
    detection: {
      summary: "Re: extend runway",
      context: [
        "Should I share info?",
        "Curious, are you using AWS or Google Cloud?"
      ]
    } as never,
    controlPlane: {
      modelClient: {
        isConfigured: () => true,
        draftReply: async () => {
          throw new Error("Claude Code CLI request failed");
        }
      },
      listReplyStylePreferences: () => []
    } as never
  });

  assert.equal(draft?.replyText, "Thanks for your email. I received it and will follow up shortly.");
  assert.equal(draft?.metadata?.source, "heuristic");
  assert.match(String(draft?.metadata?.modelError ?? ""), /Claude Code CLI request failed/);
});

test("outlook desktop pack does not retry opening a newly selected thread just because the reading pane subject differs from the sender row", async () => {
  const threadCapturePath = `/tmp/outlook-thread-subject-mismatch-${Date.now()}.png`;
  const composeCapturePath = `/tmp/outlook-thread-subject-mismatch-compose-${Date.now()}.png`;
  await fs.writeFile(threadCapturePath, createPngHeaderBuffer(1440, 900));
  await fs.writeFile(composeCapturePath, createPngHeaderBuffer(1440, 900));

  let opened = false;
  let openClicks = 0;
  let returnedToList = false;
  let replyControlClicked = false;

  const initialWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-thread-subject-mismatch",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [{ title: "Inbox - Microsoft Outlook" }]
    },
    capture: null,
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "outlook-row-lazaro",
        surface: "desktop",
        kind: "text",
        text: "Lazaro Waters",
        role: "row",
        bounds: { x: 240, y: 200, width: 220, height: 52, centerX: 350, centerY: 226 },
        confidence: 0.98,
        sourceHints: { source: "accessibility", ariaLabel: "Lazaro Waters", actions: ["AXPress"] },
        isInteractive: true
      }
    ],
    visibleText: "Outlook\nInbox\nUnread\nlingrui.zhang@fou...",
    recentActions: [],
    summary: "Microsoft Outlook unread list",
    timestamp: new Date().toISOString()
  };
  const threadWithoutComposer = {
    ...initialWorldState,
    capture: {
      id: "artifact-outlook-thread-subject-mismatch",
      taskId: "task-outlook-thread-subject-mismatch",
      traceId: null,
      kind: "screenshot",
      label: "Outlook thread without composer",
      path: threadCapturePath,
      metadata: {},
      createdAt: new Date().toISOString()
    },
    interactionCandidates: [],
    visibleText: "Outlook\nRe: Tan, quick thought\n您好, 管理一支全球化..."
  };
  const listAfterMisclick = {
    ...initialWorldState,
    capture: {
      ...threadWithoutComposer.capture,
      id: "artifact-outlook-thread-subject-mismatch-list",
      label: "Outlook list after retry misclick"
    },
    visibleText: "Outlook\nInbox\nUnread\n李伟"
  };
  const threadWithVisualComposer = {
    ...threadWithoutComposer,
    capture: {
      ...threadWithoutComposer.capture,
      id: "artifact-outlook-thread-subject-mismatch-compose",
      label: "Outlook thread with visual composer",
      path: composeCapturePath
    },
    visibleText: "Outlook\nRe: Tan, quick thought\nInline reply editor\nSend"
  };

  const fakeSurface = {
    async observe() {
      if (!opened) {
        return initialWorldState;
      }
      if (returnedToList) {
        return listAfterMisclick;
      }
      return replyControlClicked ? threadWithVisualComposer : threadWithoutComposer;
    },
    async act({ step }) {
      if (step.action === "clickAt" && String(step.label ?? "").includes("Open mail thread")) {
        openClicks += 1;
        if (!opened) {
          opened = true;
        } else {
          returnedToList = true;
        }
      }
      if (step.action === "clickTarget" && String(step.label ?? "").includes("Open mail reply composer")) {
        replyControlClicked = true;
      }
      return { ok: true };
    }
  };

  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-thread-subject-mismatch",
    goal: "Always watch Outlook and prefill replies for unread mail",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-thread-subject-mismatch",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const detection = {
    fingerprint: "outlook-thread-subject-mismatch",
    summary: "lingrui.zhang@fou...",
    text: "lingrui.zhang@fou...",
    context: ["您好, 管理一支全球化..."],
    inputs: {
      openTarget: "lingrui.zhang@fou...",
      openX: 280,
      openY: 220
    },
    metadata: {
      visualAnalysis: {
        scene: "thread",
        openThread: "Existing open thread"
      }
    }
  };

  const context = await pack?.extractContext?.({
    rule,
    worldState: initialWorldState as never,
    detection: detection as never,
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        isConfigured: () => false,
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }) => {
          if (schemaName === "agentos_outlook_reply_control") {
            return {
              present: true,
              evidence: "Reply action above the reading pane footer",
              label: "Reply",
              approxBox: { x: 0.56, y: 0.18, width: 0.08, height: 0.05 }
            };
          }
          if (schemaName === "agentos_outlook_desktop_visual") {
            if (returnedToList) {
              return {
                scene: "list",
                sceneEvidence: "The inbox list is visible.",
                recommendedRecoveryAction: "none",
                recoveryControl: { present: false, evidence: "", approxBox: null },
                openThread: null,
                bestUnreadThread: {
                  present: true,
                  name: "李伟",
                  evidence: "Unread email from 李伟.",
                  replyable: true,
                  conversationKind: "mail",
                  shouldReply: true,
                  replyReason: "Personal email",
                  latestSnippet: "您好! 贵方...",
                  priority: "high",
                  approxBox: { x: 0.12, y: 0.18, width: 0.14, height: 0.05 }
                },
                composer: { present: false, evidence: "", approxBox: null },
                targetThreadOpen: null,
                prefillVisible: false
              };
            }
            if (replyControlClicked) {
              return {
                scene: "thread",
                sceneEvidence: "A thread is open and an inline reply editor is visible.",
                recommendedRecoveryAction: "none",
                recoveryControl: { present: false, evidence: "", approxBox: null },
                openThread: "Re: Tan, quick thought",
                bestUnreadThread: {
                  present: false,
                  name: "",
                  evidence: "",
                  replyable: false,
                  conversationKind: "unknown",
                  shouldReply: false,
                  replyReason: "",
                  latestSnippet: "",
                  priority: "low",
                  approxBox: null
                },
                composer: {
                  present: true,
                  evidence: "Inline reply editor",
                  approxBox: { x: 0.42, y: 0.68, width: 0.36, height: 0.14 },
                  entryPoint: { x: 0.61, y: 0.74 }
                },
                targetThreadOpen: null,
                prefillVisible: false
              };
            }
            return {
              scene: "thread",
              sceneEvidence: "A thread is open in the reading pane but no reply composer is visible yet.",
              recommendedRecoveryAction: "none",
              recoveryControl: { present: false, evidence: "", approxBox: null },
              openThread: "Re: Tan, quick thought",
              bestUnreadThread: {
                present: false,
                name: "",
                evidence: "",
                replyable: false,
                conversationKind: "unknown",
                shouldReply: false,
                replyReason: "",
                latestSnippet: "",
                priority: "low",
                approxBox: null
              },
              composer: {
                present: false,
                evidence: "",
                approxBox: null
              },
              targetThreadOpen: null,
              prefillVisible: false
            };
          }
          throw new Error(`Unexpected schema ${schemaName}`);
        }
      }
    } as never
  });

  assert.equal(openClicks, 1);
  assert.equal(returnedToList, false);
  assert.equal(replyControlClicked, true);
  assert.equal(context?.inputs?.threadVerifyTarget, "Tan, quick thought");
  assert.equal(context?.inputs?.typeTarget, "Inline reply editor");

  await fs.unlink(threadCapturePath).catch(() => {});
  await fs.unlink(composeCapturePath).catch(() => {});
});

test("outlook desktop pack keeps retry target queries pinned to the sender row instead of rotating to the subject cue", async () => {
  const openQueries: string[] = [];
  const initialWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-retry-query",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [{ title: "Inbox - Microsoft Outlook" }]
    },
    capture: null,
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Outlook\nInbox\nUnread\nLazaro Waters\nextend run...",
    recentActions: [],
    summary: "Microsoft Outlook unread list",
    timestamp: new Date().toISOString()
  };

  const fakeSurface = {
    async observe() {
      return initialWorldState;
    },
    async act({ step }) {
      if (step.action === "clickTarget" && String(step.label ?? "").toLowerCase().includes("mail thread")) {
        openQueries.push(String(step.params?.targetQuery ?? ""));
      }
      return { ok: true };
    }
  };

  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-retry-query",
    goal: "Always watch Outlook and prefill replies for unread mail",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-retry-query",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const detection = {
    fingerprint: "outlook-retry-query",
    summary: "Lazaro Waters",
    text: "Lazaro Waters",
    context: ["extend run..."],
    inputs: {
      openTarget: "Lazaro Waters"
    },
    metadata: {
      openCandidate: {
        id: "outlook-retry-query-open",
        text: "Lazaro Waters",
        role: "text",
        isInteractive: true,
        bounds: { x: 240, y: 200, width: 220, height: 52, centerX: 350, centerY: 226 }
      },
      visualAnalysis: {
        scene: "list",
        openThread: null
      },
      visualThread: {
        subjectCue: "extend run..."
      }
    }
  };

  const context = await pack?.extractContext?.({
    rule,
    worldState: initialWorldState as never,
    detection: detection as never,
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        isConfigured: () => false,
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }: { schemaName?: string }) => {
          if (schemaName === "agentos_outlook_desktop_visual") {
            return {
              scene: "list",
              sceneEvidence: "The inbox list is still visible and the same unread row remains on screen.",
              recommendedRecoveryAction: "none",
              recoveryControl: { present: false, evidence: "", approxBox: null },
              openThread: null,
              bestUnreadThread: {
                present: true,
                name: "Lazaro Waters",
                evidence: "Unread sender row still visible.",
                replyable: true,
                conversationKind: "mail",
                shouldReply: true,
                replyReason: "Unread mail that likely needs a response.",
                latestSnippet: "Need the extension approved",
                subjectCue: "extend run...",
                priority: "high",
                approxBox: { x: 0.18, y: 0.24, width: 0.24, height: 0.08 }
              },
              composer: {
                present: false,
                evidence: "",
                approxBox: null
              },
              targetThreadOpen: false,
              prefillVisible: false
            };
          }
          throw new Error(`Unexpected schema ${schemaName}`);
        }
      }
    } as never
  });

  assert.equal(context, null);
  assert.ok(openQueries.length >= 2);
  assert.deepEqual(openQueries, Array.from({ length: openQueries.length }, () => "Lazaro Waters"));
});

test("outlook desktop pack does not reopen the message list when a transient visual analysis failure happens after the target row is already selected", async () => {
  const threadCapturePath = `/tmp/outlook-selected-row-transient-null-${Date.now()}.png`;
  const composeCapturePath = `/tmp/outlook-selected-row-transient-null-compose-${Date.now()}.png`;
  await fs.writeFile(threadCapturePath, createPngHeaderBuffer(1440, 900));
  await fs.writeFile(composeCapturePath, createPngHeaderBuffer(1440, 900));

  let openClicks = 0;
  let replyControlClicked = false;
  let visualAnalyzeCalls = 0;

  const initialWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-selected-row-transient-null",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [{ title: "Inbox - Microsoft Outlook" }]
    },
    capture: null,
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Outlook\nInbox\nUnread\nnew PIO",
    recentActions: [],
    summary: "Microsoft Outlook unread list",
    timestamp: new Date().toISOString()
  };
  const threadWithoutComposer = {
    ...initialWorldState,
    capture: {
      id: "artifact-outlook-selected-row-transient-null",
      taskId: "task-outlook-selected-row-transient-null",
      traceId: null,
      kind: "screenshot",
      label: "Outlook thread without composer",
      path: threadCapturePath,
      metadata: {},
      createdAt: new Date().toISOString()
    },
    visibleText: "Outlook\nRe: For Payinone\nnew PIO\nReply"
  };
  const threadWithComposer = {
    ...threadWithoutComposer,
    capture: {
      ...threadWithoutComposer.capture,
      id: "artifact-outlook-selected-row-transient-null-compose",
      label: "Outlook thread with composer",
      path: composeCapturePath
    },
    visibleText: "Outlook\nRe: For Payinone\nInline reply editor\nSend"
  };

  const fakeSurface = {
    async observe() {
      return replyControlClicked ? threadWithComposer : threadWithoutComposer;
    },
    async act({ step }) {
      if (String(step.label ?? "").includes("Open mail thread")) {
        openClicks += 1;
      }
      if (step.action === "clickTarget" && String(step.label ?? "").includes("Open mail reply composer")) {
        replyControlClicked = true;
      }
      return { ok: true };
    }
  };

  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-selected-row-transient-null",
    goal: "Always watch Outlook and prefill replies for unread mail",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-selected-row-transient-null",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const detection = {
    fingerprint: "outlook-selected-row-transient-null",
    summary: "new PIO",
    text: "new PIO",
    context: ["Bug 报告: 创建汇总账..."],
    inputs: {
      openTarget: "new PIO",
      openX: 458,
      openY: 798
    },
    metadata: {
      visualAnalysis: {
        scene: "thread",
        openThread: "For Payinone",
        selectedRow: "new PIO"
      }
    }
  };

  const context = await pack?.extractContext?.({
    rule,
    worldState: initialWorldState as never,
    detection: detection as never,
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        isConfigured: () => false,
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }) => {
          if (schemaName === "agentos_outlook_reply_control") {
            return {
              present: true,
              evidence: "Reply action above the reading pane footer",
              label: "Reply",
              approxBox: { x: 0.56, y: 0.18, width: 0.08, height: 0.05 }
            };
          }
          if (schemaName === "agentos_outlook_desktop_visual") {
            visualAnalyzeCalls += 1;
            if (visualAnalyzeCalls === 1) {
              throw new Error("Transient vision timeout");
            }
            if (replyControlClicked) {
              return {
                scene: "thread",
                sceneEvidence: "A thread is open and an inline reply editor is visible.",
                recommendedRecoveryAction: "none",
                recoveryControl: { present: false, evidence: "", approxBox: null },
                openThread: "For Payinone",
                selectedRow: "new PIO",
                bestUnreadThread: {
                  present: false,
                  name: "",
                  evidence: "",
                  replyable: false,
                  conversationKind: "unknown",
                  shouldReply: false,
                  replyReason: "",
                  subjectCue: "",
                  latestSnippet: "",
                  priority: "low",
                  approxBox: null
                },
                composer: {
                  present: true,
                  evidence: "Inline reply editor",
                  approxBox: { x: 0.42, y: 0.68, width: 0.36, height: 0.14 },
                  entryPoint: { x: 0.61, y: 0.74 },
                  hasDraftText: false,
                  draftPreview: null
                },
                targetThreadOpen: null,
                prefillVisible: false
              };
            }
            return {
              scene: "thread",
              sceneEvidence: "A thread is open in the reading pane.",
              recommendedRecoveryAction: "none",
              recoveryControl: { present: false, evidence: "", approxBox: null },
              openThread: "For Payinone",
              selectedRow: "new PIO",
              bestUnreadThread: {
                present: false,
                name: "",
                evidence: "",
                replyable: false,
                conversationKind: "unknown",
                shouldReply: false,
                replyReason: "",
                subjectCue: "",
                latestSnippet: "",
                priority: "low",
                approxBox: null
              },
              composer: {
                present: false,
                evidence: "",
                approxBox: null,
                entryPoint: null,
                hasDraftText: false,
                draftPreview: null
              },
              targetThreadOpen: null,
              prefillVisible: false
            };
          }
          throw new Error(`Unexpected schema ${schemaName}`);
        }
      }
    } as never
  });

  assert.equal(openClicks, 0);
  assert.equal(replyControlClicked, true);
  assert.equal(context?.inputs?.threadVerifyTarget, "For Payinone");
  assert.equal(context?.inputs?.typeTarget, "Inline reply editor");

  await fs.unlink(threadCapturePath).catch(() => {});
  await fs.unlink(composeCapturePath).catch(() => {});
});

test("outlook desktop pack does not fall back to OCR candidates when vision finds no reply-worthy threads", async () => {
  const worldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-no-fallback",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowName: "Inbox - Outlook",
          bounds: { x: 120, y: 40, width: 1180, height: 820, centerX: 710, centerY: 450 }
        }
      ]
    },
    capture: {
      id: "artifact-outlook-no-fallback",
      taskId: "task-outlook-no-fallback",
      traceId: null,
      kind: "screenshot",
      label: "Outlook vision state",
      path: "/tmp/outlook-no-fallback.png",
      metadata: {},
      createdAt: new Date().toISOString()
    },
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "ocr-mail-row",
        surface: "desktop",
        kind: "text",
        text: "TurboTax",
        role: "row",
        bounds: { x: 240, y: 220, width: 280, height: 40, centerX: 380, centerY: 240 },
        confidence: 0.91,
        sourceHints: { source: "ocr", unread: true },
        isInteractive: true
      }
    ],
    visibleText: "Outlook\nInbox\nUnread\nTurboTax",
    recentActions: [],
    summary: "Outlook",
    timestamp: new Date().toISOString()
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({})
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-no-fallback",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-no-fallback",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: worldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async () => ({
          scene: "list",
          sceneEvidence: "Promotional mail rows are visible but do not need a reply",
          recommendedRecoveryAction: "none",
          recoveryControl: { present: false, evidence: "", approxBox: null },
          openThread: null,
          visibleUnreadThreads: [
            {
              name: "TurboTax",
              evidence: "Unread promotional row",
              replyable: false,
              conversationKind: "mail",
              shouldReply: false,
              replyReason: "Promotional newsletter does not need a reply.",
              latestSnippet: "Finish your taxes today",
              priority: "low",
              approxBox: { x: 0.18, y: 0.22, width: 0.28, height: 0.08 }
            }
          ],
          composer: {
            present: false,
            evidence: "",
            approxBox: null
          }
        })
      }
    } as never
  });

  assert.equal(detection, null);
});

test("outlook desktop pack fails closed when desktop scan drifts away from Outlook", async () => {
  const outlookWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-drift",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowName: "Inbox - Outlook",
          bounds: { x: 120, y: 40, width: 1180, height: 820, centerX: 710, centerY: 450 }
        }
      ]
    },
    capture: {
      id: "artifact-outlook-drift",
      taskId: "task-outlook-drift",
      traceId: null,
      kind: "screenshot",
      label: "Outlook inbox",
      path: "/tmp/outlook-drift.png",
      metadata: {},
      createdAt: new Date().toISOString()
    },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Outlook\nInbox\nNo unread reply rows on the first screen",
    recentActions: [],
    summary: "Outlook inbox list",
    timestamp: new Date().toISOString()
  };
  const slackWorldState = {
    ...outlookWorldState,
    appContext: {
      appName: "Slack",
      windows: [
        {
          ownerName: "Slack",
          windowName: "Slack",
          bounds: { x: 120, y: 40, width: 1180, height: 820, centerX: 710, centerY: 450 }
        }
      ]
    },
    capture: {
      ...outlookWorldState.capture,
      id: "artifact-slack-drift",
      path: "/tmp/slack-drift.png"
    },
    visibleText: "Slack\nEngineering\nDrafts & Sent",
    summary: "Slack window"
  };
  const fakeSurface = {
    async observe() {
      return slackWorldState;
    },
    async act() {
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-drift",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-drift",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: outlookWorldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async () => ({
          scene: "list",
          sceneEvidence: "No unread reply-worthy rows are visible yet.",
          recommendedRecoveryAction: "none",
          recoveryControl: { present: false, evidence: "", approxBox: null },
          openThread: null,
          visibleUnreadThreads: [],
          composer: { present: false, evidence: "", approxBox: null }
        })
      }
    } as never
  });

  assert.equal(detection, null);
});

test("outlook desktop pack does not fall back to Cmd+R when composer grounding fails", async () => {
  let replyShortcutUsed = false;
  const threadWithoutComposer = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-no-shortcut",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowName: "Inbox - Outlook",
          bounds: { x: 120, y: 40, width: 1180, height: 820, centerX: 710, centerY: 450 }
        }
      ]
    },
    capture: {
      id: "artifact-outlook-no-shortcut",
      taskId: "task-outlook-no-shortcut",
      traceId: null,
      kind: "screenshot",
      label: "Outlook thread",
      path: "/tmp/outlook-no-shortcut.png",
      metadata: {},
      createdAt: new Date().toISOString()
    },
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "mail-row",
        surface: "desktop",
        kind: "element",
        text: "Project update",
        role: "row",
        bounds: { x: 160, y: 120, width: 420, height: 56, centerX: 370, centerY: 148 },
        confidence: 0.95,
        sourceHints: { source: "accessibility" },
        isInteractive: true
      }
    ],
    visibleText: "Outlook\nProject update\nCustomer: Any update?",
    recentActions: [],
    summary: "Outlook thread open",
    timestamp: new Date().toISOString()
  };
  const fakeSurface = {
    async observe() {
      return threadWithoutComposer;
    },
    async act({ step }: { step: RuntimeStep }) {
      if (step.action === "pressKey" && step.params?.key === "r") {
        replyShortcutUsed = true;
      }
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-no-shortcut",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-no-shortcut",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const context = await pack?.extractContext?.({
    rule,
    worldState: threadWithoutComposer as never,
    detection: {
      summary: "Project update",
      text: "Project update",
      context: [],
      inputs: {
        openTarget: "Project update"
      },
      metadata: {
        visualAnalysis: {
          scene: "thread",
          openThread: "Project update"
        }
      }
    } as never,
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => false
      }
    } as never
  });

  assert.equal(replyShortcutUsed, false);
  assert.equal(context, null);
});

test("outlook desktop pack can use Cmd+R after the thread is visually confirmed open and no reply controls are visible", async () => {
  const threadCapturePath = `/tmp/outlook-shortcut-thread-${Date.now()}.png`;
  const composeCapturePath = `/tmp/outlook-shortcut-compose-${Date.now()}.png`;
  await fs.writeFile(threadCapturePath, createPngHeaderBuffer(1440, 900));
  await fs.writeFile(composeCapturePath, createPngHeaderBuffer(1440, 900));

  let opened = false;
  let replyShortcutUsed = false;
  const initialWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-shortcut-success",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowName: "Inbox - Microsoft Outlook",
          bounds: { x: 120, y: 40, width: 1180, height: 820, centerX: 710, centerY: 450 }
        }
      ]
    },
    capture: null,
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Outlook\nUnread\n李伟",
    recentActions: [],
    summary: "Microsoft Outlook unread list",
    timestamp: new Date().toISOString()
  };
  const threadWithoutComposer = {
    ...initialWorldState,
    capture: {
      id: "artifact-outlook-shortcut-thread",
      taskId: "task-outlook-shortcut-thread",
      traceId: null,
      kind: "screenshot",
      label: "Outlook thread without composer",
      path: threadCapturePath,
      metadata: {},
      createdAt: new Date().toISOString()
    },
    visibleText: "Outlook\nRe: Project update\nCustomer: Any update?"
  };
  const threadWithVisualComposer = {
    ...threadWithoutComposer,
    capture: {
      ...threadWithoutComposer.capture,
      id: "artifact-outlook-shortcut-compose",
      label: "Outlook thread with composer",
      path: composeCapturePath
    },
    visibleText: "Outlook\nRe: Project update\nInline reply editor\nSend"
  };
  const fakeSurface = {
    async observe() {
      if (!opened) {
        return initialWorldState;
      }
      return replyShortcutUsed ? threadWithVisualComposer : threadWithoutComposer;
    },
    async act({ step }: { step: RuntimeStep }) {
      if (step.action === "clickAt" && String(step.label ?? "").includes("Open mail thread")) {
        opened = true;
      }
      if (step.action === "pressKey" && step.params?.key === "r") {
        replyShortcutUsed = true;
      }
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-shortcut-success",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-shortcut-success",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const context = await pack?.extractContext?.({
    rule,
    worldState: initialWorldState as never,
    detection: {
      summary: "李伟",
      text: "李伟",
      context: [],
      inputs: {
        openTarget: "李伟",
        openX: 280,
        openY: 220
      },
      metadata: {
        visualAnalysis: {
          scene: "thread",
          openThread: "Existing open thread"
        }
      }
    } as never,
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }) => {
          if (schemaName === "agentos_outlook_reply_control") {
            return {
              present: false,
              evidence: "",
              label: "",
              approxBox: null
            };
          }
          if (schemaName === "agentos_outlook_desktop_visual") {
            if (replyShortcutUsed) {
              return {
                scene: "thread",
                sceneEvidence: "A thread is open and an inline reply editor is visible.",
                recommendedRecoveryAction: "none",
                recoveryControl: { present: false, evidence: "", approxBox: null },
                openThread: "Re: Project update",
                bestUnreadThread: {
                  present: false,
                  name: "",
                  evidence: "",
                  replyable: false,
                  conversationKind: "unknown",
                  shouldReply: false,
                  replyReason: "",
                  latestSnippet: "",
                  priority: "low",
                  approxBox: null
                },
                composer: {
                  present: true,
                  evidence: "Inline reply editor",
                  approxBox: { x: 0.42, y: 0.68, width: 0.36, height: 0.14 },
                  entryPoint: { x: 0.61, y: 0.74 }
                },
                targetThreadOpen: null,
                prefillVisible: false
              };
            }
            return {
              scene: "thread",
              sceneEvidence: "A thread is open in the reading pane but no reply composer is visible yet.",
              recommendedRecoveryAction: "none",
              recoveryControl: { present: false, evidence: "", approxBox: null },
              openThread: "Re: Project update",
              bestUnreadThread: {
                present: false,
                name: "",
                evidence: "",
                replyable: false,
                conversationKind: "unknown",
                shouldReply: false,
                replyReason: "",
                latestSnippet: "",
                priority: "low",
                approxBox: null
              },
              composer: {
                present: false,
                evidence: "",
                approxBox: null
              },
              targetThreadOpen: null,
              prefillVisible: false
            };
          }
          throw new Error(`Unexpected schema ${schemaName}`);
        }
      }
    } as never
  });

  assert.equal(replyShortcutUsed, true);
  assert.equal(context?.inputs?.threadVerifyTarget, "Project update");
  assert.equal(context?.inputs?.typeTarget, "Inline reply editor");
  const shortcutComposeTarget = (context?.inputs?.composeTarget ?? null) as { bounds?: { centerX?: number; centerY?: number } } | null;
  assert.equal(Math.round(Number(shortcutComposeTarget?.bounds?.centerX ?? 0)), 698);
  assert.equal(Math.round(Number(shortcutComposeTarget?.bounds?.centerY ?? 0)), 650);
  assert.ok(context?.inputs?.composeVerifyRegion);

  await fs.unlink(threadCapturePath).catch(() => {});
  await fs.unlink(composeCapturePath).catch(() => {});
});

test("outlook desktop pack can use Cmd+R when the opened thread matches the unread subject cue instead of the sender row", async () => {
  const threadCapturePath = `/tmp/outlook-shortcut-cue-thread-${Date.now()}.png`;
  const composeCapturePath = `/tmp/outlook-shortcut-cue-compose-${Date.now()}.png`;
  await fs.writeFile(threadCapturePath, createPngHeaderBuffer(1440, 900));
  await fs.writeFile(composeCapturePath, createPngHeaderBuffer(1440, 900));

  let opened = false;
  let replyShortcutUsed = false;
  const initialWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-shortcut-cue",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowName: "Inbox - Microsoft Outlook",
          bounds: { x: 120, y: 40, width: 1180, height: 820, centerX: 710, centerY: 450 }
        }
      ]
    },
    capture: null,
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Outlook\nUnread\nRaghav Bansal\nFor Payinone",
    recentActions: [],
    summary: "Microsoft Outlook unread list",
    timestamp: new Date().toISOString()
  };
  const threadWithoutComposer = {
    ...initialWorldState,
    capture: {
      id: "artifact-outlook-shortcut-cue-thread",
      taskId: "task-outlook-shortcut-cue-thread",
      traceId: null,
      kind: "screenshot",
      label: "Outlook thread without composer",
      path: threadCapturePath,
      metadata: {},
      createdAt: new Date().toISOString()
    },
    visibleText: "Outlook\nRe: For Payinone\nIs any of that showing up right now?"
  };
  const threadWithVisualComposer = {
    ...threadWithoutComposer,
    capture: {
      ...threadWithoutComposer.capture,
      id: "artifact-outlook-shortcut-cue-compose",
      label: "Outlook thread with composer",
      path: composeCapturePath
    },
    visibleText: "Outlook\nRe: For Payinone\nInline reply editor\nSend"
  };
  const fakeSurface = {
    async observe() {
      if (!opened) {
        return initialWorldState;
      }
      return replyShortcutUsed ? threadWithVisualComposer : threadWithoutComposer;
    },
    async act({ step }: { step: RuntimeStep }) {
      if (step.action === "clickAt" && String(step.label ?? "").includes("Open mail thread")) {
        opened = true;
      }
      if (step.action === "pressKey" && step.params?.key === "r") {
        replyShortcutUsed = true;
      }
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-shortcut-cue",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-shortcut-cue",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const context = await pack?.extractContext?.({
    rule,
    worldState: initialWorldState as never,
    detection: {
      summary: "Raghav Bansal",
      text: "Raghav Bansal",
      context: ["Is any of that showing up right now?"],
      inputs: {
        openTarget: "Raghav Bansal",
        openX: 280,
        openY: 220
      },
      metadata: {
        visualAnalysis: {
          scene: "list",
          openThread: null
        },
        visualThread: {
          subjectCue: "For Payinone",
          latestSnippet: "Is any of that showing up right now?"
        }
      }
    } as never,
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }) => {
          if (schemaName === "agentos_outlook_reply_control") {
            return {
              present: false,
              evidence: "",
              label: "",
              approxBox: null
            };
          }
          if (schemaName === "agentos_outlook_desktop_visual") {
            if (replyShortcutUsed) {
              return {
                scene: "thread",
                sceneEvidence: "A thread is open and an inline reply editor is visible.",
                recommendedRecoveryAction: "none",
                recoveryControl: { present: false, evidence: "", approxBox: null },
                openThread: "Re: For Payinone",
                bestUnreadThread: {
                  present: false,
                  name: "",
                  evidence: "",
                  replyable: false,
                  conversationKind: "unknown",
                  shouldReply: false,
                  replyReason: "",
                  latestSnippet: "",
                  priority: "low",
                  approxBox: null
                },
                composer: {
                  present: true,
                  evidence: "Inline reply editor",
                  hasDraftText: false,
                  draftPreview: null,
                  approxBox: { x: 0.42, y: 0.68, width: 0.36, height: 0.14 },
                  entryPoint: { x: 0.61, y: 0.74 }
                },
                targetThreadOpen: null,
                prefillVisible: false
              };
            }
            return {
              scene: "thread",
              sceneEvidence: "A thread is open in the reading pane but no reply composer is visible yet.",
              recommendedRecoveryAction: "none",
              recoveryControl: { present: false, evidence: "", approxBox: null },
              openThread: "Re: For Payinone",
              bestUnreadThread: {
                present: false,
                name: "",
                evidence: "",
                replyable: false,
                conversationKind: "unknown",
                shouldReply: false,
                replyReason: "",
                latestSnippet: "",
                priority: "low",
                approxBox: null
              },
              composer: {
                present: false,
                evidence: "",
                hasDraftText: null,
                draftPreview: null,
                approxBox: null,
                entryPoint: null
              },
              targetThreadOpen: null,
              prefillVisible: false
            };
          }
          throw new Error(`Unexpected schema ${schemaName}`);
        }
      }
    } as never
  });

  assert.equal(replyShortcutUsed, true);
  assert.equal(context?.inputs?.threadVerifyTarget, "For Payinone");

  await fs.unlink(threadCapturePath).catch(() => {});
  await fs.unlink(composeCapturePath).catch(() => {});
});

test("outlook desktop pack waits for a delayed composer after Cmd+R and uses the reply body entry point", async () => {
  const threadCapturePath = `/tmp/outlook-shortcut-delay-thread-${Date.now()}.png`;
  const composeCapturePath = `/tmp/outlook-shortcut-delay-compose-${Date.now()}.png`;
  await fs.writeFile(threadCapturePath, createPngHeaderBuffer(1440, 900));
  await fs.writeFile(composeCapturePath, createPngHeaderBuffer(1440, 900));

  let opened = false;
  let replyShortcutUsed = false;
  let postShortcutObserveCount = 0;
  const initialWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-shortcut-delay",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowName: "Inbox - Outlook",
          bounds: { x: 120, y: 40, width: 1180, height: 820, centerX: 710, centerY: 450 }
        }
      ]
    },
    capture: null,
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Outlook\nUnread\nJin Wang",
    recentActions: [],
    summary: "Microsoft Outlook unread list",
    timestamp: new Date().toISOString()
  };
  const threadWithoutComposer = {
    ...initialWorldState,
    capture: {
      id: "artifact-outlook-shortcut-delay-thread",
      taskId: "task-outlook-shortcut-delay-thread",
      traceId: null,
      kind: "screenshot",
      label: "Outlook thread without composer",
      path: threadCapturePath,
      metadata: {},
      createdAt: new Date().toISOString()
    },
    visibleText: "Outlook\nRe: Project update\nCustomer: Any update?"
  };
  const threadWithVisualComposer = {
    ...threadWithoutComposer,
    capture: {
      ...threadWithoutComposer.capture,
      id: "artifact-outlook-shortcut-delay-compose",
      label: "Outlook thread with delayed composer",
      path: composeCapturePath
    },
    visibleText: "Outlook\nRe: Project update\nInline reply editor\nSend"
  };
  const fakeSurface = {
    async observe() {
      if (!opened) {
        return initialWorldState;
      }
      if (replyShortcutUsed) {
        postShortcutObserveCount += 1;
        return postShortcutObserveCount >= 2 ? threadWithVisualComposer : threadWithoutComposer;
      }
      return threadWithoutComposer;
    },
    async act({ step }: { step: RuntimeStep }) {
      if (step.action === "clickAt" && String(step.label ?? "").includes("Open mail thread")) {
        opened = true;
      }
      if (step.action === "pressKey" && step.params?.key === "r") {
        replyShortcutUsed = true;
      }
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-shortcut-delay",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-shortcut-delay",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const context = await pack?.extractContext?.({
    rule,
    worldState: initialWorldState as never,
    detection: {
      summary: "Jin Wang",
      text: "Jin Wang",
      context: [],
      inputs: {
        openTarget: "Jin Wang",
        openX: 280,
        openY: 220
      },
      metadata: {
        visualAnalysis: {
          scene: "thread",
          openThread: "Existing open thread"
        }
      }
    } as never,
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }) => {
          if (schemaName === "agentos_outlook_reply_control") {
            return {
              present: false,
              evidence: "",
              label: "",
              approxBox: null
            };
          }
          if (schemaName === "agentos_outlook_desktop_visual") {
            if (replyShortcutUsed && postShortcutObserveCount >= 2) {
              return {
                scene: "thread",
                sceneEvidence: "A thread is open and the reply editor is now visible.",
                recommendedRecoveryAction: "none",
                recoveryControl: { present: false, evidence: "", approxBox: null },
                openThread: "Re: Project update",
                bestUnreadThread: {
                  present: false,
                  name: "",
                  evidence: "",
                  replyable: false,
                  conversationKind: "unknown",
                  shouldReply: false,
                  replyReason: "",
                  latestSnippet: "",
                  priority: "low",
                  approxBox: null
                },
                composer: {
                  present: true,
                  evidence: "Inline reply editor",
                  approxBox: { x: 0.42, y: 0.68, width: 0.36, height: 0.14 },
                  entryPoint: { x: 0.62, y: 0.75 }
                },
                targetThreadOpen: null,
                prefillVisible: false
              };
            }
            return {
              scene: "thread",
              sceneEvidence: "A thread is open in the reading pane but the reply editor has not appeared yet.",
              recommendedRecoveryAction: "none",
              recoveryControl: { present: false, evidence: "", approxBox: null },
              openThread: "Re: Project update",
              bestUnreadThread: {
                present: false,
                name: "",
                evidence: "",
                replyable: false,
                conversationKind: "unknown",
                shouldReply: false,
                replyReason: "",
                latestSnippet: "",
                priority: "low",
                approxBox: null
              },
              composer: {
                present: false,
                evidence: "",
                approxBox: null
              },
              targetThreadOpen: null,
              prefillVisible: false
            };
          }
          throw new Error(`Unexpected schema ${schemaName}`);
        }
      }
    } as never
  });

  assert.equal(replyShortcutUsed, true);
  assert.ok(postShortcutObserveCount >= 2);
  assert.equal(context?.inputs?.typeTarget, "Inline reply editor");
  const delayedComposeTarget = (context?.inputs?.composeTarget ?? null) as { bounds?: { centerX?: number; centerY?: number } } | null;
  assert.equal(Math.round(Number(delayedComposeTarget?.bounds?.centerX ?? 0)), 698);
  assert.equal(Math.round(Number(delayedComposeTarget?.bounds?.centerY ?? 0)), 650);
  assert.ok(context?.inputs?.composeVerifyRegion);

  await fs.unlink(threadCapturePath).catch(() => {});
  await fs.unlink(composeCapturePath).catch(() => {});
});

test("outlook desktop pack treats a truncated subject cue as an already opened thread", async () => {
  const threadCapturePath = `/tmp/outlook-shortcut-truncated-thread-${Date.now()}.png`;
  const composeCapturePath = `/tmp/outlook-shortcut-truncated-compose-${Date.now()}.png`;
  await fs.writeFile(threadCapturePath, createPngHeaderBuffer(1440, 900));
  await fs.writeFile(composeCapturePath, createPngHeaderBuffer(1440, 900));

  let replyShortcutUsed = false;
  const actions: string[] = [];
  const threadWithoutComposer = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-shortcut-truncated",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowName: "Inbox - Outlook",
          bounds: { x: 120, y: 40, width: 1180, height: 820, centerX: 710, centerY: 450 }
        }
      ]
    },
    capture: {
      id: "artifact-outlook-shortcut-truncated-thread",
      taskId: "task-outlook-shortcut-truncated-thread",
      traceId: null,
      kind: "screenshot",
      label: "Outlook thread without composer",
      path: threadCapturePath,
      metadata: {},
      createdAt: new Date().toISOString()
    },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Outlook\nRe: credibility guide for Tan\nCan I send it over?",
    recentActions: [],
    summary: "Microsoft Outlook thread",
    timestamp: new Date().toISOString()
  };
  const threadWithVisualComposer = {
    ...threadWithoutComposer,
    capture: {
      ...threadWithoutComposer.capture,
      id: "artifact-outlook-shortcut-truncated-compose",
      label: "Outlook thread with composer",
      path: composeCapturePath
    },
    visibleText: "Outlook\nRe: credibility guide for Tan\nInline reply editor\nSend"
  };
  const fakeSurface = {
    async observe() {
      return replyShortcutUsed ? threadWithVisualComposer : threadWithoutComposer;
    },
    async act({ step }: { step: RuntimeStep }) {
      actions.push(`${step.action}:${String(step.label ?? step.id ?? "")}`);
      if (step.action === "pressKey" && step.params?.key === "r") {
        replyShortcutUsed = true;
      }
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-shortcut-truncated",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-shortcut-truncated",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const context = await pack?.extractContext?.({
    rule,
    worldState: threadWithoutComposer as never,
    detection: {
      summary: "Jenna Fernandes",
      text: "Jenna Fernandes",
      context: ["credibility gu...", "Can I send it over?"],
      inputs: {
        openTarget: "Jenna Fernandes",
        openX: 312,
        openY: 418
      },
      metadata: {
        visualAnalysis: {
          scene: "thread",
          openThread: "Re: credibility guide for Tan"
        },
        visualThread: {
          subjectCue: "credibility gu...",
          latestSnippet: "Can I send it over?"
        }
      }
    } as never,
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }) => {
          if (schemaName === "agentos_outlook_reply_control") {
            return {
              present: false,
              evidence: "",
              label: "",
              approxBox: null
            };
          }
          if (schemaName === "agentos_outlook_desktop_visual") {
            return replyShortcutUsed
              ? {
                  scene: "thread",
                  sceneEvidence: "A thread is open and an inline reply editor is visible.",
                  recommendedRecoveryAction: "none",
                  recoveryControl: { present: false, evidence: "", approxBox: null },
                  openThread: "Re: credibility guide for Tan",
                  bestUnreadThread: {
                    present: false,
                    name: "",
                    evidence: "",
                    replyable: false,
                    conversationKind: "unknown",
                    shouldReply: false,
                    replyReason: "",
                    latestSnippet: "",
                    priority: "low",
                    subjectCue: "",
                    approxBox: null
                  },
                  composer: {
                    present: true,
                    evidence: "Inline reply editor",
                    hasDraftText: false,
                    draftPreview: null,
                    approxBox: { x: 0.42, y: 0.68, width: 0.36, height: 0.14 },
                    entryPoint: { x: 0.61, y: 0.74 }
                  },
                  targetThreadOpen: null,
                  prefillVisible: false
                }
              : {
                  scene: "thread",
                  sceneEvidence: "A thread is open in the reading pane but no reply composer is visible yet.",
                  recommendedRecoveryAction: "none",
                  recoveryControl: { present: false, evidence: "", approxBox: null },
                  openThread: "Re: credibility guide for Tan",
                  bestUnreadThread: {
                    present: false,
                    name: "",
                    evidence: "",
                    replyable: false,
                    conversationKind: "unknown",
                    shouldReply: false,
                    replyReason: "",
                    latestSnippet: "",
                    priority: "low",
                    subjectCue: "",
                    approxBox: null
                  },
                  composer: {
                    present: false,
                    evidence: "",
                    hasDraftText: null,
                    draftPreview: null,
                    approxBox: null,
                    entryPoint: null
                  },
                  targetThreadOpen: null,
                  prefillVisible: false
                };
          }
          throw new Error(`Unexpected schema ${schemaName}`);
        }
      }
    } as never
  });

  assert.equal(replyShortcutUsed, true);
  assert.equal(actions.some((action) => action.includes("Open mail thread")), false);
  assert.equal(context?.inputs?.threadVerifyTarget, "credibility guide for Tan");

  await fs.unlink(threadCapturePath).catch(() => {});
  await fs.unlink(composeCapturePath).catch(() => {});
});

test("outlook desktop pack treats a target unread row disappearing after selection as thread advancement", async () => {
  const threadCapturePath = `/tmp/outlook-shortcut-read-thread-${Date.now()}.png`;
  const composeCapturePath = `/tmp/outlook-shortcut-read-compose-${Date.now()}.png`;
  await fs.writeFile(threadCapturePath, createPngHeaderBuffer(1440, 900));
  await fs.writeFile(composeCapturePath, createPngHeaderBuffer(1440, 900));

  let replyShortcutUsed = false;
  let threadOpened = false;
  const fakeSurface = {
    async observe() {
      return replyShortcutUsed
        ? {
            version: 1,
            surface: "desktop",
            workspaceId: "workspace-outlook-shortcut-read",
            appContext: {
              appName: "Microsoft Outlook",
              windows: [
                {
                  ownerName: "Microsoft Outlook",
                  windowName: "Inbox - Outlook",
                  bounds: { x: 120, y: 40, width: 1180, height: 820, centerX: 710, centerY: 450 }
                }
              ]
            },
            capture: {
              id: "artifact-outlook-shortcut-read-compose",
              taskId: "task-outlook-shortcut-read-compose",
              traceId: null,
              kind: "screenshot",
              label: "Outlook thread with composer",
              path: composeCapturePath,
              metadata: {},
              createdAt: new Date().toISOString()
            },
            ocrBlocks: [],
            interactionCandidates: [],
            visibleText: "Outlook\nRe: For Payinone\nInline reply editor\nSend",
            recentActions: [],
            summary: "Microsoft Outlook thread with composer",
            timestamp: new Date().toISOString()
          }
        : {
            version: 1,
            surface: "desktop",
            workspaceId: "workspace-outlook-shortcut-read",
            appContext: {
              appName: "Microsoft Outlook",
              windows: [
                {
                  ownerName: "Microsoft Outlook",
                  windowName: "Inbox - Outlook",
                  bounds: { x: 120, y: 40, width: 1180, height: 820, centerX: 710, centerY: 450 }
                }
              ]
            },
            capture: {
              id: "artifact-outlook-shortcut-read-thread",
              taskId: "task-outlook-shortcut-read-thread",
              traceId: null,
              kind: "screenshot",
              label: "Outlook thread without composer",
              path: threadCapturePath,
              metadata: {},
              createdAt: new Date().toISOString()
            },
            ocrBlocks: [],
            interactionCandidates: [],
            visibleText: threadOpened
              ? "Outlook\nRe: For Payinone\nCurrent thread"
              : "Outlook\nUnread\nzhangbei",
            recentActions: [],
            summary: threadOpened ? "Microsoft Outlook thread" : "Microsoft Outlook unread list",
            timestamp: new Date().toISOString()
          };
    },
    async act({ step }: { step: RuntimeStep }) {
      if (String(step.label ?? "").includes("Open mail thread")) {
        threadOpened = true;
      }
      if (step.action === "pressKey" && step.params?.key === "r") {
        replyShortcutUsed = true;
      }
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-shortcut-read",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-shortcut-read",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const context = await pack?.extractContext?.({
    rule,
    worldState: {
      version: 1,
      surface: "desktop",
      workspaceId: "workspace-outlook-shortcut-read",
      appContext: {
        appName: "Microsoft Outlook",
        windows: [
          {
            ownerName: "Microsoft Outlook",
            windowName: "Inbox - Outlook",
            bounds: { x: 120, y: 40, width: 1180, height: 820, centerX: 710, centerY: 450 }
          }
        ]
      },
      capture: null,
      ocrBlocks: [],
      interactionCandidates: [],
      visibleText: "Outlook\nUnread\nzhangbei",
      recentActions: [],
      summary: "Microsoft Outlook unread list",
      timestamp: new Date().toISOString()
    } as never,
    detection: {
      summary: "zhangbei",
      text: "zhangbei",
      context: ["对接口代理...", "徐老师您好, 烦请先分..."],
      inputs: {
        openTarget: "zhangbei",
        openX: 413,
        openY: 370
      },
      metadata: {
        visualAnalysis: {
          scene: "thread",
          openThread: "For Payinone"
        },
        visualThread: {
          subjectCue: "对接口代理...",
          latestSnippet: "徐老师您好, 烦请先分..."
        },
        openCandidate: {
          id: "outlook-vision-unread",
          text: "zhangbei",
          role: "text",
          isInteractive: true,
          bounds: { x: 305, y: 348, width: 215, height: 44, centerX: 413, centerY: 370 }
        }
      }
    } as never,
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }) => {
          if (schemaName === "agentos_outlook_reply_control") {
            return {
              present: false,
              evidence: "",
              label: "",
              approxBox: null
            };
          }
          if (schemaName === "agentos_outlook_desktop_visual") {
            return replyShortcutUsed
              ? {
                  scene: "thread",
                  sceneEvidence: "A thread is open and an inline reply editor is visible.",
                  recommendedRecoveryAction: "none",
                  recoveryControl: { present: false, evidence: "", approxBox: null },
                  openThread: "Re: For Payinone",
                  bestUnreadThread: {
                    present: false,
                    name: "",
                    evidence: "",
                    replyable: false,
                    conversationKind: "unknown",
                    shouldReply: false,
                    replyReason: "",
                    latestSnippet: "",
                    priority: "low",
                    subjectCue: "",
                    approxBox: null
                  },
                  composer: {
                    present: true,
                    evidence: "Inline reply editor",
                    hasDraftText: false,
                    draftPreview: null,
                    approxBox: { x: 0.42, y: 0.68, width: 0.36, height: 0.14 },
                    entryPoint: { x: 0.61, y: 0.74 }
                  },
                  targetThreadOpen: null,
                  prefillVisible: false
                }
              : {
                  scene: "thread",
                  sceneEvidence: "A thread is open in the reading pane but no reply composer is visible yet.",
                  recommendedRecoveryAction: "none",
                  recoveryControl: { present: false, evidence: "", approxBox: null },
                  openThread: "Re: For Payinone",
                  bestUnreadThread: {
                    present: false,
                    name: "",
                    evidence: "",
                    replyable: false,
                    conversationKind: "unknown",
                    shouldReply: false,
                    replyReason: "",
                    latestSnippet: "",
                    priority: "low",
                    subjectCue: "",
                    approxBox: null
                  },
                  composer: {
                    present: false,
                    evidence: "",
                    hasDraftText: null,
                    draftPreview: null,
                    approxBox: null,
                    entryPoint: null
                  },
                  targetThreadOpen: null,
                  prefillVisible: false
                };
          }
          throw new Error(`Unexpected schema ${schemaName}`);
        }
      }
    } as never
  });

  assert.equal(replyShortcutUsed, true);
  assert.equal(context?.inputs?.threadVerifyTarget, "For Payinone");

  await fs.unlink(threadCapturePath).catch(() => {});
  await fs.unlink(composeCapturePath).catch(() => {});
});

test("outlook desktop pack treats a selected row that starts with the target sender as thread advancement", async () => {
  const threadCapturePath = `/tmp/outlook-selected-row-target-prefix-${Date.now()}.png`;
  const composeCapturePath = `/tmp/outlook-selected-row-target-prefix-compose-${Date.now()}.png`;
  await fs.writeFile(threadCapturePath, createPngHeaderBuffer(1440, 900));
  await fs.writeFile(composeCapturePath, createPngHeaderBuffer(1440, 900));

  let replyShortcutUsed = false;
  let openClicks = 0;

  const initialWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-selected-row-target-prefix",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowName: "Inbox - Outlook",
          bounds: { x: 120, y: 40, width: 1180, height: 820, centerX: 710, centerY: 450 }
        }
      ]
    },
    capture: null,
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Outlook\nUnread\n杜军奋",
    recentActions: [],
    summary: "Microsoft Outlook unread list",
    timestamp: new Date().toISOString()
  };
  const threadWithoutComposer = {
    ...initialWorldState,
    capture: {
      id: "artifact-outlook-selected-row-target-prefix",
      taskId: "task-outlook-selected-row-target-prefix",
      traceId: null,
      kind: "screenshot",
      label: "Outlook thread without composer",
      path: threadCapturePath,
      metadata: {},
      createdAt: new Date().toISOString()
    },
    visibleText: "Outlook\nAI 法务系统优化需求\n杜军奋 周报 (2.24-...\nReply"
  };
  const threadWithComposer = {
    ...threadWithoutComposer,
    capture: {
      ...threadWithoutComposer.capture,
      id: "artifact-outlook-selected-row-target-prefix-compose",
      label: "Outlook thread with composer",
      path: composeCapturePath
    },
    visibleText: "Outlook\n周报 (2.24-...)\nInline reply editor\nSend"
  };

  const fakeSurface = {
    async observe() {
      return replyShortcutUsed ? threadWithComposer : threadWithoutComposer;
    },
    async act({ step }) {
      if ((step.action === "clickTarget" || step.action === "clickAt") && String(step.label ?? "").includes("Open mail thread")) {
        openClicks += 1;
      }
      if (step.action === "pressKey" && step.params?.key === "r") {
        replyShortcutUsed = true;
      }
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-selected-row-target-prefix",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-selected-row-target-prefix",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const context = await pack?.extractContext?.({
    rule,
    worldState: initialWorldState as never,
    detection: {
      summary: "杜军奋",
      text: "杜军奋",
      context: ["周报 (2.24-...", "Dear LinTan, 本周周..."],
      inputs: {
        openTarget: "杜军奋",
        openX: 410,
        openY: 302
      },
      metadata: {
        visualAnalysis: {
          scene: "thread",
          openThread: "AI 法务系统优化需求: 审批详情页补充“提交结论”字段展示",
          selectedRow: "Jin Wang Re: AI 法务系统优化需求: 审批详情页补充“提交结论”字段展示"
        },
        visualThread: {
          subjectCue: "周报 (2.24-...",
          latestSnippet: "Dear LinTan, 本周周..."
        }
      }
    } as never,
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }) => {
          if (schemaName === "agentos_outlook_reply_control") {
            return {
              present: false,
              evidence: "",
              label: "",
              approxBox: null
            };
          }
          if (schemaName === "agentos_outlook_desktop_visual") {
            return replyShortcutUsed
              ? {
                  scene: "thread",
                  sceneEvidence: "A thread is open and an inline reply editor is visible.",
                  recommendedRecoveryAction: "none",
                  recoveryControl: { present: false, evidence: "", approxBox: null },
                  openThread: "周报 (2.24-...)",
                  selectedRow: "杜军奋 周报 (2.24-...)",
                  bestUnreadThread: {
                    present: false,
                    name: "",
                    evidence: "",
                    replyable: false,
                    conversationKind: "unknown",
                    shouldReply: false,
                    replyReason: "",
                    latestSnippet: "",
                    priority: "low",
                    subjectCue: "",
                    approxBox: null
                  },
                  composer: {
                    present: true,
                    evidence: "Inline reply editor",
                    hasDraftText: false,
                    draftPreview: null,
                    approxBox: { x: 0.42, y: 0.68, width: 0.36, height: 0.14 },
                    entryPoint: { x: 0.61, y: 0.74 }
                  },
                  targetThreadOpen: null,
                  prefillVisible: false
                }
              : {
                  scene: "thread",
                  sceneEvidence: "A thread is open in the reading pane but no reply composer is visible yet.",
                  recommendedRecoveryAction: "none",
                  recoveryControl: { present: false, evidence: "", approxBox: null },
                  openThread: "AI 法务系统优化需求: 审批详情页补充“提交结论”字段展示",
                  selectedRow: "杜军奋 周报 (2.24-...)",
                  bestUnreadThread: {
                    present: false,
                    name: "",
                    evidence: "",
                    replyable: false,
                    conversationKind: "unknown",
                    shouldReply: false,
                    replyReason: "",
                    latestSnippet: "",
                    priority: "low",
                    subjectCue: "",
                    approxBox: null
                  },
                  composer: {
                    present: false,
                    evidence: "",
                    hasDraftText: null,
                    draftPreview: null,
                    approxBox: null,
                    entryPoint: null
                  },
                  targetThreadOpen: null,
                  prefillVisible: false
                };
          }
          throw new Error(`Unexpected schema ${schemaName}`);
        }
      }
    } as never
  });

  assert.equal(openClicks, 1);
  assert.equal(replyShortcutUsed, true);
  assert.equal(context?.inputs?.threadVerifyTarget, "周报 (2.24-...)");

  await fs.unlink(threadCapturePath).catch(() => {});
  await fs.unlink(composeCapturePath).catch(() => {});
});

test("outlook desktop pack falls back to a body-safe composer point when the visual entry point sits in the header chrome", async () => {
  const composeCapturePath = `/tmp/outlook-compose-header-entry-${Date.now()}.png`;
  await fs.writeFile(composeCapturePath, createPngHeaderBuffer(1440, 900));

  const threadWithComposer = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-compose-header-entry",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowName: "Inbox - Outlook",
          bounds: { x: 120, y: 40, width: 1180, height: 820, centerX: 710, centerY: 450 }
        }
      ]
    },
    capture: {
      id: "artifact-outlook-compose-header-entry",
      taskId: "task-outlook-compose-header-entry",
      traceId: null,
      kind: "screenshot",
      label: "Outlook compose with bad entry point",
      path: composeCapturePath,
      metadata: {},
      createdAt: new Date().toISOString()
    },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Outlook\nRe: Project update\nSend",
    recentActions: [],
    summary: "Microsoft Outlook thread with compose",
    timestamp: new Date().toISOString()
  };
  const fakeSurface = {
    async observe() {
      return threadWithComposer;
    },
    async act() {
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-compose-header-entry",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
  const detection = {
    summary: "Project update",
    inputs: {
      openTarget: "Project update"
    },
    metadata: {
      openCandidate: {
        id: "candidate-project-update",
        surface: "desktop",
        kind: "text",
        text: "Project update",
        role: "row",
        bounds: { x: 300, y: 180, width: 240, height: 36, centerX: 420, centerY: 198 },
        confidence: 0.99,
        sourceHints: { source: "vision" },
        isInteractive: true
      }
    }
  };
  const workspace: WorkspaceProfile = {
    id: "profile-outlook-compose-header-entry",
    name: "outlook-desktop-main",
    rootPath: "/tmp",
    profilePath: "/tmp/profile",
    downloadsPath: "/tmp/downloads",
    artifactsPath: "/tmp/artifacts",
    scratchPath: "/tmp/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const context = await pack?.extractContext?.({
    rule,
    worldState: threadWithComposer as never,
    detection: detection as never,
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        async analyzeImageJson({ schemaName }: { schemaName: string }) {
          if (schemaName === "agentos_outlook_desktop_visual") {
            return {
              scene: "thread",
              sceneEvidence: "Reply composer is visible on the right.",
              recommendedRecoveryAction: "none",
              recoveryControl: { present: false, evidence: "", approxBox: null },
              openThread: "Re: Project update",
              bestUnreadThread: {
                present: false,
                name: "",
                evidence: "",
                replyable: false,
                conversationKind: "unknown",
                shouldReply: false,
                replyReason: "",
                latestSnippet: "",
                priority: "low",
                approxBox: null
              },
              composer: {
                present: true,
                evidence: "Inline reply editor",
                entryPoint: { x: 0.62, y: 0.17 },
                approxBox: { x: 0.38, y: 0.14, width: 0.56, height: 0.68 }
              },
              targetThreadOpen: true,
              prefillVisible: false
            };
          }
          throw new Error(`Unexpected schema ${schemaName}`);
        }
      }
    } as never
  });

  const composeTarget = (context?.inputs?.composeTarget ?? null) as {
    bounds?: { x?: number; y?: number; width?: number; height?: number; centerX?: number; centerY?: number };
  } | null;
  assert.equal(Math.round(Number(composeTarget?.bounds?.x ?? 0)), 621);
  assert.equal(Math.round(Number(composeTarget?.bounds?.y ?? 0)), 255);
  assert.ok(Number(composeTarget?.bounds?.width ?? 0) >= 340);
  assert.ok(Number(composeTarget?.bounds?.height ?? 0) >= 89);
  assert.equal(Math.round(Number(composeTarget?.bounds?.centerX ?? 0)), 669);
  assert.equal(Math.round(Number(composeTarget?.bounds?.centerY ?? 0)), 277);
  const verifyRegion = (context?.inputs?.composeVerifyRegion ?? null) as { y?: number; height?: number } | null;
  assert.ok(Number(verifyRegion?.y ?? 0) > 0.2);
  assert.ok(Number(verifyRegion?.height ?? 0) >= 0.08);

  await fs.unlink(composeCapturePath).catch(() => {});
});

test("outlook desktop pack recovers to a visible inbox row before scanning for unread mail", async () => {
  let recovered = false;
  const actions: string[] = [];
  let recoveryClick: { x: number; y: number } | null = null;
  const archiveWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-recover",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowName: "Archive - Outlook",
          bounds: { x: 120, y: 40, width: 1180, height: 820, centerX: 710, centerY: 450 }
        }
      ]
    },
    capture: { path: "/tmp/outlook-archive.png" },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Outlook\nArchive\nInbox 4\nGemini Hsieh",
    recentActions: [],
    summary: "Outlook archive list",
    timestamp: new Date().toISOString()
  };
  const inboxWorldState = {
    ...archiveWorldState,
    capture: { path: "/tmp/outlook-inbox.png" },
    visibleText: "Outlook\nInbox\nUnread\nGemini Hsieh",
    summary: "Outlook inbox list"
  };
  const fakeSurface = {
    async observe() {
      return recovered ? inboxWorldState : archiveWorldState;
    },
    async act({ step }: { step: RuntimeStep }) {
      actions.push(`${step.action}:${String(step.label ?? step.id ?? "")}`);
      if (step.action === "clickAt" && String(step.label ?? "").includes("Recover Outlook to inbox list")) {
        recoveryClick = {
          x: Number(step.params?.x ?? NaN),
          y: Number(step.params?.y ?? NaN)
        };
        recovered = true;
      }
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-recover-inbox",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-recover-inbox",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: archiveWorldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async () => {
          if (!recovered) {
            return {
              scene: "list",
              sceneEvidence: "Archive folder is selected while Inbox 4 is visible in the sidebar",
              recommendedRecoveryAction: "recover_to_list",
              recoveryControl: {
                present: true,
                evidence: "Inbox row with unread count",
                approxBox: { x: 136, y: 314, width: 80, height: 20 }
              },
              openThread: null,
              visibleUnreadThreads: [],
              composer: {
                present: false,
                evidence: "",
                approxBox: null
              }
            };
          }
          return {
            scene: "list",
            sceneEvidence: "Unread inbox row visible",
            recommendedRecoveryAction: "none",
            recoveryControl: {
              present: false,
              evidence: "",
              approxBox: null
            },
            openThread: null,
            visibleUnreadThreads: [
              {
                name: "Gemini Hsieh",
                evidence: "Bold unread sender row in Inbox",
                replyable: true,
                conversationKind: "mail",
                shouldReply: true,
                replyReason: "Unread direct email likely needs a response",
                latestSnippet: "Regulations",
                priority: "high",
                approxBox: { x: 0.18, y: 0.22, width: 0.28, height: 0.08 }
              }
            ],
            composer: {
              present: false,
              evidence: "",
              approxBox: null
            }
          };
        }
      }
    } as never
  });

  assert.equal(detection?.summary, "Gemini Hsieh");
  assert.equal((detection?.metadata as { recoveryAttempts?: unknown } | undefined)?.recoveryAttempts, 1);
  assert.equal(actions.includes("clickAt:Recover Outlook to inbox list"), true);
  assert.equal(Number.isFinite(Number(recoveryClick?.x ?? NaN)), true);
  assert.equal(Number.isFinite(Number(recoveryClick?.y ?? NaN)), true);
});

test("outlook desktop pack can recover an empty focused list via load more conversations before scanning unread mail", async () => {
  let recovered = false;
  const actions: string[] = [];
  const emptyListWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-recover-load-more",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowName: "Inbox - Outlook",
          bounds: { x: 80, y: 30, width: 1280, height: 860, centerX: 720, centerY: 460 }
        }
      ]
    },
    capture: { path: "/tmp/outlook-empty-focused.png" },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Outlook\nInbox\nFocused\nOther\nLoad more conversations",
    recentActions: [],
    summary: "Outlook inbox with empty focused list",
    timestamp: new Date().toISOString()
  };
  const loadedWorldState = {
    ...emptyListWorldState,
    capture: { path: "/tmp/outlook-loaded-list.png" },
    visibleText: "Outlook\nInbox\nUnread\nGemini Hsieh\nRegulations",
    summary: "Outlook inbox with unread row"
  };
  const fakeSurface = {
    async observe() {
      return recovered ? loadedWorldState : emptyListWorldState;
    },
    async act({ step }: { step: RuntimeStep }) {
      actions.push(`${step.action}:${String(step.label ?? step.id ?? "")}`);
      if (step.action === "clickAt" && String(step.label ?? "").includes("Recover Outlook to inbox list")) {
        recovered = true;
      }
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-recover-load-more",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-recover-load-more",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: emptyListWorldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async () => {
          if (!recovered) {
            return {
              scene: "list",
              sceneEvidence: "Focused list is empty while Load more conversations is visible",
              recommendedRecoveryAction: "recover_to_list",
              recoveryControl: {
                present: true,
                evidence: "Load more conversations would reveal more messages",
                approxBox: { x: 0.28, y: 0.18, width: 0.2, height: 0.04 }
              },
              openThread: null,
              visibleUnreadThreads: [],
              composer: {
                present: false,
                evidence: "",
                approxBox: null
              }
            };
          }
          return {
            scene: "list",
            sceneEvidence: "Unread inbox row visible after loading more conversations",
            recommendedRecoveryAction: "none",
            recoveryControl: {
              present: false,
              evidence: "",
              approxBox: null
            },
            openThread: null,
            visibleUnreadThreads: [
              {
                name: "Gemini Hsieh",
                evidence: "Bold unread sender row in Inbox",
                replyable: true,
                conversationKind: "mail",
                shouldReply: true,
                replyReason: "Unread direct email likely needs a response",
                latestSnippet: "Regulations",
                priority: "high",
                approxBox: { x: 0.19, y: 0.24, width: 0.27, height: 0.08 }
              }
            ],
            composer: {
              present: false,
              evidence: "",
              approxBox: null
            }
          };
        }
      }
    } as never
  });

  assert.equal(detection?.summary, "Gemini Hsieh");
  assert.equal((detection?.metadata as { recoveryAttempts?: unknown } | undefined)?.recoveryAttempts, 1);
  assert.equal(actions.includes("clickAt:Recover Outlook to inbox list"), true);
});

test("outlook desktop pack prefers a visible Inbox row over load more when the current folder is non-inbox", async () => {
  let recovered = false;
  const recoveryClicks: Array<{ x: number; y: number }> = [];
  const sentWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-recover-prioritize-inbox",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowName: "Sent - Outlook",
          bounds: { x: 80, y: 30, width: 1280, height: 860, centerX: 720, centerY: 460 }
        }
      ]
    },
    capture: { path: "/tmp/outlook-sent-load-more.png" },
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "folder-inbox-priority",
        surface: "desktop",
        kind: "text",
        text: "Inbox",
        role: "button",
        bounds: { x: 180, y: 260, width: 120, height: 28, centerX: 240, centerY: 274 },
        confidence: 0.9,
        sourceHints: { source: "ocr" },
        isInteractive: true
      }
    ],
    visibleText: "Outlook\nSent\nInbox\nDrafts\nLoad more conversations",
    recentActions: [],
    summary: "Outlook sent folder with visible inbox row and load more link",
    timestamp: new Date().toISOString()
  };
  const inboxWorldState = {
    ...sentWorldState,
    capture: { path: "/tmp/outlook-sent-recovered-inbox.png" },
    visibleText: "Outlook\nInbox\nUnread\nGemini Hsieh\nRegulations",
    summary: "Outlook inbox with unread row"
  };
  const fakeSurface = {
    async observe() {
      return recovered ? inboxWorldState : sentWorldState;
    },
    async act({ step }: { step: RuntimeStep }) {
      if (step.action === "clickAt" && String(step.label ?? "").includes("Recover Outlook to inbox list")) {
        recovered = true;
        recoveryClicks.push({
          x: Number(step.params?.x ?? NaN),
          y: Number(step.params?.y ?? NaN)
        });
      }
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-recover-prioritize-inbox",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-recover-prioritize-inbox",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: sentWorldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }: { schemaName?: string }) => {
          if (schemaName === "agentos_outlook_desktop_recovery_control") {
            return {
              present: true,
              evidence: "Load more conversations control is visible in the message list",
              approxBox: { x: 0.29, y: 0.18, width: 0.12, height: 0.03 }
            };
          }
          if (!recovered) {
            return {
              scene: "list",
              sceneEvidence: "Sent is selected while Inbox is visible and Load more conversations is on the list",
              recommendedRecoveryAction: "recover_to_list",
              recoveryControl: {
                present: true,
                evidence: "Inbox row in the sidebar is the correct recovery control",
                approxBox: { x: 0.07, y: 0.375, width: 0.12, height: 0.03 }
              },
              openThread: null,
              visibleUnreadThreads: [],
              composer: {
                present: false,
                evidence: "",
                approxBox: null
              }
            };
          }
          return {
            scene: "list",
            sceneEvidence: "Unread inbox row visible after recovering to Inbox",
            recommendedRecoveryAction: "none",
            recoveryControl: {
              present: false,
              evidence: "",
              approxBox: null
            },
            openThread: null,
            visibleUnreadThreads: [
              {
                name: "Gemini Hsieh",
                evidence: "Bold unread sender row in Inbox",
                replyable: true,
                conversationKind: "mail",
                shouldReply: true,
                replyReason: "Unread direct email likely needs a response",
                latestSnippet: "Regulations",
                priority: "high",
                approxBox: { x: 0.19, y: 0.24, width: 0.27, height: 0.08 }
              }
            ],
            composer: {
              present: false,
              evidence: "",
              approxBox: null
            }
          };
        }
      }
    } as never
  });

  assert.equal(detection?.summary, "Gemini Hsieh");
  assert.equal(recoveryClicks.length, 1);
  assert.equal(recoveryClicks[0]?.x, 240);
  assert.equal(recoveryClicks[0]?.y, 274);
});

test("outlook desktop pack offsets a visible Inbox recovery row into screen coordinates for window captures", async () => {
  let recovered = false;
  const recoveryClicks: Array<{ x: number; y: number }> = [];
  const tempDir = await createTempDir("outlook-recovery-offset-");
  const capturePath = `${tempDir}/outlook-sent-window.png`;
  await fs.writeFile(capturePath, createPngHeaderBuffer(1280, 860));

  const sentWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-recover-offset",
    appContext: {
      appName: "Microsoft Outlook",
      captureWindowNumber: 123,
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowName: "Sent - Outlook",
          bounds: { x: 80, y: 30, width: 1280, height: 860, centerX: 720, centerY: 460 }
        }
      ]
    },
    capture: { path: capturePath },
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "folder-inbox-offset",
        surface: "desktop",
        kind: "text",
        text: "Inbox",
        role: "button",
        bounds: { x: 180, y: 260, width: 120, height: 28, centerX: 240, centerY: 274 },
        confidence: 0.9,
        sourceHints: { source: "ocr" },
        isInteractive: true
      }
    ],
    visibleText: "Outlook\nSent\nInbox\nDrafts\nLoad more conversations",
    recentActions: [],
    summary: "Outlook sent folder with visible inbox row and load more link",
    timestamp: new Date().toISOString()
  };
  const inboxWorldState = {
    ...sentWorldState,
    capture: { path: `${tempDir}/outlook-recovered.png` },
    visibleText: "Outlook\nInbox\nUnread\nGemini Hsieh\nRegulations",
    summary: "Outlook inbox with unread row"
  };
  await fs.writeFile(String(inboxWorldState.capture.path), createPngHeaderBuffer(1280, 860));

  const fakeSurface = {
    async observe() {
      return recovered ? inboxWorldState : sentWorldState;
    },
    async act({ step }: { step: RuntimeStep }) {
      if (step.action === "clickAt" && String(step.label ?? "").includes("Recover Outlook to inbox list")) {
        recovered = true;
        recoveryClicks.push({
          x: Number(step.params?.x ?? NaN),
          y: Number(step.params?.y ?? NaN)
        });
      }
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-recover-offset",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-recover-offset",
    name: "outlook-desktop-main",
    rootPath: tempDir,
    profilePath: `${tempDir}/profile`,
    downloadsPath: `${tempDir}/downloads`,
    artifactsPath: `${tempDir}/artifacts`,
    scratchPath: `${tempDir}/scratch`,
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: sentWorldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async () => {
          if (!recovered) {
            return {
              scene: "list",
              sceneEvidence: "Sent is selected while Inbox is visible",
              recommendedRecoveryAction: "recover_to_list",
              recoveryControl: {
                present: true,
                evidence: "Inbox row in the sidebar is the correct recovery control",
                approxBox: { x: 0.07, y: 0.375, width: 0.12, height: 0.03 }
              },
              openThread: null,
              visibleUnreadThreads: [],
              composer: {
                present: false,
                evidence: "",
                approxBox: null
              }
            };
          }
          return {
            scene: "list",
            sceneEvidence: "Unread inbox row visible after recovering to Inbox",
            recommendedRecoveryAction: "none",
            recoveryControl: {
              present: false,
              evidence: "",
              approxBox: null
            },
            openThread: null,
            visibleUnreadThreads: [
              {
                name: "Gemini Hsieh",
                evidence: "Bold unread sender row in Inbox",
                replyable: true,
                conversationKind: "mail",
                shouldReply: true,
                replyReason: "Unread direct email likely needs a response",
                latestSnippet: "Regulations",
                priority: "high",
                approxBox: { x: 0.19, y: 0.24, width: 0.27, height: 0.08 }
              }
            ],
            composer: {
              present: false,
              evidence: "",
              approxBox: null
            }
          };
        }
      }
    } as never
  });

  assert.equal(detection?.summary, "Gemini Hsieh");
  assert.equal(recoveryClicks.length, 1);
  assert.equal(recoveryClicks[0]?.x, 320);
  assert.equal(recoveryClicks[0]?.y, 304);
});

test("outlook desktop pack maps recovery controls against the captured main window when a modal window is also visible", async () => {
  let modalDismissed = false;
  let recovered = false;
  const actions: string[] = [];
  const recoveryClicks: Array<{ x: number; y: number }> = [];
  const tempDir = await createTempDir("outlook-recovery-modal-window-");
  const capturePath = `${tempDir}/outlook-sent-with-modal.png`;
  await fs.writeFile(capturePath, createPngHeaderBuffer(1280, 860));

  const sentWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-recover-modal",
    appContext: {
      appName: "Microsoft Outlook",
      captureWindowNumber: 123,
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowName: "",
          windowNumber: 999,
          bounds: { x: 1055, y: 277, width: 450, height: 376, centerX: 1280, centerY: 465 }
        },
        {
          ownerName: "Microsoft Outlook",
          windowName: "Sent - Outlook",
          windowNumber: 123,
          bounds: { x: 80, y: 30, width: 1280, height: 860, centerX: 720, centerY: 460 }
        }
      ]
    },
    capture: { path: capturePath },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Outlook\nSent\nInbox\nDrafts\nLoad more conversations",
    recentActions: [],
    summary: "Outlook sent folder with modal and visible inbox row",
    timestamp: new Date().toISOString()
  };
  const sentWithoutModalWorldState = {
    ...sentWorldState,
    capture: { path: `${tempDir}/outlook-sent-no-modal.png` },
    appContext: {
      ...sentWorldState.appContext,
      windows: [sentWorldState.appContext.windows[1]]
    },
    summary: "Outlook sent folder without the blocking modal"
  };
  const inboxWorldState = {
    ...sentWithoutModalWorldState,
    capture: { path: `${tempDir}/outlook-recovered-modal.png` },
    visibleText: "Outlook\nInbox\nUnread\nGemini Hsieh\nRegulations",
    summary: "Outlook inbox with unread row after modal recovery"
  };
  await fs.writeFile(String(sentWithoutModalWorldState.capture.path), createPngHeaderBuffer(1280, 860));
  await fs.writeFile(String(inboxWorldState.capture.path), createPngHeaderBuffer(1280, 860));

  const fakeSurface = {
    async observe() {
      if (!modalDismissed) {
        return sentWorldState;
      }
      return recovered ? inboxWorldState : sentWithoutModalWorldState;
    },
    async act({ step }: { step: RuntimeStep }) {
      actions.push(`${step.action}:${String(step.label ?? step.id ?? "")}`);
      if (step.action === "clickAt" && String(step.label ?? "").includes("Dismiss Outlook foreign view")) {
        modalDismissed = true;
      }
      if (step.action === "clickAt" && String(step.label ?? "").includes("Recover Outlook to inbox list")) {
        recovered = true;
        recoveryClicks.push({
          x: Number(step.params?.x ?? NaN),
          y: Number(step.params?.y ?? NaN)
        });
      }
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-recover-modal",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-recover-modal",
    name: "outlook-desktop-main",
    rootPath: tempDir,
    profilePath: `${tempDir}/profile`,
    downloadsPath: `${tempDir}/downloads`,
    artifactsPath: `${tempDir}/artifacts`,
    scratchPath: `${tempDir}/scratch`,
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await pack?.detectNewItems?.({
    rule,
    worldState: sentWorldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }: { schemaName?: string }) => {
          if (schemaName === "agentos_desktop_modal_dismiss_control") {
            return {
              present: !modalDismissed,
              evidence: modalDismissed ? "" : "Cancel button is visible in the modal footer",
              approxBox: modalDismissed ? null : { x: 0.5, y: 0.68, width: 0.08, height: 0.04 }
            };
          }
          if (!modalDismissed) {
            return {
              scene: "foreign_view",
              sceneEvidence: "Blocking modal dialog is covering the Sent view",
              recommendedRecoveryAction: "recover_to_list",
              recoveryControl: { present: false, evidence: "", approxBox: null },
              openThread: null,
              bestUnreadThread: {
                present: false,
                name: "",
                evidence: "",
                replyable: false,
                conversationKind: "unknown",
                shouldReply: false,
                replyReason: "",
                latestSnippet: "",
                priority: "low",
                approxBox: null
              },
              composer: { present: false, evidence: "", approxBox: null }
            };
          }
          return {
            scene: recovered ? "list" : "list",
            sceneEvidence: recovered ? "Unread inbox row visible after recovering to Inbox" : "Sent is selected while Inbox is visible",
            recommendedRecoveryAction: recovered ? "none" : "recover_to_list",
            recoveryControl: recovered
              ? { present: false, evidence: "", approxBox: null }
              : {
                  present: true,
                  evidence: "Inbox row in the captured main Outlook window",
                  approxBox: { x: 0.07, y: 0.375, width: 0.12, height: 0.03 }
                },
            openThread: null,
            bestUnreadThread: recovered
              ? {
                  present: true,
                  name: "Gemini Hsieh",
                  evidence: "Bold unread sender row in Inbox",
                  replyable: true,
                  conversationKind: "mail",
                  shouldReply: true,
                  replyReason: "Unread direct email likely needs a response",
                  latestSnippet: "Regulations",
                  priority: "high",
                  approxBox: { x: 0.19, y: 0.24, width: 0.27, height: 0.08 }
                }
              : {
                  present: false,
                  name: "",
                  evidence: "",
                  replyable: false,
                  conversationKind: "unknown",
                  shouldReply: false,
                  replyReason: "",
                  latestSnippet: "",
                  priority: "low",
                  approxBox: null
                },
            composer: { present: false, evidence: "", approxBox: null }
          };
        }
      }
    } as never
  });

  assert.equal(actions.includes("clickAt:Dismiss Outlook foreign view"), true);
  assert.equal(recoveryClicks.length, 1);
  assert.ok(Math.abs(Number(recoveryClicks[0]?.x ?? NaN) - 246.4) < 1e-6);
  assert.ok(Math.abs(Number(recoveryClicks[0]?.y ?? NaN) - 365.4) < 1e-6);
});

test("outlook desktop pack can ground a recovery control when the initial scene lacks a recovery box", async () => {
  let recovered = false;
  const actions: string[] = [];
  const emptyListWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-ground-recovery",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowName: "Inbox - Outlook",
          bounds: { x: 80, y: 30, width: 1280, height: 860, centerX: 720, centerY: 460 }
        }
      ]
    },
    capture: { path: "/tmp/outlook-ground-recovery.png" },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Outlook\nInbox\nFocused\nOther\nLoad more conversations",
    recentActions: [],
    summary: "Outlook inbox with empty focused list",
    timestamp: new Date().toISOString()
  };
  const loadedWorldState = {
    ...emptyListWorldState,
    capture: { path: "/tmp/outlook-ground-recovery-loaded.png" },
    visibleText: "Outlook\nInbox\nUnread\nGemini Hsieh\nRegulations",
    summary: "Outlook inbox with unread row"
  };
  const fakeSurface = {
    async observe() {
      return recovered ? loadedWorldState : emptyListWorldState;
    },
    async act({ step }: { step: RuntimeStep }) {
      actions.push(`${step.action}:${String(step.label ?? step.id ?? "")}`);
      if (step.action === "clickAt" && String(step.label ?? "").includes("Recover Outlook to inbox list")) {
        recovered = true;
      }
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-ground-recovery",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-ground-recovery",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: emptyListWorldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }: { schemaName: string }) => {
          if (schemaName === "agentos_outlook_desktop_recovery_control") {
            return {
              present: true,
              evidence: "Load more conversations control is visible",
              approxBox: { x: 0.28, y: 0.18, width: 0.2, height: 0.04 }
            };
          }
          if (!recovered) {
            return {
              scene: "list",
              sceneEvidence: "Focused list is empty while Load more conversations is visible",
              recommendedRecoveryAction: "recover_to_list",
              recoveryControl: {
                present: false,
                evidence: "",
                approxBox: null
              },
              openThread: null,
              visibleUnreadThreads: [],
              composer: {
                present: false,
                evidence: "",
                approxBox: null
              }
            };
          }
          return {
            scene: "list",
            sceneEvidence: "Unread inbox row visible after loading more conversations",
            recommendedRecoveryAction: "none",
            recoveryControl: {
              present: false,
              evidence: "",
              approxBox: null
            },
            openThread: null,
            visibleUnreadThreads: [
              {
                name: "Gemini Hsieh",
                evidence: "Bold unread sender row in Inbox",
                replyable: true,
                conversationKind: "mail",
                shouldReply: true,
                replyReason: "Unread direct email likely needs a response",
                latestSnippet: "Regulations",
                priority: "high",
                approxBox: { x: 0.19, y: 0.24, width: 0.27, height: 0.08 }
              }
            ],
            composer: {
              present: false,
              evidence: "",
              approxBox: null
            }
          };
        }
      }
    } as never
  });

  assert.equal(detection?.summary, "Gemini Hsieh");
  assert.equal((detection?.metadata as { recoveryAttempts?: unknown } | undefined)?.recoveryAttempts, 1);
  assert.equal(actions.includes("clickAt:Recover Outlook to inbox list"), true);
});

test("outlook desktop pack dismisses a blocking modal before recovering to the inbox list", async () => {
  let modalDismissed = false;
  let recovered = false;
  const actions: string[] = [];
  const tempDir = await createTempDir("outlook-modal-recovery-");
  const modalCapturePath = `${tempDir}/outlook-modal-recovery.png`;
  const sentCapturePath = `${tempDir}/outlook-modal-recovery-sent.png`;
  const inboxCapturePath = `${tempDir}/outlook-modal-recovery-inbox.png`;
  await fs.writeFile(modalCapturePath, createPngHeaderBuffer(1512, 870));
  await fs.writeFile(sentCapturePath, createPngHeaderBuffer(1512, 870));
  await fs.writeFile(inboxCapturePath, createPngHeaderBuffer(1512, 870));
  const modalWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-modal-recovery",
    appContext: {
      appName: "Microsoft Outlook",
      captureWindowNumber: 101,
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowNumber: 101,
          windowName: "Sent • tan@xgenie.co",
          bounds: { x: 520, y: 30, width: 1512, height: 870, centerX: 1276, centerY: 465 }
        },
        {
          ownerName: "Microsoft Outlook",
          windowNumber: 202,
          windowName: "",
          bounds: { x: 1055, y: 277, width: 450, height: 376, centerX: 1280, centerY: 465 }
        }
      ]
    },
    capture: { path: modalCapturePath },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Outlook\nSent\nCancel\nInbox\nFocused",
    recentActions: [],
    summary: "Outlook Sent view with a blocking modal dialog",
    timestamp: new Date().toISOString()
  };
  const sentWorldState = {
    ...modalWorldState,
    appContext: {
      ...modalWorldState.appContext,
      windows: [modalWorldState.appContext.windows[0]]
    },
    capture: { path: sentCapturePath },
    visibleText: "Outlook\nSent\nInbox\nFocused",
    summary: "Outlook Sent view without the blocking modal"
  };
  const recoveredWorldState = {
    ...sentWorldState,
    capture: { path: inboxCapturePath },
    visibleText: "Outlook\nInbox\nUnread\nGemini Hsieh\nRegulations",
    summary: "Outlook inbox with unread row"
  };
  const fakeSurface = {
    async observe() {
      if (!modalDismissed) {
        return modalWorldState;
      }
      return recovered ? recoveredWorldState : sentWorldState;
    },
    async act({ step }: { step: RuntimeStep }) {
      actions.push(`${step.action}:${String(step.label ?? step.id ?? "")}`);
      if (step.action === "clickAt" && String(step.label ?? "").includes("Dismiss Outlook foreign view")) {
        modalDismissed = true;
      }
      if (step.action === "clickAt" && String(step.label ?? "").includes("Recover Outlook to inbox list")) {
        recovered = true;
      }
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-modal-recovery",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-modal-recovery",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: modalWorldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }: { schemaName?: string }) => {
          if (schemaName === "agentos_desktop_modal_dismiss_control") {
            return {
              present: true,
              evidence: "Cancel button is visible in the modal footer",
              approxBox: { x: 0.5, y: 0.68, width: 0.08, height: 0.04 }
            };
          }
          if (!modalDismissed) {
            return {
              scene: "foreign_view",
              sceneEvidence: "Blocking modal dialog is covering the Sent view",
              recommendedRecoveryAction: "recover_to_list",
              recoveryControl: {
                present: false,
                evidence: "",
                approxBox: null
              },
              openThread: null,
              bestUnreadThread: {
                present: false,
                name: "",
                evidence: "",
                replyable: false,
                conversationKind: "unknown",
                shouldReply: false,
                replyReason: "",
                latestSnippet: "",
                priority: "low",
                approxBox: null
              },
              composer: {
                present: false,
                evidence: "",
                approxBox: null
              }
            };
          }
          if (!recovered) {
            return {
              scene: "list",
              sceneEvidence: "Sent is selected while Inbox is visible",
              recommendedRecoveryAction: "recover_to_list",
              recoveryControl: {
                present: true,
                evidence: "Inbox row is visible in the sidebar",
                approxBox: { x: 0.07, y: 0.375, width: 0.12, height: 0.03 }
              },
              openThread: null,
              bestUnreadThread: {
                present: false,
                name: "",
                evidence: "",
                replyable: false,
                conversationKind: "unknown",
                shouldReply: false,
                replyReason: "",
                latestSnippet: "",
                priority: "low",
                approxBox: null
              },
              composer: {
                present: false,
                evidence: "",
                approxBox: null
              }
            };
          }
          return {
            scene: "list",
            sceneEvidence: "Unread inbox row visible after recovering to Inbox",
            recommendedRecoveryAction: "none",
            recoveryControl: {
              present: false,
              evidence: "",
              approxBox: null
            },
            openThread: null,
            bestUnreadThread: {
              present: true,
              name: "Gemini Hsieh",
              evidence: "Bold unread sender row in Inbox",
              replyable: true,
              conversationKind: "mail",
              shouldReply: true,
              replyReason: "Unread direct email likely needs a response",
              latestSnippet: "Regulations",
              priority: "high",
              approxBox: { x: 0.19, y: 0.24, width: 0.27, height: 0.08 }
            },
            composer: {
              present: false,
              evidence: "",
              approxBox: null
            }
          };
        }
      }
    } as never
  });

  assert.equal(detection?.summary, "Gemini Hsieh");
  assert.equal(actions.includes("clickAt:Dismiss Outlook foreign view"), true);
  assert.equal(actions.includes("clickAt:Recover Outlook to inbox list"), true);
});

test("outlook desktop pack prefers a dedicated modal capture when grounding the dismiss control", async () => {
  let modalDismissed = false;
  let recovered = false;
  const dismissClicks: Array<{ x: number; y: number }> = [];
  const dismissImagePaths: string[] = [];
  const tempDir = await createTempDir("outlook-modal-capture-");
  const mainCapturePath = `${tempDir}/outlook-main-with-modal.png`;
  const modalCapturePath = `${tempDir}/outlook-modal-only.png`;
  const sentCapturePath = `${tempDir}/outlook-main-sent.png`;
  const inboxCapturePath = `${tempDir}/outlook-main-inbox.png`;
  await fs.writeFile(mainCapturePath, createPngHeaderBuffer(1280, 860));
  await fs.writeFile(modalCapturePath, createPngHeaderBuffer(450, 376));
  await fs.writeFile(sentCapturePath, createPngHeaderBuffer(1280, 860));
  await fs.writeFile(inboxCapturePath, createPngHeaderBuffer(1280, 860));

  const modalWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-modal-capture",
    appContext: {
      appName: "Microsoft Outlook",
      captureWindowNumber: 101,
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowNumber: 101,
          windowName: "Sent • tan@xgenie.co",
          bounds: { x: 520, y: 30, width: 1512, height: 870, centerX: 1276, centerY: 465 }
        },
        {
          ownerName: "Microsoft Outlook",
          windowNumber: 202,
          windowName: "",
          bounds: { x: 1055, y: 277, width: 450, height: 376, centerX: 1280, centerY: 465 }
        }
      ]
    },
    capture: { path: mainCapturePath },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Outlook\nSent\nCancel\nInbox\nFocused",
    recentActions: [],
    summary: "Outlook Sent view with a blocking modal dialog",
    timestamp: new Date().toISOString()
  };
  const sentWorldState = {
    ...modalWorldState,
    appContext: {
      ...modalWorldState.appContext,
      windows: [modalWorldState.appContext.windows[0]]
    },
    capture: { path: sentCapturePath },
    visibleText: "Outlook\nSent\nInbox\nFocused",
    summary: "Outlook Sent view without the blocking modal"
  };
  const recoveredWorldState = {
    ...sentWorldState,
    capture: { path: inboxCapturePath },
    visibleText: "Outlook\nInbox\nUnread\nGemini Hsieh\nRegulations",
    summary: "Outlook inbox with unread row"
  };

  const fakeSurface = {
    async observe() {
      if (!modalDismissed) {
        return modalWorldState;
      }
      return recovered ? recoveredWorldState : sentWorldState;
    },
    async capture({ windowNumber }: { windowNumber?: number }) {
      if (Number(windowNumber) === 202) {
        return {
          path: modalCapturePath,
          metadata: { windowNumber: 202 }
        };
      }
      return {
        path: mainCapturePath,
        metadata: { windowNumber: 101 }
      };
    },
    async act({ step }: { step: RuntimeStep }) {
      if (step.action === "clickAt" && String(step.label ?? "").includes("Dismiss Outlook foreign view")) {
        modalDismissed = true;
        dismissClicks.push({
          x: Number(step.params?.x ?? NaN),
          y: Number(step.params?.y ?? NaN)
        });
      }
      if (step.action === "clickAt" && String(step.label ?? "").includes("Recover Outlook to inbox list")) {
        recovered = true;
      }
      return { ok: true };
    }
  };

  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-modal-capture",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-modal-capture",
    name: "outlook-desktop-main",
    rootPath: tempDir,
    profilePath: `${tempDir}/profile`,
    downloadsPath: `${tempDir}/downloads`,
    artifactsPath: `${tempDir}/artifacts`,
    scratchPath: `${tempDir}/scratch`,
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: modalWorldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName, imagePath }: { schemaName?: string; imagePath?: string }) => {
          if (schemaName === "agentos_desktop_modal_dismiss_control") {
            dismissImagePaths.push(String(imagePath ?? ""));
            return {
              present: true,
              evidence: "Cancel button is visible in the modal footer",
              approxBox: { x: 0.5, y: 0.86, width: 0.18, height: 0.09 }
            };
          }
          if (!modalDismissed) {
            return {
              scene: "foreign_view",
              sceneEvidence: "Blocking modal dialog is covering the Sent view",
              recommendedRecoveryAction: "recover_to_list",
              recoveryControl: { present: false, evidence: "", approxBox: null },
              openThread: null,
              bestUnreadThread: {
                present: false,
                name: "",
                evidence: "",
                replyable: false,
                conversationKind: "unknown",
                shouldReply: false,
                replyReason: "",
                latestSnippet: "",
                priority: "low",
                approxBox: null
              },
              composer: { present: false, evidence: "", approxBox: null }
            };
          }
          if (!recovered) {
            return {
              scene: "list",
              sceneEvidence: "Sent is selected while Inbox is visible",
              recommendedRecoveryAction: "recover_to_list",
              recoveryControl: {
                present: true,
                evidence: "Inbox row is visible in the sidebar",
                approxBox: { x: 0.07, y: 0.375, width: 0.12, height: 0.03 }
              },
              openThread: null,
              bestUnreadThread: {
                present: false,
                name: "",
                evidence: "",
                replyable: false,
                conversationKind: "unknown",
                shouldReply: false,
                replyReason: "",
                latestSnippet: "",
                priority: "low",
                approxBox: null
              },
              composer: { present: false, evidence: "", approxBox: null }
            };
          }
          return {
            scene: "list",
            sceneEvidence: "Unread inbox row visible after recovering to Inbox",
            recommendedRecoveryAction: "none",
            recoveryControl: { present: false, evidence: "", approxBox: null },
            openThread: null,
            bestUnreadThread: {
              present: true,
              name: "Gemini Hsieh",
              evidence: "Bold unread sender row in Inbox",
              replyable: true,
              conversationKind: "mail",
              shouldReply: true,
              replyReason: "Unread direct email likely needs a response",
              latestSnippet: "Regulations",
              priority: "high",
              approxBox: { x: 0.19, y: 0.24, width: 0.27, height: 0.08 }
            },
            composer: { present: false, evidence: "", approxBox: null }
          };
        }
      }
    } as never
  });

  assert.equal(detection?.summary, "Gemini Hsieh");
  assert.deepEqual(dismissImagePaths, [modalCapturePath]);
  assert.equal(dismissClicks.length, 1);
  assert.ok(Math.abs(Number(dismissClicks[0]?.x ?? NaN) - 1320.5) < 1e-6);
  assert.ok(Math.abs(Number(dismissClicks[0]?.y ?? NaN) - 617.28) < 1e-6);
});

test("outlook desktop pack falls back to main-window grounding when a modal capture is still full-window sized", async () => {
  let modalDismissed = false;
  let recovered = false;
  const dismissClicks: Array<{ x: number; y: number }> = [];
  const dismissImagePaths: string[] = [];
  const tempDir = await createTempDir("outlook-modal-full-window-");
  const mainCapturePath = `${tempDir}/outlook-main-with-modal.png`;
  const modalCapturePath = `${tempDir}/outlook-modal-window-number-but-main-sized.png`;
  const sentCapturePath = `${tempDir}/outlook-main-sent.png`;
  const inboxCapturePath = `${tempDir}/outlook-main-inbox.png`;
  await fs.writeFile(mainCapturePath, createPngHeaderBuffer(3024, 1740));
  await fs.writeFile(modalCapturePath, createPngHeaderBuffer(3024, 1740));
  await fs.writeFile(sentCapturePath, createPngHeaderBuffer(3024, 1740));
  await fs.writeFile(inboxCapturePath, createPngHeaderBuffer(3024, 1740));

  const modalWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-modal-full-window",
    appContext: {
      appName: "Microsoft Outlook",
      captureWindowNumber: 101,
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowNumber: 101,
          windowName: "Sent • tan@xgenie.co",
          bounds: { x: 524, y: 30, width: 1512, height: 870, centerX: 1280, centerY: 465 }
        },
        {
          ownerName: "Microsoft Outlook",
          windowNumber: 202,
          windowName: "",
          bounds: { x: 1055, y: 277, width: 450, height: 376, centerX: 1280, centerY: 465 }
        }
      ]
    },
    capture: { path: mainCapturePath },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Outlook\nSent\nCancel\nInbox\nFocused",
    recentActions: [],
    summary: "Outlook Sent view with a blocking modal dialog",
    timestamp: new Date().toISOString()
  };
  const sentWorldState = {
    ...modalWorldState,
    appContext: {
      ...modalWorldState.appContext,
      windows: [modalWorldState.appContext.windows[0]]
    },
    capture: { path: sentCapturePath },
    visibleText: "Outlook\nSent\nInbox\nFocused",
    summary: "Outlook Sent view without the blocking modal"
  };
  const recoveredWorldState = {
    ...sentWorldState,
    capture: { path: inboxCapturePath },
    visibleText: "Outlook\nInbox\nUnread\nGemini Hsieh\nRegulations",
    summary: "Outlook inbox with unread row"
  };

  const fakeSurface = {
    async observe() {
      if (!modalDismissed) {
        return modalWorldState;
      }
      return recovered ? recoveredWorldState : sentWorldState;
    },
    async capture({ windowNumber }: { windowNumber?: number }) {
      if (Number(windowNumber) === 202) {
        return {
          path: modalCapturePath,
          metadata: { windowNumber: 202 }
        };
      }
      return {
        path: mainCapturePath,
        metadata: { windowNumber: 101 }
      };
    },
    async act({ step }: { step: RuntimeStep }) {
      if (step.action === "clickAt" && String(step.label ?? "").includes("Dismiss Outlook foreign view")) {
        modalDismissed = true;
        dismissClicks.push({
          x: Number(step.params?.x ?? NaN),
          y: Number(step.params?.y ?? NaN)
        });
      }
      if (step.action === "clickAt" && String(step.label ?? "").includes("Recover Outlook to inbox list")) {
        recovered = true;
      }
      return { ok: true };
    }
  };

  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-modal-full-window",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-modal-full-window",
    name: "outlook-desktop-main",
    rootPath: tempDir,
    profilePath: `${tempDir}/profile`,
    downloadsPath: `${tempDir}/downloads`,
    artifactsPath: `${tempDir}/artifacts`,
    scratchPath: `${tempDir}/scratch`,
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: modalWorldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName, imagePath }: { schemaName?: string; imagePath?: string }) => {
          if (schemaName === "agentos_desktop_modal_dismiss_control") {
            dismissImagePaths.push(String(imagePath ?? ""));
            return {
              present: true,
              evidence: "Cancel button is visible in the modal footer",
              approxBox: { x: 0.52, y: 0.665, width: 0.05, height: 0.03 }
            };
          }
          if (!modalDismissed) {
            return {
              scene: "foreign_view",
              sceneEvidence: "Blocking modal dialog is covering the Sent view",
              recommendedRecoveryAction: "recover_to_list",
              recoveryControl: { present: false, evidence: "", approxBox: null },
              openThread: null,
              bestUnreadThread: {
                present: false,
                name: "",
                evidence: "",
                replyable: false,
                conversationKind: "unknown",
                shouldReply: false,
                replyReason: "",
                latestSnippet: "",
                priority: "low",
                approxBox: null
              },
              composer: { present: false, evidence: "", approxBox: null }
            };
          }
          if (!recovered) {
            return {
              scene: "list",
              sceneEvidence: "Sent is selected while Inbox is visible",
              recommendedRecoveryAction: "recover_to_list",
              recoveryControl: {
                present: true,
                evidence: "Inbox row is visible in the sidebar",
                approxBox: { x: 0.07, y: 0.375, width: 0.12, height: 0.03 }
              },
              openThread: null,
              bestUnreadThread: {
                present: false,
                name: "",
                evidence: "",
                replyable: false,
                conversationKind: "unknown",
                shouldReply: false,
                replyReason: "",
                latestSnippet: "",
                priority: "low",
                approxBox: null
              },
              composer: { present: false, evidence: "", approxBox: null }
            };
          }
          return {
            scene: "list",
            sceneEvidence: "Unread inbox row visible after recovering to Inbox",
            recommendedRecoveryAction: "none",
            recoveryControl: { present: false, evidence: "", approxBox: null },
            openThread: null,
            bestUnreadThread: {
              present: true,
              name: "Gemini Hsieh",
              evidence: "Bold unread sender row in Inbox",
              replyable: true,
              conversationKind: "mail",
              shouldReply: true,
              replyReason: "Unread direct email likely needs a response",
              latestSnippet: "Regulations",
              priority: "high",
              approxBox: { x: 0.19, y: 0.24, width: 0.27, height: 0.08 }
            },
            composer: { present: false, evidence: "", approxBox: null }
          };
        }
      }
    } as never
  });

  assert.equal(detection?.summary, "Gemini Hsieh");
  assert.deepEqual(dismissImagePaths, [modalCapturePath]);
  assert.equal(dismissClicks.length, 1);
  assert.ok(Math.abs(Number(dismissClicks[0]?.x ?? NaN) - 1348.04) < 1e-6);
  assert.ok(Math.abs(Number(dismissClicks[0]?.y ?? NaN) - 621.6) < 1e-6);
});

test("outlook desktop pack can fall back to a visible Inbox row when recovery grounding returns no box", async () => {
  let recovered = false;
  const recoveryClicks: Array<{ x: number; y: number }> = [];
  const folderWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-inbox-recovery",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowName: "Inbox - Outlook",
          bounds: { x: 80, y: 30, width: 1280, height: 860, centerX: 720, centerY: 460 }
        }
      ]
    },
    capture: { path: "/tmp/outlook-folder-recovery.png" },
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "folder-deleted",
        surface: "desktop",
        kind: "text",
        text: "Deleted Items",
        role: "button",
        bounds: { x: 180, y: 210, width: 180, height: 28, centerX: 270, centerY: 224 },
        confidence: 0.9,
        sourceHints: { source: "ocr" },
        isInteractive: true
      },
      {
        id: "folder-inbox",
        surface: "desktop",
        kind: "text",
        text: "Inbox",
        role: "button",
        bounds: { x: 180, y: 640, width: 120, height: 28, centerX: 240, centerY: 654 },
        confidence: 0.9,
        sourceHints: { source: "ocr" },
        isInteractive: true
      }
    ],
    visibleText: "Outlook\nDeleted Items\nJunk Email\ntan@xgenie.co\nInbox\nDrafts\nSent",
    recentActions: [],
    summary: "Outlook showing a non-Inbox folder while Inbox is visible",
    timestamp: new Date().toISOString()
  };
  const loadedWorldState = {
    ...folderWorldState,
    capture: { path: "/tmp/outlook-folder-recovery-loaded.png" },
    visibleText: "Outlook\nInbox\nUnread\nGemini Hsieh\nRegulations",
    summary: "Outlook inbox with unread row"
  };
  const fakeSurface = {
    async observe() {
      return recovered ? loadedWorldState : folderWorldState;
    },
    async act({ step }: { step: RuntimeStep }) {
      if (step.action === "clickAt" && String(step.label ?? "").includes("Recover Outlook to inbox list")) {
        recovered = true;
        recoveryClicks.push({
          x: Number(step.params?.x ?? NaN),
          y: Number(step.params?.y ?? NaN)
        });
      }
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-inbox-recovery",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-inbox-recovery",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: folderWorldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }: { schemaName?: string }) => {
          if (!recovered) {
            if (schemaName === "agentos_outlook_desktop_recovery_control") {
              return {
                present: false,
                evidence: "No grounded control returned",
                approxBox: null
              };
            }
            return {
              scene: "list",
              sceneEvidence: "Deleted Items is visible while Inbox is also visible in the sidebar",
              recommendedRecoveryAction: "recover_to_list",
              recoveryControl: {
                present: false,
                evidence: "",
                approxBox: null
              },
              openThread: null,
              visibleUnreadThreads: [],
              composer: {
                present: false,
                evidence: "",
                approxBox: null
              }
            };
          }
          return {
            scene: "list",
            sceneEvidence: "Unread inbox row visible after recovering to Inbox",
            recommendedRecoveryAction: "none",
            recoveryControl: {
              present: false,
              evidence: "",
              approxBox: null
            },
            openThread: null,
            visibleUnreadThreads: [
              {
                name: "Gemini Hsieh",
                evidence: "Bold unread sender row in Inbox",
                replyable: true,
                conversationKind: "mail",
                shouldReply: true,
                replyReason: "Unread direct email likely needs a response",
                latestSnippet: "Regulations",
                priority: "high",
                approxBox: { x: 0.19, y: 0.24, width: 0.27, height: 0.08 }
              }
            ],
            composer: {
              present: false,
              evidence: "",
              approxBox: null
            }
          };
        }
      }
    } as never
  });

  assert.equal(detection?.summary, "Gemini Hsieh");
  assert.equal(recoveryClicks.length, 1);
  assert.deepEqual(recoveryClicks[0], { x: 240, y: 654 });
});

test("outlook desktop pack can fall back to an OCR Inbox row when recovery grounding returns no box", async () => {
  let recovered = false;
  const recoveryClicks: Array<{ x: number; y: number }> = [];
  await fs.writeFile("/tmp/outlook-folder-recovery-ocr.png", createPngHeaderBuffer(3024, 1740));
  const folderWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-inbox-recovery-ocr",
    appContext: {
      appName: "Microsoft Outlook",
      captureWindowNumber: 101,
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowNumber: 101,
          windowName: "Inbox - Outlook",
          bounds: { x: 524, y: 30, width: 1512, height: 870, centerX: 1280, centerY: 465 }
        }
      ]
    },
    capture: { path: "/tmp/outlook-folder-recovery-ocr.png" },
    ocrBlocks: [
      {
        id: "ocr-deleted-items",
        text: "Deleted Items",
        bounds: { x: 250, y: 206, width: 158, height: 22, centerX: 329, centerY: 217 },
        confidence: 0.9,
        source: "ocr"
      },
      {
        id: "ocr-inbox",
        text: "Inbox",
        bounds: { x: 237, y: 641, width: 79, height: 22, centerX: 276.5, centerY: 652 },
        confidence: 0.94,
        source: "ocr"
      }
    ],
    interactionCandidates: [],
    visibleText: "Outlook\nDeleted Items\nJunk Email\ntan@xgenie.co\nInbox\nDrafts\nSent",
    recentActions: [],
    summary: "Outlook showing a non-Inbox folder while Inbox is visible via OCR",
    timestamp: new Date().toISOString()
  };
  const loadedWorldState = {
    ...folderWorldState,
    capture: { path: "/tmp/outlook-folder-recovery-ocr-loaded.png" },
    visibleText: "Outlook\nInbox\nUnread\nGemini Hsieh\nRegulations",
    summary: "Outlook inbox with unread row"
  };
  const fakeSurface = {
    async observe() {
      return recovered ? loadedWorldState : folderWorldState;
    },
    async act({ step }: { step: RuntimeStep }) {
      if (step.action === "clickAt" && String(step.label ?? "").includes("Recover Outlook to inbox list")) {
        recovered = true;
        recoveryClicks.push({
          x: Number(step.params?.x ?? NaN),
          y: Number(step.params?.y ?? NaN)
        });
      }
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-inbox-recovery-ocr",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-inbox-recovery-ocr",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: folderWorldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }: { schemaName?: string }) => {
          if (!recovered) {
            if (schemaName === "agentos_outlook_desktop_recovery_control") {
              return {
                present: false,
                evidence: "No grounded control returned",
                approxBox: null
              };
            }
            return {
              scene: "list",
              sceneEvidence: "Deleted Items is visible while Inbox is also visible in the sidebar",
              recommendedRecoveryAction: "recover_to_list",
              recoveryControl: {
                present: false,
                evidence: "",
                approxBox: null
              },
              openThread: null,
              visibleUnreadThreads: [],
              composer: {
                present: false,
                evidence: "",
                approxBox: null
              }
            };
          }
          return {
            scene: "list",
            sceneEvidence: "Unread inbox row visible after recovering to Inbox",
            recommendedRecoveryAction: "none",
            recoveryControl: {
              present: false,
              evidence: "",
              approxBox: null
            },
            openThread: null,
            visibleUnreadThreads: [
              {
                name: "Gemini Hsieh",
                evidence: "Bold unread sender row in Inbox",
                replyable: true,
                conversationKind: "mail",
                shouldReply: true,
                replyReason: "Unread direct email likely needs a response",
                latestSnippet: "Regulations",
                priority: "high",
                approxBox: { x: 0.19, y: 0.24, width: 0.27, height: 0.08 }
              }
            ],
            composer: {
              present: false,
              evidence: "",
              approxBox: null
            }
          };
        }
      }
    } as never
  });

  assert.equal(detection?.summary, "Gemini Hsieh");
  assert.equal(recoveryClicks.length, 1);
  assert.deepEqual(recoveryClicks[0], { x: 662.25, y: 356 });
});

test("outlook desktop pack retries Inbox recovery when the first click leaves the view unchanged", async () => {
  let recoveryClicks = 0;
  const recoveryPoints: Array<{ x: number; y: number }> = [];
  const folderWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-inbox-recovery-retry",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowName: "Inbox - Outlook",
          bounds: { x: 80, y: 30, width: 1280, height: 860, centerX: 720, centerY: 460 }
        }
      ]
    },
    capture: { path: "/tmp/outlook-folder-recovery-retry.png" },
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "folder-deleted",
        surface: "desktop",
        kind: "text",
        text: "Deleted Items",
        role: "button",
        bounds: { x: 180, y: 210, width: 180, height: 28, centerX: 270, centerY: 224 },
        confidence: 0.9,
        sourceHints: { source: "ocr" },
        isInteractive: true
      },
      {
        id: "folder-inbox",
        surface: "desktop",
        kind: "text",
        text: "Inbox",
        role: "button",
        bounds: { x: 180, y: 640, width: 120, height: 28, centerX: 240, centerY: 654 },
        confidence: 0.9,
        sourceHints: { source: "ocr" },
        isInteractive: true
      }
    ],
    visibleText: "Outlook\nDeleted Items\nJunk Email\ntan@xgenie.co\nInbox\nDrafts\nSent",
    recentActions: [],
    summary: "Outlook showing a non-Inbox folder while Inbox is visible",
    timestamp: new Date().toISOString()
  };
  const loadedWorldState = {
    ...folderWorldState,
    capture: { path: "/tmp/outlook-folder-recovery-retry-loaded.png" },
    visibleText: "Outlook\nInbox\nUnread\nGemini Hsieh\nRegulations",
    summary: "Outlook inbox with unread row"
  };
  const fakeSurface = {
    async observe() {
      return recoveryClicks >= 2 ? loadedWorldState : folderWorldState;
    },
    async act({ step }: { step: RuntimeStep }) {
      if (step.action === "clickAt" && String(step.label ?? "").includes("Recover Outlook to inbox list")) {
        recoveryClicks += 1;
        recoveryPoints.push({
          x: Number(step.params?.x ?? NaN),
          y: Number(step.params?.y ?? NaN)
        });
      }
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-inbox-recovery-retry",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-inbox-recovery-retry",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: folderWorldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async () => {
          if (recoveryClicks >= 2) {
            return {
              scene: "list",
              sceneEvidence: "Unread inbox row visible after recovering to Inbox",
              recommendedRecoveryAction: "none",
              recoveryControl: {
                present: false,
                evidence: "",
                approxBox: null
              },
              openThread: null,
              visibleUnreadThreads: [
                {
                  name: "Gemini Hsieh",
                  evidence: "Bold unread sender row in Inbox",
                  replyable: true,
                  conversationKind: "mail",
                  shouldReply: true,
                  replyReason: "Unread direct email likely needs a response",
                  latestSnippet: "Regulations",
                  priority: "high",
                  approxBox: { x: 0.19, y: 0.24, width: 0.27, height: 0.08 }
                }
              ],
              composer: {
                present: false,
                evidence: "",
                approxBox: null
              }
            };
          }
          return {
            scene: "list",
            sceneEvidence: "Deleted Items is visible while Inbox is also visible in the sidebar",
            recommendedRecoveryAction: "recover_to_list",
            recoveryControl: {
              present: false,
              evidence: "",
              approxBox: null
            },
            openThread: null,
            visibleUnreadThreads: [],
            composer: {
              present: false,
              evidence: "",
              approxBox: null
            }
          };
        }
      }
    } as never
  });

  assert.equal(detection?.summary, "Gemini Hsieh");
  assert.equal(recoveryClicks, 2);
  assert.deepEqual(recoveryPoints, [
    { x: 240, y: 654 },
    { x: 240, y: 654 }
  ]);
});

test("outlook desktop pack can recover to Inbox when vision times out but an Inbox row is visible", async () => {
  let recovered = false;
  const recoveryClicks: Array<{ x: number; y: number }> = [];
  const sidebarWorldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-inbox-vision-timeout",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowName: "Inbox - Outlook",
          bounds: { x: 80, y: 30, width: 1280, height: 860, centerX: 720, centerY: 460 }
        }
      ]
    },
    capture: { path: "/tmp/outlook-inbox-vision-timeout-sidebar.png" },
    ocrBlocks: [
      {
        id: "ocr-inbox",
        text: "Inbox",
        bounds: { x: 246, y: 507, width: 75, height: 22, centerX: 283.5, centerY: 518 },
        confidence: 0.94,
        source: "ocr"
      }
    ],
    interactionCandidates: [],
    visibleText: "Outlook\nNew Mail\nFavorites\nAll Accounts\ntan.lin@pioinc.com\nInbox\nDrafts",
    recentActions: [],
    summary: "Outlook sidebar view with Inbox visible but no message list",
    timestamp: new Date().toISOString()
  };
  const inboxWorldState = {
    ...sidebarWorldState,
    capture: { path: "/tmp/outlook-inbox-vision-timeout-list.png" },
    visibleText: "Outlook\nInbox\nUnread\nAlice - Need your review\nCan you review this draft today?",
    summary: "Outlook inbox list after recovery"
  };
  const fakeSurface = {
    async observe() {
      return recovered ? inboxWorldState : sidebarWorldState;
    },
    async act({ step }: { step: RuntimeStep }) {
      if (step.action === "clickAt" && String(step.label ?? "").includes("Recover Outlook to inbox list")) {
        recovered = true;
        recoveryClicks.push({
          x: Number(step.params?.x ?? NaN),
          y: Number(step.params?.y ?? NaN)
        });
      }
      return { ok: true };
    }
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      desktop: fakeSurface as never
    })
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-inbox-vision-timeout",
    goal: "Always watch Outlook and prefill replies",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-inbox-vision-timeout",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: sidebarWorldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async () => {
          if (!recovered) {
            throw new Error("Outlook desktop vision analysis timed out after 12000ms");
          }
          return {
            scene: "list",
            sceneEvidence: "Unread inbox row visible after clicking Inbox",
            recommendedRecoveryAction: "none",
            recoveryControl: {
              present: false,
              evidence: "",
              approxBox: null
            },
            openThread: null,
            visibleUnreadThreads: [
              {
                name: "Alice - Need your review",
                evidence: "Unread bold sender row in Inbox",
                replyable: true,
                conversationKind: "mail",
                shouldReply: true,
                replyReason: "Unread direct email likely needs a response",
                latestSnippet: "Can you review this draft today?",
                priority: "high",
                approxBox: { x: 0.18, y: 0.22, width: 0.28, height: 0.08 }
              }
            ],
            composer: {
              present: false,
              evidence: "",
              approxBox: null
            }
          };
        }
      }
    } as never
  });

  assert.equal(detection?.summary, "Alice - Need your review");
  assert.equal((detection?.metadata as { recoveryAttempts?: unknown } | undefined)?.recoveryAttempts, 1);
  assert.deepEqual(recoveryClicks, [{ x: 283.5, y: 518 }]);
});

test("outlook desktop pack prefers target-specific vision grounding for the click point", async () => {
  const capturePath = `/tmp/outlook-vision-grounding-${Date.now()}.png`;
  await fs.writeFile(capturePath, createPngHeaderBuffer(1200, 800));
  const worldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-vision-grounding",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowName: "Microsoft Outlook",
          bounds: { x: 100, y: 40, width: 1200, height: 800, centerX: 700, centerY: 440 }
        }
      ]
    },
    capture: {
      id: "artifact-outlook-vision-grounding",
      taskId: "task-outlook-vision-grounding",
      traceId: null,
      kind: "screenshot",
      label: "Outlook vision grounding state",
      path: capturePath,
      metadata: {},
      createdAt: new Date().toISOString()
    },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Outlook\nCurrent thread\n严珊珊",
    recentActions: [],
    summary: "Outlook",
    timestamp: new Date().toISOString()
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({})
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-vision-grounding",
    goal: "Always watch Outlook and prefill replies for unread mail",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-vision-grounding",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: worldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }: { schemaName?: string }) => {
          if (schemaName === "agentos_outlook_thread_grounding") {
            return {
              targetVisible: true,
              evidence: "The 严珊珊 row is visible in the middle message list",
              clickPoint: { x: 0.28, y: 0.58 },
              rowBox: { x: 0.18, y: 0.52, width: 0.22, height: 0.1 }
            };
          }
          return {
            scene: "list",
            openThread: null,
            visibleUnreadThreads: [
              {
                name: "严珊珊",
                evidence: "blue unread dot on the row",
                conversationKind: "direct",
                shouldReply: true,
                replyable: true,
                latestSnippet: "老板下午好，我...",
                replyReason: "Personal greeting message",
                approxBox: { x: 0.17, y: 0.5, width: 0.2, height: 0.11 }
              }
            ],
            composer: {
              present: false,
              evidence: "",
              approxBox: null
            }
          };
        }
      }
    } as never
  });

  await fs.unlink(capturePath).catch(() => null);

  assert.equal(detection?.summary, "严珊珊");
  assert.equal(
    (detection?.metadata as { threadGrounding?: { targetVisible?: unknown } } | undefined)?.threadGrounding?.targetVisible,
    true
  );
  assert.equal(
    Math.round(Number((detection?.metadata as { openPoint?: { x?: unknown } } | undefined)?.openPoint?.x ?? 0)),
    506
  );
  assert.equal(
    Math.round(Number((detection?.metadata as { openPoint?: { y?: unknown } } | undefined)?.openPoint?.y ?? 0)),
    496
  );
});

test("outlook desktop pack falls back to the original unread row when target grounding drifts to a duplicate sender row", async () => {
  const worldState = {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-outlook-duplicate-sender-grounding",
    appContext: {
      appName: "Microsoft Outlook",
      windows: [
        {
          ownerName: "Microsoft Outlook",
          windowName: "Microsoft Outlook",
          bounds: { x: 100, y: 40, width: 1200, height: 800, centerX: 700, centerY: 440 }
        }
      ]
    },
    capture: {
      id: "artifact-outlook-duplicate-sender-grounding",
      taskId: "task-outlook-duplicate-sender-grounding",
      traceId: null,
      kind: "screenshot",
      label: "Outlook duplicate sender grounding state",
      path: "/tmp/outlook-duplicate-sender-grounding.png",
      metadata: {},
      createdAt: new Date().toISOString()
    },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "Outlook\nJin Wang\n系统优化需求: 审批详...\nJin Wang\nBug 报告: 需...",
    recentActions: [],
    summary: "Outlook",
    timestamp: new Date().toISOString()
  };
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({})
  });
  const pack = registry.get("outlook-desktop");
  const rule: WatchRule = {
    id: "watch-outlook-duplicate-sender-grounding",
    goal: "Always watch Outlook and prefill replies for unread mail",
    enabled: true,
    status: "watching",
    preferredSurface: "desktop",
    workspaceName: "outlook-desktop-main",
    skillName: null,
    appTarget: "Microsoft Outlook",
    livePack: "outlook-desktop",
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
    id: "profile-outlook-duplicate-sender-grounding",
    name: "outlook-desktop-main",
    rootPath: "/tmp/outlook-desktop-main",
    profilePath: "/tmp/outlook-desktop-main/profile",
    downloadsPath: "/tmp/outlook-desktop-main/downloads",
    artifactsPath: "/tmp/outlook-desktop-main/artifacts",
    scratchPath: "/tmp/outlook-desktop-main/scratch",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: worldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async ({ schemaName }: { schemaName?: string }) => {
          if (schemaName === "agentos_outlook_thread_grounding") {
            return {
              targetVisible: true,
              evidence: "Matched a lower duplicate Jin Wang row",
              clickPoint: { x: 0.28, y: 0.58 },
              rowBox: { x: 0.18, y: 0.46, width: 0.24, height: 0.08 }
            };
          }
          return {
            scene: "list",
            openThread: null,
            visibleUnreadThreads: [
              {
                name: "Jin Wang",
                evidence: "Unread blue-dot row for the newer approval thread",
                conversationKind: "mail",
                shouldReply: true,
                replyable: true,
                latestSnippet: "系统优化需求: 审批详...",
                replyReason: "Unread work thread that likely needs a reply.",
                priority: "high",
                approxBox: { x: 0.18, y: 0.24, width: 0.24, height: 0.08 }
              }
            ],
            composer: {
              present: false,
              evidence: "",
              approxBox: null
            }
          };
        }
      }
    } as never
  });

  assert.equal(detection?.summary, "Jin Wang");
  assert.equal(
    Math.round(Number((detection?.metadata as { openPoint?: { x?: unknown } } | undefined)?.openPoint?.x ?? 0)),
    508
  );
  assert.equal(
    Math.round(Number((detection?.metadata as { openPoint?: { y?: unknown } } | undefined)?.openPoint?.y ?? 0)),
    440
  );
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
    capture: {
      path: "/tmp/boss-browser-main.png",
      metadata: {
        windowBounds: {
          x: 0,
          y: 0,
          width: 1440,
          height: 960,
          centerX: 720,
          centerY: 480
        }
      }
    },
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
        id: "browser-url",
        surface: "browser",
        kind: "text",
        text: "zhipin.com/web/chat/index",
        role: "textbox",
        bounds: { x: 20, y: 18, width: 320, height: 28, centerX: 180, centerY: 32 },
        confidence: 0.95,
        sourceHints: { source: "ocr" },
        isInteractive: true
      },
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
      if (step.action === "clickTarget" || step.action === "clickAt") {
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
  assert.equal(detection?.inputs?.openTarget, "李雷");
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
  const openCandidate = (context?.inputs?.openCandidate ?? null) as Record<string, unknown> | null;
  assert.equal(context?.inputs?.typeTarget, "");
  assert.equal(typeof openCandidate?.text, "string");
  assert.equal(openCandidate ? "bounds" in openCandidate : false, true);
  assert.equal(context?.inputs?.sendTarget, "发送");
  assert.equal(context?.metadata?.threadKey, "李雷 · 产品经理");
  assert.equal(context?.metadata?.sender, "候选人");
  assert.equal(context?.taskSpec?.skillName, null);
  assert.equal(Array.isArray(context?.taskSpec?.steps), true);
  const typeStep = context?.taskSpec?.steps?.find((step) => step.action === "typeIntoTarget") ?? null;
  assert.equal(context?.taskSpec?.steps?.some((step) => step.action === "clickTarget"), true);
  assert.equal(typeStep?.params?.text, "{{typeText}}");
  assert.deepEqual(typeStep?.expect, {
    textVisible: "{{typeTextPreview}}",
    draftThreadVisible: "{{watchItemText}}"
  });
  assert.equal(context?.context?.some((line) => line.includes("候选人: 方便聊下这个岗位吗？")), true);
});

test("boss browser extractContext skips placeholder waits when vision grounds the compose box", async () => {
  let opened = false;
  const initialWorldState = {
    version: 1,
    surface: "browser",
    workspaceId: "workspace-boss-vision",
    appContext: {
      title: "BOSS直聘",
      url: "http://boss.local/boss"
    },
    capture: {
      path: "/tmp/boss-browser-main-vision.png",
      metadata: {
        windowBounds: {
          x: 0,
          y: 0,
          width: 1440,
          height: 960,
          centerX: 720,
          centerY: 480
        }
      }
    },
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "boss-candidate",
        surface: "browser",
        kind: "link",
        text: "杨安娜",
        role: "link",
        bounds: { x: 10, y: 10, width: 220, height: 28, centerX: 120, centerY: 24 },
        confidence: 0.88,
        sourceHints: { source: "browser", ariaLabel: "杨安娜", href: "/boss/candidate?id=yang" },
        isInteractive: true
      }
    ],
    visibleText: "BOSS直聘\n杨安娜\n候选人: 你好，我对岗位很感兴趣。",
    recentActions: [],
    summary: "BOSS candidate list",
    timestamp: new Date().toISOString()
  };
  const threadWorldState = {
    ...initialWorldState,
    appContext: {
      title: "杨安娜 - BOSS直聘",
      url: "http://boss.local/boss/candidate?id=yang"
    },
    visibleText: "BOSS直聘\n杨安娜\n候选人: 你好，我对岗位很感兴趣。\n在线沟通",
    interactionCandidates: []
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
    id: "watch-boss-browser-vision",
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
    id: "profile-boss-vision",
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

  const context = await pack?.extractContext?.({
    rule,
    worldState: initialWorldState as never,
    detection: detection as never,
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        isConfigured: () => false,
        supportsImageJson: () => true,
        analyzeImageJson: async () => ({
          scene: "thread",
          sceneEvidence: "candidate thread is open",
          recommendedRecoveryAction: "none",
          recoveryControl: { present: false, evidence: "", approxBox: null },
          openThread: "杨安娜",
          bestUnreadThread: {
            present: false,
            name: "",
            evidence: "",
            replyable: false,
            conversationKind: "candidate",
            shouldReply: false,
            replyReason: "",
            subjectCue: "",
            latestSnippet: "",
            priority: "low",
            approxBox: null
          },
          composer: {
            present: true,
            evidence: "reply input visible",
            approxBox: { x: 0.45, y: 0.72, width: 0.42, height: 0.18 },
            entryPoint: { x: 0.49, y: 0.79 },
            hasDraftText: false,
            draftPreview: null
          }
        })
      }
    } as never
  });

  const composeTarget = (context?.inputs?.composeTarget ?? null) as Record<string, unknown> | null;
  const openCandidate = (context?.inputs?.openCandidate ?? null) as Record<string, unknown> | null;
  assert.equal(context?.inputs?.typeTarget, "");
  assert.equal(typeof (composeTarget?.bounds as { centerX?: unknown } | undefined)?.centerX, "number");
  assert.equal(openCandidate ? "bounds" in openCandidate : false, true);
  assert.equal(context?.taskSpec?.steps?.some((step) => step.action === "clickTarget"), true);
  assert.equal(context?.taskSpec?.steps?.some((step) => step.action === "typeIntoTarget"), true);
});

test("boss browser extractContext derives compose fallback bounds from a visible threaded chat", async () => {
  let opened = false;
  const initialWorldState = {
    version: 1,
    surface: "browser",
    workspaceId: "workspace-boss-compose-fallback",
    appContext: {
      title: "BOSS直聘",
      url: "http://boss.local/boss"
    },
    capture: {
      path: "/tmp/boss-browser-main-compose-fallback.png",
      metadata: {
        windowBounds: {
          x: 100,
          y: 50,
          width: 1440,
          height: 960,
          centerX: 820,
          centerY: 530
        }
      }
    },
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "boss-candidate",
        surface: "browser",
        kind: "text",
        text: "王蕊",
        role: "text",
        bounds: { x: 210, y: 200, width: 120, height: 32, centerX: 270, centerY: 216 },
        confidence: 0.9,
        sourceHints: { source: "ocr-boss-list-names" },
        isInteractive: true
      }
    ],
    visibleText: "BOSS直聘\n王蕊\n候选人: 您好，我想进一步了解岗位。",
    recentActions: [],
    summary: "BOSS candidate list",
    timestamp: new Date().toISOString()
  };
  const threadWorldState = {
    ...initialWorldState,
    appContext: {
      title: "王蕊 - BOSS直聘",
      url: "http://boss.local/boss/candidate?id=wang-rui"
    },
    interactionCandidates: [
      {
        id: "thread-name",
        surface: "browser",
        kind: "text",
        text: "王蕊",
        role: "text",
        bounds: { x: 760, y: 140, width: 60, height: 24, centerX: 790, centerY: 152 },
        confidence: 0.95,
        sourceHints: { source: "ocr-boss-thread" },
        isInteractive: true
      },
      {
        id: "thread-snippet",
        surface: "browser",
        kind: "text",
        text: "您好，我想进一步了解岗位。",
        role: "text",
        bounds: { x: 780, y: 520, width: 260, height: 32, centerX: 910, centerY: 536 },
        confidence: 0.94,
        sourceHints: { source: "ocr-boss-thread" },
        isInteractive: true
      }
    ],
    visibleText: "BOSS直聘\n王蕊\n在线沟通\n您好，我想进一步了解岗位。"
  };
  const fakeSurface = {
    async observe() {
      return opened ? threadWorldState : initialWorldState;
    },
    async act({ step }: { step: { action: string } }) {
      if (step.action === "clickTarget" || step.action === "clickAt") {
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
    id: "watch-boss-browser-compose-fallback",
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
    id: "profile-boss-compose-fallback",
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

  const composeTarget = (context?.inputs?.composeTarget ?? null) as {
    bounds?: { centerX?: number; centerY?: number; width?: number; height?: number };
    sourceHints?: { source?: string };
  } | null;
  assert.equal(context?.inputs?.typeTarget, "");
  assert.ok(Number(composeTarget?.bounds?.centerX ?? 0) > 700);
  assert.ok(Number(composeTarget?.bounds?.centerY ?? 0) > 800);
  assert.ok(Number(composeTarget?.bounds?.width ?? 0) > 500);
  assert.ok(Number(composeTarget?.bounds?.height ?? 0) > 100);
  assert.equal(composeTarget?.sourceHints?.source, "boss-compose-region-fallback");
  assert.equal(context?.taskSpec?.steps?.[0]?.action, "wait");
});

test("boss browser extractContext keeps the open step when the visible thread does not match the detected target", async () => {
  let opened = false;
  const initialWorldState = {
    version: 1,
    surface: "browser",
    workspaceId: "workspace-boss-thread-mismatch",
    appContext: {
      title: "BOSS直聘",
      url: "http://boss.local/boss"
    },
    capture: {
      path: "/tmp/boss-browser-main-thread-mismatch.png",
      metadata: {
        windowBounds: {
          x: 100,
          y: 50,
          width: 1440,
          height: 960,
          centerX: 820,
          centerY: 530
        }
      }
    },
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "boss-candidate-yang",
        surface: "browser",
        kind: "text",
        text: "杨安娜",
        role: "text",
        bounds: { x: 210, y: 200, width: 120, height: 32, centerX: 270, centerY: 216 },
        confidence: 0.9,
        sourceHints: { source: "ocr-boss-list-names" },
        isInteractive: true
      }
    ],
    visibleText: "BOSS直聘\n杨安娜\n候选人: 您好，我看到您的简历，觉得很不错，想和您聊聊。",
    recentActions: [],
    summary: "BOSS candidate list",
    timestamp: new Date().toISOString()
  };
  const threadWorldState = {
    ...initialWorldState,
    appContext: {
      title: "王蕊 - BOSS直聘",
      url: "http://boss.local/boss/candidate?id=wang-rui"
    },
    interactionCandidates: [
      {
        id: "thread-name",
        surface: "browser",
        kind: "text",
        text: "王蕊",
        role: "text",
        bounds: { x: 760, y: 140, width: 60, height: 24, centerX: 790, centerY: 152 },
        confidence: 0.95,
        sourceHints: { source: "ocr-boss-thread" },
        isInteractive: true
      }
    ],
    visibleText: "BOSS直聘\n王蕊\n在线沟通\n您好，我是王蕊，想聊一下岗位。",
  };
  const fakeSurface = {
    async observe() {
      return opened ? threadWorldState : initialWorldState;
    },
    async act({ step }: { step: { action: string } }) {
      if (step.action === "clickTarget" || step.action === "clickAt") {
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
    id: "watch-boss-thread-mismatch",
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
    id: "profile-boss-thread-mismatch",
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

  assert.equal(context?.taskSpec?.steps?.[0]?.action, "clickTarget");
  assert.equal(context?.taskSpec?.steps?.[1]?.action, "waitForTarget");
});

test("boss browser extractContext keeps the open step when thread OCR is low quality", async () => {
  const initialWorldState = {
    version: 1,
    surface: "browser",
    workspaceId: "workspace-boss-thread-low-quality",
    appContext: {
      title: "BOSS直聘",
      url: "http://boss.local/boss"
    },
    capture: {
      path: "/tmp/boss-browser-main-thread-low-quality.png",
      metadata: {
        windowBounds: {
          x: 100,
          y: 50,
          width: 1440,
          height: 960,
          centerX: 820,
          centerY: 530
        }
      }
    },
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "boss-candidate-zhuang",
        surface: "browser",
        kind: "text",
        text: "庄瑞莹 ai产品经理",
        role: "text",
        bounds: { x: 210, y: 200, width: 180, height: 32, centerX: 300, centerY: 216 },
        confidence: 0.9,
        sourceHints: { source: "ocr-boss-list-names" },
        isInteractive: true
      }
    ],
    visibleText: "BOSS直聘\n庄瑞莹 ai产品经理\n请问贵公司的ai产品经理还有空缺么？",
    recentActions: [],
    summary: "BOSS candidate list",
    timestamp: new Date().toISOString()
  };
  const threadWorldState = {
    ...initialWorldState,
    appContext: {
      title: "BOSS直聘",
      url: "http://boss.local/boss/candidate?id=zhuang"
    },
    interactionCandidates: [
      {
        id: "thread-name-low-quality",
        surface: "browser",
        kind: "text",
        text: "i O",
        role: "text",
        bounds: { x: 760, y: 140, width: 60, height: 24, centerX: 790, centerY: 152 },
        confidence: 0.95,
        sourceHints: { source: "ocr-boss-thread" },
        isInteractive: true
      },
      {
        id: "reply-box",
        surface: "browser",
        kind: "textarea",
        text: "",
        role: "textbox",
        bounds: { x: 610, y: 740, width: 430, height: 80, centerX: 825, centerY: 780 },
        confidence: 0.86,
        sourceHints: { source: "browser", placeholder: "发送消息给庄瑞莹", tag: "textarea" },
        isInteractive: true
      }
    ],
    visibleText: "BOSS直聘\ni O\n在线沟通\n发送消息给庄瑞莹"
  };
  let opened = false;
  const fakeSurface = {
    async observe() {
      return opened ? threadWorldState : initialWorldState;
    },
    async act({ step }: { step: { action: string } }) {
      if (step.action === "clickTarget" || step.action === "clickAt") {
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
    id: "watch-boss-thread-low-quality",
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
    id: "profile-boss-thread-low-quality",
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

  assert.equal(context?.inputs?.watchSummary, "庄瑞莹 ai产品经理");
  assert.equal(context?.inputs?.openTarget, "庄瑞莹");
  assert.equal(context?.taskSpec?.steps?.[0]?.action, "clickTarget");
  assert.equal(context?.taskSpec?.steps?.[1]?.action, "waitForTarget");
  assert.equal(context?.taskSpec?.steps?.[2]?.expect?.draftThreadVisible, "{{watchItemText}}");
});

test("boss browser extractContext preserves vision openCandidate bounds for query-first fallback", async () => {
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      browser: {
        async act() {
          return { ok: true };
        },
        async observe() {
          return {
            version: 1,
            surface: "browser",
            workspaceId: "workspace-boss-vision-open",
            appContext: {
              title: "杨安娜 - BOSS直聘",
              url: "http://boss.local/boss/candidate?id=yang"
            },
            capture: {
              path: "/tmp/boss-browser-main-open.png",
              metadata: {
                windowBounds: {
                  x: 0,
                  y: 0,
                  width: 1440,
                  height: 960,
                  centerX: 720,
                  centerY: 480
                }
              }
            },
            ocrBlocks: [],
            interactionCandidates: [],
            visibleText: "BOSS直聘\n杨安娜\n候选人: 你好，我对岗位很感兴趣。\n在线沟通",
            recentActions: [],
            summary: "BOSS candidate thread",
            timestamp: new Date().toISOString()
          };
        }
      } as never
    })
  });
  const pack = registry.get("boss-browser");
  const rule: WatchRule = {
    id: "watch-boss-browser-vision-open",
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
    id: "profile-boss-vision-open",
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
  const detection = {
    summary: "杨安娜",
    inputs: {
      openTarget: "杨安娜",
      detailReadyTarget: "在线沟通"
    },
    metadata: {
      openCandidate: {
        id: "boss-vision-unread",
        surface: "browser",
        kind: "text",
        text: "杨安娜",
        role: "text",
        bounds: { x: 120, y: 220, width: 220, height: 64, centerX: 230, centerY: 252 },
        confidence: 0.8,
        sourceHints: { source: "vision", latestSnippet: "方便聊一下岗位吗？" },
        isInteractive: true
      }
    }
  };

  const context = await pack?.extractContext?.({
    rule,
    worldState: null as never,
    detection: detection as never,
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: { isConfigured: () => false }
    } as never
  });

  const openCandidate = (context?.inputs?.openCandidate ?? null) as Record<string, unknown> | null;
  assert.equal(typeof (openCandidate?.bounds as { centerX?: unknown } | undefined)?.centerX, "number");
});

test("boss browser detectNewItems prefers OCR list bounds when vision finds the unread candidate name", async () => {
  const registry = new LivePackRegistry({
    surfaceRegistry: new SurfaceRegistry({
      browser: {
        async act() {
          return { ok: true };
        },
        async observe() {
          throw new Error("not used");
        }
      } as never
    })
  });
  const pack = registry.get("boss-browser");
  const rule: WatchRule = {
    id: "watch-boss-browser-vision-ocr-open",
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
    id: "profile-boss-vision-ocr-open",
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
  const worldState = {
    version: 1,
    surface: "browser",
    workspaceId: "workspace-boss-vision-ocr-open",
    appContext: {
      title: "BOSS直聘",
      url: "https://www.zhipin.com/web/chat/index"
    },
    capture: {
      path: "/tmp/boss-browser-main-vision-ocr-open.png",
      metadata: {
        windowBounds: {
          x: 0,
          y: 0,
          width: 1440,
          height: 960,
          centerX: 720,
          centerY: 480
        }
      }
    },
    ocrBlocks: [],
    interactionCandidates: [
      {
        id: "boss-list-target",
        surface: "browser",
        kind: "text",
        text: "王蕊 ai产品经理",
        role: "text",
        bounds: { x: 220, y: 212, width: 180, height: 42, centerX: 310, centerY: 233 },
        confidence: 0.91,
        sourceHints: { source: "ocr-boss-list-names" },
        isInteractive: true
      },
      {
        id: "boss-list-other",
        surface: "browser",
        kind: "text",
        text: "Leon ai产品经理",
        role: "text",
        bounds: { x: 220, y: 308, width: 180, height: 42, centerX: 310, centerY: 329 },
        confidence: 0.91,
        sourceHints: { source: "ocr-boss-list-names" },
        isInteractive: true
      }
    ],
    visibleText: "BOSS直聘\n王蕊 ai产品经理\n您好，我想进一步了解岗位。\nLeon ai产品经理",
    recentActions: [],
    summary: "BOSS candidate list",
    timestamp: new Date().toISOString()
  };

  const detection = await pack?.detectNewItems?.({
    rule,
    worldState: worldState as never,
    dedupeState: {},
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async () => ({
          scene: "list",
          sceneEvidence: "unread candidate row is visible at the top",
          recommendedRecoveryAction: "none",
          recoveryControl: { present: false, evidence: "", approxBox: null },
          openThread: null,
          bestUnreadThread: {
            present: true,
            name: "王蕊 ai产品经理",
            evidence: "top unread row with red badge",
            replyable: true,
            conversationKind: "candidate",
            shouldReply: true,
            replyReason: "candidate asked a question",
            subjectCue: "",
            latestSnippet: "您好，我想进一步了解岗位。",
            priority: "high",
            approxBox: { x: 0.01, y: 0.22, width: 0.22, height: 0.1 }
          },
          composer: {
            present: false,
            evidence: "",
            approxBox: null,
            entryPoint: null,
            hasDraftText: null,
            draftPreview: null
          }
        })
      }
    } as never
  });

  const openCandidate = (detection?.metadata?.openCandidate ?? null) as { bounds?: { centerX?: number; centerY?: number }; sourceHints?: { source?: string } } | null;
  assert.equal(detection?.summary, "王蕊 ai产品经理");
  assert.equal(Math.round(Number(openCandidate?.bounds?.centerX ?? 0)), 310);
  assert.equal(Math.round(Number(openCandidate?.bounds?.centerY ?? 0)), 233);
  assert.equal(String(openCandidate?.sourceHints?.source ?? ""), "vision+ocr");
});

test("boss browser extractContext re-grounds the target row and opens it via clickAt in the main browser session", async () => {
  const actions: Array<{ action: string; params: Record<string, unknown> | undefined }> = [];
  const initialWorldState = {
    version: 1,
    surface: "browser",
    workspaceId: "workspace-boss-grounded-open",
    appContext: {
      title: "BOSS直聘",
      url: "http://boss.local/boss"
    },
    capture: {
      path: "/tmp/boss-browser-main-open.png",
      metadata: {
        windowBounds: {
          x: 0,
          y: 0,
          width: 1440,
          height: 960,
          centerX: 720,
          centerY: 480
        }
      }
    },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "BOSS直聘\n杨安娜\n候选人: 你好，我对岗位很感兴趣。\nLeon\n候选人: 可以聊聊薪资吗？",
    recentActions: [],
    summary: "BOSS candidate list",
    timestamp: new Date().toISOString()
  };
  const threadWorldState = {
    ...initialWorldState,
    appContext: {
      title: "杨安娜 - BOSS直聘",
      url: "http://boss.local/boss/candidate?id=yang"
    },
    interactionCandidates: [
      {
        id: "reply-box",
        surface: "browser",
        kind: "textarea",
        text: "",
        role: "textbox",
        bounds: { x: 610, y: 740, width: 430, height: 80, centerX: 825, centerY: 780 },
        confidence: 0.86,
        sourceHints: { source: "browser", placeholder: "发送消息给杨安娜", tag: "textarea" },
        isInteractive: true
      },
      {
        id: "send",
        surface: "browser",
        kind: "button",
        text: "发送",
        role: "button",
        bounds: { x: 1060, y: 740, width: 64, height: 32, centerX: 1092, centerY: 756 },
        confidence: 0.86,
        sourceHints: { source: "browser", ariaLabel: "发送消息", tag: "button" },
        isInteractive: true
      }
    ],
    visibleText: "BOSS直聘\n杨安娜\n候选人: 你好，我对岗位很感兴趣。\n在线沟通\n发送消息给杨安娜\n发送"
  };
  const fakeSurface = {
    async observe() {
      return threadWorldState;
    },
    async act({ step }: { step: { action: string; params?: Record<string, unknown> } }) {
      actions.push({ action: step.action, params: step.params });
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
    id: "watch-boss-browser-grounded-open",
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
    id: "profile-boss-grounded-open",
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
  const detection = {
    summary: "杨安娜",
    context: ["你好，我对岗位很感兴趣。"],
    inputs: {
      openTarget: "杨安娜",
      detailReadyTarget: "在线沟通"
    },
    metadata: {
      openCandidate: {
        id: "boss-vision-unread",
        surface: "browser",
        kind: "text",
        text: "杨安娜",
        role: "text",
        bounds: { x: 540, y: 320, width: 264, height: 80, centerX: 672, centerY: 360 },
        confidence: 0.8,
        sourceHints: { source: "vision", latestSnippet: "你好，我对岗位很感兴趣。" },
        isInteractive: true
      },
      visualThread: {
        latestSnippet: "你好，我对岗位很感兴趣。"
      }
    }
  };

  const context = await pack?.extractContext?.({
    rule,
    worldState: initialWorldState as never,
    detection: detection as never,
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: {
        supportsImageJson: () => true,
        analyzeImageJson: async () => ({
          targetVisible: true,
          evidence: "杨安娜 row is visible in the left list",
          clickPoint: { x: 0.12, y: 0.28 },
          rowBox: { x: 0.08, y: 0.24, width: 0.2, height: 0.09 }
        })
      }
    } as never
  });

  assert.equal(actions[0]?.action, "clickAt");
  assert.equal(Math.round(Number(actions[0]?.params?.x ?? 0)), 173);
  assert.equal(Math.round(Number(actions[0]?.params?.y ?? 0)), 269);
  const openCandidate = (context?.inputs?.openCandidate ?? null) as Record<string, unknown> | null;
  assert.equal(Math.round(Number((openCandidate?.bounds as { centerX?: unknown } | undefined)?.centerX ?? 0)), 259);
  assert.equal(Math.round(Number((openCandidate?.bounds as { centerY?: unknown } | undefined)?.centerY ?? 0)), 274);
});

test("boss browser extractContext dismisses the duplicate-login modal before grounding the reply composer", async () => {
  const actions: Array<{ action: string; params: Record<string, unknown> | undefined }> = [];
  let modalVisible = true;
  const initialWorldState = {
    version: 1,
    surface: "browser",
    workspaceId: "workspace-boss-duplicate-login",
    appContext: {
      title: "BOSS直聘",
      url: "http://boss.local/boss"
    },
    capture: {
      path: "/tmp/boss-browser-main-open.png",
      metadata: {
        windowBounds: {
          x: 0,
          y: 0,
          width: 1440,
          height: 960,
          centerX: 720,
          centerY: 480
        }
      }
    },
    ocrBlocks: [],
    interactionCandidates: [],
    visibleText: "BOSS直聘\n杨安娜\n候选人: 你好，我对岗位很感兴趣。",
    recentActions: [],
    summary: "BOSS candidate list",
    timestamp: new Date().toISOString()
  };
  const modalWorldState = {
    ...initialWorldState,
    appContext: {
      title: "杨安娜 - BOSS直聘",
      url: "http://boss.local/boss/candidate?id=yang"
    },
    interactionCandidates: [
      {
        id: "modal-ok",
        surface: "browser",
        kind: "button",
        text: "OK",
        role: "button",
        bounds: { x: 720, y: 110, width: 84, height: 36, centerX: 762, centerY: 128 },
        confidence: 0.92,
        sourceHints: { source: "browser", ariaLabel: "OK", tag: "button" },
        isInteractive: true
      }
    ],
    visibleText: "www.zhipin.com says\n您的账号已经登录过了，请勿重复登录。\nOK\n在线沟通"
  };
  const threadWorldState = {
    ...initialWorldState,
    appContext: {
      title: "杨安娜 - BOSS直聘",
      url: "http://boss.local/boss/candidate?id=yang"
    },
    interactionCandidates: [
      {
        id: "reply-box",
        surface: "browser",
        kind: "textarea",
        text: "",
        role: "textbox",
        bounds: { x: 610, y: 740, width: 430, height: 80, centerX: 825, centerY: 780 },
        confidence: 0.86,
        sourceHints: { source: "browser", placeholder: "发送消息给杨安娜", tag: "textarea" },
        isInteractive: true
      },
      {
        id: "send",
        surface: "browser",
        kind: "button",
        text: "发送",
        role: "button",
        bounds: { x: 1060, y: 740, width: 64, height: 32, centerX: 1092, centerY: 756 },
        confidence: 0.86,
        sourceHints: { source: "browser", ariaLabel: "发送消息", tag: "button" },
        isInteractive: true
      }
    ],
    visibleText: "BOSS直聘\n杨安娜\n候选人: 你好，我对岗位很感兴趣。\n在线沟通\n发送消息给杨安娜\n发送"
  };
  const fakeSurface = {
    async observe() {
      return modalVisible ? modalWorldState : threadWorldState;
    },
    async act({ step }: { step: { action: string; params?: Record<string, unknown> } }) {
      actions.push({ action: step.action, params: step.params });
      if (step.action === "press" && String(step.params?.key ?? "").trim() === "enter") {
        modalVisible = false;
      }
      if (step.action === "clickTarget" && String(step.params?.targetQuery ?? "").trim() === "OK") {
        modalVisible = false;
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
    id: "watch-boss-browser-duplicate-login",
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
    id: "profile-boss-duplicate-login",
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
  const detection = {
    summary: "杨安娜",
    context: ["你好，我对岗位很感兴趣。"],
    inputs: {
      openTarget: "杨安娜",
      detailReadyTarget: "在线沟通"
    },
    metadata: {
      openCandidate: {
        id: "boss-vision-unread",
        surface: "browser",
        kind: "text",
        text: "杨安娜",
        role: "text",
        bounds: { x: 540, y: 320, width: 264, height: 80, centerX: 672, centerY: 360 },
        confidence: 0.8,
        sourceHints: { source: "vision", latestSnippet: "你好，我对岗位很感兴趣。" },
        isInteractive: true
      }
    }
  };

  const context = await pack?.extractContext?.({
    rule,
    worldState: initialWorldState as never,
    detection: detection as never,
    workspace,
    surfaceRegistry: registry.surfaceRegistry as never,
    controlPlane: {
      modelClient: { supportsImageJson: () => false }
    } as never
  });

  assert.equal(actions.some((entry) => entry.action === "press" && entry.params?.key === "enter"), true);
  assert.equal(context?.inputs?.sendTarget, "发送");
  assert.equal(typeof (context?.inputs?.composeTarget as { bounds?: unknown } | undefined)?.bounds, "object");
  assert.equal(context?.inputs?.typeTarget, "");
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

    const triggeredTask = await waitForWatchTask(server.baseUrl, watch.id, 20000);
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
      (draft) => draft.watchRuleId === watch.id && draft.livePack === "boss-browser" && draft.status === "pending",
      20000
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
    assert.equal(state.sentReplies[0].message, "你好，收到你的消息。关于这个岗位，我会先确认一下，并尽快和你沟通后续。");
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
      (draft) => draft.watchRuleId === watch.id && draft.livePack === "boss-browser" && draft.status === "pending",
      20000
    );
    const approvedResponse = await fetch(`${server.baseUrl}/drafts/${pendingDraft.id}/approve`, {
      method: "POST"
    });
    const approvedPayload = await approvedResponse.json();
    const firstCompleted = await waitForTask(server.baseUrl, approvedPayload.draft.taskId, (task) => task.status === "completed");
    assert.equal(firstCompleted.status, "completed");

    let state = await waitForValue(() => boss.getState(), (current) => current.sentReplies.length === 1);
    assert.equal(state.sentReplies[0].message, "你好，收到你的消息。关于这个岗位，我会先确认一下，并尽快和你沟通后续。");

    await boss.pushIncomingMessage("候选人: 我这周三下午可以沟通。");

    state = await waitForValue(() => boss.getState(), (current) => current.sentReplies.length === 2, 15000);
    assert.equal(state.sentReplies[1].message, "你好，收到你的消息。关于这周三下午的沟通安排，我会先确认一下，并尽快和你沟通后续。");

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
