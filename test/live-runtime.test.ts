import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ControlPlaneStore } from "../src/runtime/store.js";
import { createTempDir, startAgentServer, waitForTask } from "./helpers.js";

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

    const statusResult = await execFileAsync(process.execPath, ["bin/agentos.js", "daemon", "status", "--json"], {
      cwd: process.cwd(),
      env
    });
    const daemonStatus = JSON.parse(statusResult.stdout);
    assert.equal(daemonStatus.running, true);

    const addResult = await execFileAsync(
      process.execPath,
      [
        "bin/agentos.js",
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

    const listResult = await execFileAsync(process.execPath, ["bin/agentos.js", "watch", "ls", "--json"], {
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
        "bin/agentos.js",
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
