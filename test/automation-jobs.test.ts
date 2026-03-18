import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { resolveConfig } from "../src/config.js";
import { EventBus } from "../src/runtime/event-bus.js";
import { AutomationJobService } from "../src/runtime/automation-job-service.js";
import { ControlPlaneStore } from "../src/runtime/store.js";
import { createTempDir, startAgentServer } from "./helpers.js";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  return response.json() as Promise<T>;
}

test("automation job service runs due jobs and reschedules them", async () => {
  const dataDir = await createTempDir();
  const config = resolveConfig({
    dataDir,
    jobs: {
      pollIntervalMs: 20
    }
  });
  const store = new ControlPlaneStore(path.join(dataDir, "agentos.sqlite"));
  const eventBus = new EventBus();
  let digestRuns = 0;
  let taskRuns = 0;
  const service = new AutomationJobService({
    store,
    eventBus,
    config,
    createTask: async () => {
      taskRuns += 1;
      return { id: `task-${taskRuns}` };
    },
    runDigest: async () => {
      digestRuns += 1;
      return { id: `digest-${digestRuns}` };
    }
  });

  try {
    const digestJob = service.createJob({
      template: "daily_digest",
      hourOfDay: 18
    });
    const taskJob = service.createJob({
      template: "custom_task",
      goal: "Prepare a scheduled summary",
      intervalMinutes: 30
    });

    store.putAutomationJob({
      ...digestJob,
      nextRunAt: new Date(Date.now() - 1000).toISOString()
    });
    store.putAutomationJob({
      ...taskJob,
      nextRunAt: new Date(Date.now() - 1000).toISOString()
    });

    await service.start();
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(digestRuns, 1);
    assert.equal(taskRuns, 1);

    const jobs = service.listJobs();
    assert.equal(jobs.every((job) => job.status === "healthy"), true);
    assert.equal(jobs.every((job) => typeof job.nextRunAt === "string"), true);
  } finally {
    await service.stop();
    store.close();
  }
});

test("follow_up_sweep jobs default to interval scheduling and a conversation follow-up goal", async () => {
  const dataDir = await createTempDir();
  const config = resolveConfig({
    dataDir,
    jobs: {
      pollIntervalMs: 20
    }
  });
  const store = new ControlPlaneStore(path.join(dataDir, "agentos.sqlite"));
  const eventBus = new EventBus();
  const service = new AutomationJobService({
    store,
    eventBus,
    config,
    createTask: async () => ({ id: "task-1" }),
    runDigest: async () => ({ id: "digest-1" })
  });

  try {
    const job = service.createJob({
      template: "follow_up_sweep"
    });

    assert.equal(job.scheduleType, "interval");
    assert.equal(job.intervalMinutes, 180);
    assert.equal(job.taskSpec?.preferredSurface, "auto");
    assert.match(String(job.taskSpec?.goal ?? ""), /slack|wechat|email|boss/i);
    assert.match(String(job.taskSpec?.goal ?? ""), /follow-up|follow up|nudge/i);
  } finally {
    await service.stop();
    store.close();
  }
});

test("jobs API can add, run, disable, enable, and remove automation jobs", async () => {
  const dataDir = await createTempDir();
  const server = await startAgentServer({
    dataDir,
    jobs: {
      pollIntervalMs: 20
    }
  });

  try {
    const digestCreate = await fetchJson<{ job: { id: string; template: string } }>(`${server.baseUrl}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        template: "daily_digest",
        hourOfDay: 18
      })
    });
    assert.equal(digestCreate.job.template, "daily_digest");

    const taskCreate = await fetchJson<{ job: { id: string; template: string } }>(`${server.baseUrl}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        template: "morning_scan",
        workspaceName: "jobs-main",
        preferredSurface: "browser",
        hourOfDay: 9
      })
    });
    assert.equal(taskCreate.job.template, "morning_scan");

    const jobsPayload = await fetchJson<{ jobs: Array<{ id: string }> }>(`${server.baseUrl}/jobs`);
    assert.equal(jobsPayload.jobs.length, 2);

    const digestRun = await fetchJson<{ job: { status: string } }>(`${server.baseUrl}/jobs/${digestCreate.job.id}/run`, {
      method: "POST"
    });
    assert.equal(digestRun.job.status, "healthy");

    const digests = await fetchJson<{ digests: Array<{ id: string }> }>(`${server.baseUrl}/digests`);
    assert.equal(digests.digests.length >= 1, true);

    const taskRun = await fetchJson<{ job: { status: string; lastTaskId: string | null } }>(
      `${server.baseUrl}/jobs/${taskCreate.job.id}/run`,
      {
        method: "POST"
      }
    );
    assert.equal(taskRun.job.status, "healthy");
    assert.equal(typeof taskRun.job.lastTaskId, "string");

    const taskPayload = await fetchJson<{ task: { id: string; goal: string } }>(
      `${server.baseUrl}/tasks/${taskRun.job.lastTaskId}`
    );
    assert.match(taskPayload.task.goal, /morning brief|priority inbox|urgent chat/i);

    const followUpCreate = await fetchJson<{ job: { id: string; template: string; scheduleType: string } }>(
      `${server.baseUrl}/jobs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          template: "follow_up_sweep",
          workspaceName: "jobs-main",
          preferredSurface: "auto"
        })
      }
    );
    assert.equal(followUpCreate.job.template, "follow_up_sweep");
    assert.equal(followUpCreate.job.scheduleType, "interval");

    const followUpRun = await fetchJson<{ job: { status: string; lastTaskId: string | null } }>(
      `${server.baseUrl}/jobs/${followUpCreate.job.id}/run`,
      {
        method: "POST"
      }
    );
    assert.equal(followUpRun.job.status, "healthy");
    assert.equal(typeof followUpRun.job.lastTaskId, "string");

    const followUpTaskPayload = await fetchJson<{ task: { goal: string } }>(
      `${server.baseUrl}/tasks/${followUpRun.job.lastTaskId}`
    );
    assert.match(followUpTaskPayload.task.goal, /slack|wechat|email|boss/i);
    assert.match(followUpTaskPayload.task.goal, /follow-up|follow up|nudge/i);

    const disable = await fetchJson<{ job: { enabled: boolean } }>(`${server.baseUrl}/jobs/${taskCreate.job.id}/disable`, {
      method: "POST"
    });
    assert.equal(disable.job.enabled, false);

    const enable = await fetchJson<{ job: { enabled: boolean } }>(`${server.baseUrl}/jobs/${taskCreate.job.id}/enable`, {
      method: "POST"
    });
    assert.equal(enable.job.enabled, true);

    const daemon = await fetchJson<{ daemon: { jobCount: number; enabledJobCount: number } }>(
      `${server.baseUrl}/daemon/status`
    );
    assert.equal(daemon.daemon.jobCount, 3);
    assert.equal(daemon.daemon.enabledJobCount, 3);

    const removed = await fetchJson<{ ok: boolean }>(`${server.baseUrl}/jobs/${taskCreate.job.id}`, {
      method: "DELETE"
    });
    assert.equal(removed.ok, true);
  } finally {
    await server.close();
  }
});
