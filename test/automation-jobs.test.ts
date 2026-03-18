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
    assert.equal(daemon.daemon.jobCount, 2);
    assert.equal(daemon.daemon.enabledJobCount, 2);

    const removed = await fetchJson<{ ok: boolean }>(`${server.baseUrl}/jobs/${taskCreate.job.id}`, {
      method: "DELETE"
    });
    assert.equal(removed.ok, true);
  } finally {
    await server.close();
  }
});
