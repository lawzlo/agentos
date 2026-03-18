import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { TaskRecord } from "../src/types/runtime-schema.js";
import { rotateDaemonLogs } from "../src/daemon-state.js";
import { FileInboxConnector } from "../src/runtime/connectors/file-inbox.js";
import { EventBus } from "../src/runtime/event-bus.js";
import { RuntimeSupervisor } from "../src/runtime/runtime-supervisor.js";
import { ControlPlaneStore } from "../src/runtime/store.js";
import { WatchScheduler } from "../src/runtime/watch-scheduler.js";
import { createServer } from "../src/server.js";
import { getRuntimeVersionInfo } from "../src/version.js";
import { createTempDir, startAgentServer } from "./helpers.js";

const execFileAsync = promisify(execFile);

test("store schema version matches the runtime contract", async () => {
  const dataDir = await createTempDir();
  const store = new ControlPlaneStore(path.join(dataDir, "agentos.sqlite"));

  try {
    assert.equal(store.getSchemaVersion(), getRuntimeVersionInfo().storeSchemaVersion);
  } finally {
    store.close();
  }
});

test("doctor bundle and version endpoints expose hardening metadata", async () => {
  const dataDir = await createTempDir();
  const server = await startAgentServer({ dataDir });

  try {
    const versionPayload = await (await fetch(`${server.baseUrl}/version`)).json();
    assert.equal(versionPayload.version.appVersion, getRuntimeVersionInfo().appVersion);
    assert.equal(
      versionPayload.version.runtimeProtocolVersion,
      getRuntimeVersionInfo().runtimeProtocolVersion
    );

    const doctorPayload = await (await fetch(`${server.baseUrl}/doctor`)).json();
    assert.equal(typeof doctorPayload.doctor.store.schemaVersion, "number");
    assert.equal(typeof doctorPayload.doctor.version.appVersion, "string");
    assert.equal(typeof doctorPayload.doctor.native.compatible, "boolean");
    assert.equal(typeof doctorPayload.doctor.readyLivePackCount, "number");
    assert.equal(typeof doctorPayload.doctor.blockedLivePackCount, "number");
    assert.equal(typeof doctorPayload.doctor.pendingProposalCount, "number");
    assert.equal(typeof doctorPayload.doctor.awaitingApprovalWatchCount, "number");
    assert.equal(typeof doctorPayload.doctor.backoffWatchCount, "number");
    assert.equal(typeof doctorPayload.doctor.install.mode, "string");
    assert.equal(Array.isArray(doctorPayload.doctor.recentErrors), true);
    assert.equal(typeof doctorPayload.doctor.lifecycle.lastStartReason, "string");
    assert.equal(typeof doctorPayload.doctor.startupRecovery.requeuedTaskCount, "number");

    const daemonPayload = await (await fetch(`${server.baseUrl}/daemon/status`)).json();
    assert.equal(typeof daemonPayload.daemon.livePackCount, "number");
    assert.equal(typeof daemonPayload.daemon.readyLivePackCount, "number");
    assert.equal(typeof daemonPayload.daemon.blockedLivePackCount, "number");
    assert.equal(typeof daemonPayload.daemon.degradedWatchCount, "number");
    assert.equal(typeof daemonPayload.daemon.pendingDraftCount, "number");
    assert.equal(typeof daemonPayload.daemon.pendingProposalCount, "number");
    assert.equal(typeof daemonPayload.daemon.install.mode, "string");
    assert.equal(Array.isArray(daemonPayload.daemon.recentErrors), true);
    assert.equal(typeof daemonPayload.daemon.lifecycle.lastStartReason, "string");
    assert.equal(typeof daemonPayload.daemon.startupRecovery.interruptedTaskCount, "number");

    const bundlePayload = await (
      await fetch(`${server.baseUrl}/doctor/bundle`, { method: "POST" })
    ).json();
    assert.equal(path.basename(path.dirname(bundlePayload.bundle.bundlePath)), "bundles");
    const doctorBundle = JSON.parse(
      await fs.readFile(path.join(bundlePayload.bundle.bundlePath, "doctor.json"), "utf8")
    );
    assert.equal(doctorBundle.doctor.version.appVersion, getRuntimeVersionInfo().appVersion);
  } finally {
    await server.close();
  }
});

test("daemon status reports a clean-shutdown restart reason on the next startup", async () => {
  const dataDir = await createTempDir();
  const first = await startAgentServer({ dataDir });
  await first.close();

  const second = await startAgentServer({ dataDir });

  try {
    const daemonPayload = await (await fetch(`${second.baseUrl}/daemon/status`)).json();
    assert.equal(daemonPayload.daemon.lifecycle.previousExit.kind, "clean_shutdown");
    assert.equal(daemonPayload.daemon.lifecycle.lastStartReason, "restart_after_clean_shutdown");
  } finally {
    await second.close();
  }
});

test("packs endpoint reports browser packs as blocked when no browser executable is configured", async () => {
  const dataDir = await createTempDir();
  const server = await startAgentServer({
    dataDir,
    browserExecutable: ""
  });

  try {
    const packsPayload = await (await fetch(`${server.baseUrl}/packs`)).json();
    const slackBrowser = packsPayload.packs.find((pack) => pack.name === "slack-browser");
    assert.equal(slackBrowser?.ready, false);
    assert.equal(
      slackBrowser?.healthChecks?.some((check) => check.id === "browser-runtime" && check.status === "blocked"),
      true
    );
  } finally {
    await server.close();
  }
});

test("daemon logs rotate when they exceed the configured size", async () => {
  const dataDir = await createTempDir();
  const daemonDir = path.join(dataDir, "daemon");
  const logPath = path.join(daemonDir, "daemon.log");
  await fs.mkdir(daemonDir, { recursive: true });
  await fs.writeFile(logPath, "x".repeat(256), "utf8");
  await fs.writeFile(`${logPath}.1`, "older", "utf8");

  await rotateDaemonLogs(daemonDir, {
    maxBytes: 64,
    backups: 2
  });

  const rotated = await fs.readFile(`${logPath}.1`, "utf8");
  const older = await fs.readFile(`${logPath}.2`, "utf8");
  assert.equal(rotated.length, 256);
  assert.equal(older, "older");
});

test("server listen refuses a second daemon for the same data directory", async () => {
  const dataDir = await createTempDir();
  const primary = await createServer({ dataDir, port: 0, headless: true });
  const secondary = await createServer({ dataDir, port: 0, headless: true });

  try {
    await primary.listen();
    await assert.rejects(() => secondary.listen(), /already running/i);
  } finally {
    await primary.close();
  }
});

test("cli version and doctor bundle commands use the daemon API", async () => {
  const dataDir = await createTempDir();
  const server = await startAgentServer({ dataDir });

  try {
    const env = {
      ...process.env,
      AGENTOS_BASE_URL: server.baseUrl,
      AGENTOS_DATA_DIR: dataDir
    };

    const versionResult = await execFileAsync(
      process.execPath,
      ["dist/bin/agentos.js", "version", "--json"],
      {
        cwd: process.cwd(),
        env
      }
    );
    const version = JSON.parse(versionResult.stdout);
    assert.equal(version.appVersion, getRuntimeVersionInfo().appVersion);

    const bundleResult = await execFileAsync(
      process.execPath,
      ["dist/bin/agentos.js", "doctor", "--bundle", "--json"],
      {
        cwd: process.cwd(),
        env
      }
    );
    const bundle = JSON.parse(bundleResult.stdout);
    assert.equal(typeof bundle.bundlePath, "string");
    await fs.access(path.join(bundle.bundlePath, "doctor.json"));
  } finally {
    await server.close();
  }
});

test("watch scheduler shutdown waits for in-flight scans to finish", async () => {
  let releaseScan: (() => void) | null = null;
  let stopResolved = false;
  let markScanStarted: (() => void) | null = null;
  const scanStarted = new Promise<void>((resolve) => {
    markScanStarted = resolve;
  });
  const scheduler = new WatchScheduler({
    store: {
      listWatchRules() {
        return [];
      },
      getWatchRule(id: string) {
        return {
          id,
          enabled: true,
          pollIntervalMs: 1000
        };
      }
    },
    executionService: {
      async scan() {
        markScanStarted?.();
        await new Promise<void>((release) => {
          releaseScan = release;
        });
      }
    }
  });

  const scanPromise = scheduler.scan("watch-1");
  await scanStarted;
  const stopPromise = scheduler.stop().then(() => {
    stopResolved = true;
  });
  await new Promise((wait) => setTimeout(wait, 30));
  assert.equal(stopResolved, false);
  releaseScan?.();
  await Promise.all([scanPromise, stopPromise]);
  assert.equal(stopResolved, true);
});

test("file inbox shutdown waits for in-flight file processing to finish", async () => {
  const dataDir = await createTempDir();
  const inboxDir = path.join(dataDir, "inbox");
  let releaseCreateTask: (() => void) | null = null;
  let stopResolved = false;
  let started = false;
  const now = new Date().toISOString();
  const taskRecord: TaskRecord = {
    id: "task-1",
    goal: "Inbox task",
    status: "queued",
    priority: "normal",
    triggerSource: "test",
    deadline: null,
    preferredSurface: "auto",
    workspaceId: null,
    traceId: null,
    taskSpec: {
      goal: "Inbox task"
    },
    plan: [],
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now
  };

  const connector = new FileInboxConnector({
    inboxDir,
    pollMs: 20,
    controlPlane: {
      async ingestEvent() {
        return {
          event: {
            id: "event-1",
            type: "test",
            source: "test",
            taskId: taskRecord.id,
            payload: {},
            createdAt: now
          },
          task: taskRecord
        };
      },
      async createTask() {
        started = true;
        await new Promise<void>((resolve) => {
          releaseCreateTask = resolve;
        });
        return taskRecord;
      },
      eventBus: new EventBus()
    }
  });

  await fs.mkdir(inboxDir, { recursive: true });
  await fs.writeFile(path.join(inboxDir, "task.json"), JSON.stringify({ goal: "Inbox task" }), "utf8");

  try {
    await connector.start();
    const startedAt = Date.now();
    while (!started && Date.now() - startedAt < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(started, true);

    const stopPromise = connector.stop().then(() => {
      stopResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(stopResolved, false);

    releaseCreateTask?.();
    await stopPromise;
    assert.equal(stopResolved, true);
  } finally {
    releaseCreateTask?.();
  }
});

test("runtime supervisor shutdown waits for queued task drains before closing the store", async () => {
  let releaseTask: (() => void) | null = null;
  let taskStarted = false;
  let shutdownResolved = false;
  let storeClosed = false;
  let surfaceShutdown = false;

  const supervisor = new RuntimeSupervisor({
    controlPlane: {
      mergePersistedResult() {
        return {};
      },
      getTask() {
        return null;
      },
      decorateTask(task) {
        return task;
      },
      controlTask() {
        return null;
      },
      saveTaskAsSkill() {
        return null;
      },
      saveTaskAsWatchRule() {
        return null;
      }
    } as never,
    store: {
      listTasksByStatuses() {
        return [];
      },
      updateTask() {
        return null;
      },
      getTask() {
        return null;
      },
      updateTrace() {
        return null;
      },
      close() {
        storeClosed = true;
      }
    } as never,
    traceStore: {
      start() {
        return { id: "trace-1" };
      },
      finish() {
        return null;
      },
      log() {
        return null;
      }
    } as never,
    eventBus: new EventBus(),
    executionController: {
      registerTask() {
        return null;
      },
      unregisterTask() {
        return null;
      },
      getState() {
        return null;
      },
      waitForAgent() {
        return Promise.resolve(null);
      },
      setMode() {
        return null;
      }
    } as never,
    workspaceManager: {} as never,
    policyEngine: {} as never,
    autonomy: {} as never,
    planner: {} as never,
    operator: {} as never,
    verifier: {} as never,
    recovery: {} as never,
    memoryStore: {
      remember() {
        return null;
      }
    } as never,
    watchScheduler: {
      stop() {
        return Promise.resolve();
      }
    } as never,
    connectors: [],
    surfaceRegistry: {
      shutdown() {
        surfaceShutdown = true;
        return Promise.resolve();
      }
    } as never
  });

  supervisor.runTask = async () => {
    taskStarted = true;
    await new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
  };

  supervisor.enqueue("task-1");
  const startedAt = Date.now();
  while (!taskStarted && Date.now() - startedAt < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(taskStarted, true);

  const shutdownPromise = supervisor.shutdown().then(() => {
    shutdownResolved = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(shutdownResolved, false);
  assert.equal(storeClosed, false);
  assert.equal(surfaceShutdown, false);

  releaseTask?.();
  await shutdownPromise;
  assert.equal(shutdownResolved, true);
  assert.equal(storeClosed, true);
  assert.equal(surfaceShutdown, true);
});
