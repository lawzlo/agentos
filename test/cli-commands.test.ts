import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { AddressInfo } from "node:net";

import { createTempDir } from "./helpers.js";

const execFileAsync = promisify(execFile);

async function runCliSession(args: string[], input: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
        return;
      }
      reject(new Error(`CLI session exited with code ${code}: ${stderr || stdout}`));
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

interface CliTraceEvent {
  message: string;
  role: string;
  type: string;
  createdAt: string;
}

interface CliTaskTrace {
  id: string;
  status: string;
  events: CliTraceEvent[];
}

interface CliRuntimeControl {
  mode: string;
  reason: string | null;
  source: string;
  updatedAt: string;
}

interface CliTask {
  id: string;
  goal: string;
  status: string;
  priority: string;
  triggerSource: string;
  deadline: string | null;
  preferredSurface: string;
  workspaceId: string | null;
  traceId: string;
  taskSpec: Record<string, unknown>;
  plan: unknown[];
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  runtimeControl: CliRuntimeControl;
  trace: CliTaskTrace;
}

interface CliTeachStep {
  action: string;
  surface: string;
  label: string;
  params: Record<string, unknown>;
}

interface CliWatch {
  id: string;
  status: string;
  goal: string;
  preferredSurface: string;
  workspaceName: string | null;
  skillName: string | null;
  appTarget: string | null;
  livePack: string;
  pollIntervalMs: number;
  taskInputs: Record<string, unknown>;
  health: Record<string, unknown> | null;
}

interface CliApiState {
  error?: string;
  taskCounter: number;
  tasks: Record<string, CliTask>;
  watchCounter: number;
  watches: Record<string, CliWatch>;
  taskPolls: Record<string, number>;
  lastTaskBody: Record<string, unknown> | null;
  lastControlBody: { action?: string } & Record<string, unknown> | null;
  lastTeachBody: { step?: CliTeachStep } & Record<string, unknown> | null;
  lastWatchBody: Record<string, unknown> | null;
  waitTaskId: string | null;
}

async function startCliApiFixture() {
    const state: CliApiState = {
    taskCounter: 1,
    watchCounter: 1,
    tasks: {},
    watches: {},
    taskPolls: {},
    lastTaskBody: null,
    lastControlBody: null,
    lastTeachBody: null,
    lastWatchBody: null,
    waitTaskId: null
  };

  const now = new Date().toISOString();

function nowIso() {
  return new Date().toISOString();
}

function asNullableString(value: unknown, fallback: string | null = null) {
  if (typeof value === "string") {
    return value;
  }
  return fallback;
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";

    const readBody = async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      if (!chunks.length) {
        return {};
      }

      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        return {};
      }

      return JSON.parse(raw);
    };

    function writeJson(payload: unknown, status = 200) {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    }

    if (method === "GET" && url.pathname === "/daemon/status") {
      writeJson({
        daemon: {
          running: true,
          pid: 1234,
          port: 3017,
          connectorCount: 0,
          livePackCount: 4,
          readyLivePackCount: 2,
          blockedLivePackCount: 2,
          watchCount: Object.keys(state.watches).length,
          enabledWatchCount: Object.values(state.watches).filter((watch) => watch.status === "watching").length,
          degradedWatchCount: 1,
          pendingDraftCount: 1,
          pendingProposalCount: 1,
          install: {
            supported: true,
            mode: "launchd",
            installed: false,
            loaded: null
          }
        }
      });
      return;
    }

    if (method === "GET" && url.pathname === "/doctor") {
      writeJson({
        doctor: {
          ok: false,
          warnings: [
            "Model client is not configured; live reply drafting uses heuristics.",
            "Daemon auto-start is not installed.",
            "2 live pack(s) are blocked: slack-browser, boss-browser."
          ],
          browserExecutable: null,
          modelConfigured: false,
          livePackCount: 4,
          readyLivePackCount: 2,
          blockedLivePackCount: 2,
          degradedWatchCount: 1,
          pendingDraftCount: 1,
          pendingProposalCount: 1,
          awaitingApprovalWatchCount: 1,
          backoffWatchCount: 1,
          connectorCount: 0,
          learning: {
            running: true,
            sourceCount: 1,
            enabledSourceCount: 1,
            observationCount: 0,
            entityCount: 0,
            chunkCount: 0,
            pendingProposalCount: 1,
            lastDigestAt: null,
            lastObservationAt: null,
            scanIntervalMs: 300000
          },
          version: {
            appVersion: "0.1.0",
            runtimeProtocolVersion: 1,
            nativeProtocolVersion: 1,
            storeSchemaVersion: 2,
            installLayoutVersion: 1
          },
          install: {
            supported: true,
            mode: "launchd",
            installed: false,
            loaded: null
          },
          recentErrors: [
            {
              id: "watch-1",
              status: "backoff",
              message: "Thread reply failed",
              updatedAt: nowIso()
            }
          ],
          store: {
            schemaVersion: 2,
            compatible: true
          },
          native: {
            available: true,
            compatible: true,
            permissions: {
              accessibility: true,
              screenRecording: true
            }
          }
        }
      });
      return;
    }

    if (method === "GET" && url.pathname === "/learning/sources") {
      writeJson({ sources: [] });
      return;
    }

    if (method === "GET" && url.pathname === "/learning/status") {
      writeJson({ learning: { observationCount: 0, chunkCount: 0 } });
      return;
    }

    if (method === "GET" && url.pathname === "/tasks") {
      const limit = Number(url.searchParams.get("limit") ?? 20);
      writeJson({ tasks: Object.values(state.tasks).slice(0, limit) });
      return;
    }

    if (method === "GET" && url.pathname === "/watches") {
      const limit = Number(url.searchParams.get("limit") ?? 20);
      writeJson({ watches: Object.values(state.watches).slice(0, limit) });
      return;
    }

    if (method === "POST" && url.pathname === "/watches") {
      const body = (await readBody()) as Record<string, unknown>;
      const watchId = `watch-${state.watchCounter}`;
      state.watchCounter += 1;
      const watch: CliWatch = {
        id: watchId,
        status: "watching",
        goal: String(body.goal ?? ""),
        preferredSurface: String(body.preferredSurface ?? "desktop"),
        workspaceName: asNullableString(body.workspaceName, "default"),
        skillName: asNullableString(body.skillName),
        appTarget: asNullableString(body.appTarget),
        livePack: String(body.livePack ?? "generic-desktop"),
        pollIntervalMs: Number(body.pollIntervalMs ?? 15000),
        taskInputs: body.inputs as Record<string, unknown> ?? {},
        health: null
      };
      state.lastWatchBody = body;
      state.watches[watchId] = watch;
      writeJson({ watch });
      return;
    }

    if (
      parts[0] === "watches" &&
      parts[1] &&
      method === "GET" &&
      (parts[2] === undefined || parts[2] === "")
    ) {
      const watch = state.watches[parts[1]];
      if (!watch) {
        writeJson({ error: "Watch not found" }, 404);
        return;
      }
      writeJson({ watch });
      return;
    }

    if (parts[0] === "watches" && parts[1] && method === "DELETE" && parts[2] === undefined) {
      if (!state.watches[parts[1]]) {
        writeJson({ error: "Watch not found" }, 404);
        return;
      }

      delete state.watches[parts[1]];
      writeJson({ ok: true });
      return;
    }

    if (parts[0] === "watches" && parts[1] && method === "POST" && (parts[2] === "disable" || parts[2] === "enable")) {
      const watch = state.watches[parts[1]];
      if (!watch) {
        writeJson({ error: "Watch not found" }, 404);
        return;
      }

      watch.status = parts[2] === "disable" ? "paused" : "watching";
      watch.health = {
        state: watch.status === "watching" ? "healthy" : "disabled",
        failureCount: 0
      };
      writeJson({ watch });
      return;
    }

    if (parts[0] === "watches" && parts[1] && method === "POST" && parts[2] === "retry") {
      const watch = state.watches[parts[1]];
      if (!watch) {
        writeJson({ error: "Watch not found" }, 404);
        return;
      }

      watch.status = "watching";
      watch.health = { state: "healthy", failureCount: 0 };
      writeJson({ watch });
      return;
    }

    if (parts[0] === "watches" && parts[1] && method === "GET" && parts[2] === "health") {
      const watch = state.watches[parts[1]];
      if (!watch) {
        writeJson({ error: "Watch not found" }, 404);
        return;
      }

      writeJson({ health: watch.health ?? { state: "n/a", failureCount: 0 } });
      return;
    }

    if (method === "POST" && url.pathname === "/watches/from-task") {
      const body = (await readBody()) as Record<string, unknown>;
      const taskId = body.taskId;
      if (!taskId || typeof taskId !== "string" || !state.tasks[taskId]) {
        writeJson({ error: "Task not found" }, 400);
        return;
      }

      const watchId = `watch-${state.watchCounter}`;
      state.watchCounter += 1;
      const watch: CliWatch = {
        id: watchId,
        status: "watching",
        goal: String(body.goal ?? `From task ${taskId}`),
        preferredSurface: String(body.preferredSurface ?? "desktop"),
        workspaceName: asNullableString(body.workspaceName, "default"),
        skillName: asNullableString(body.skillName),
        appTarget: asNullableString(body.appTarget),
        livePack: String(body.livePack ?? "generic-desktop"),
        pollIntervalMs: Number(body.pollIntervalMs ?? 15000),
        taskInputs: body.inputs as Record<string, unknown> ?? {},
        health: {
          state: "healthy",
          failureCount: 0,
          learningTaskId: taskId
        }
      };

      state.lastWatchBody = body;
      state.watches[watchId] = watch;
      writeJson({ watch });
      return;
    }

    if (method === "GET" && url.pathname.startsWith("/memory/search")) {
      writeJson({ chunks: [] });
      return;
    }

    if (method === "POST" && url.pathname === "/tasks") {
      const body = (await readBody()) as Record<string, unknown>;
      const id = `task-${state.taskCounter}`;
      state.taskCounter += 1;

      const task: CliTask = {
        id,
        goal: String(body.goal ?? "unknown"),
        status: "running",
        priority: "normal",
        triggerSource: "cli",
        deadline: null,
        preferredSurface: String(body.preferredSurface ?? "desktop"),
        workspaceId: null,
        traceId: `trace-${id}`,
        taskSpec: body,
        plan: [],
        result: null,
        error: null,
        createdAt: now,
        updatedAt: nowIso(),
        runtimeControl: {
          mode: "agent",
          reason: null,
          source: "cli",
          updatedAt: now
        },
        trace: {
          id: `trace-${id}`,
          status: "running",
          events: [{ message: "task.created", role: "planner", type: "task.created", createdAt: now }]
        }
      };

      state.lastTaskBody = body;
      state.tasks[id] = task;
      writeJson({ task }, 202);
      return;
    }

    if (parts[0] === "tasks" && parts[1] && method === "GET") {
      const taskId = parts[1];
      const task = state.tasks[taskId];
      if (!task) {
        writeJson({ error: "Task not found" }, 404);
        return;
      }

      state.taskPolls[taskId] = (state.taskPolls[taskId] ?? 0) + 1;
      const shouldCompleteTask = state.waitTaskId === null || state.waitTaskId === taskId;
      if (shouldCompleteTask && state.taskPolls[taskId] >= 2) {
        task.status = "completed";
        task.result = { outputs: { ok: true } };
        task.trace = {
          ...task.trace,
          status: "completed",
          events: [
            ...task.trace?.events,
            {
              message: "task.completed",
              role: "runtime",
              type: "task.completed",
              createdAt: nowIso()
            }
          ]
        };
      }

      writeJson({ task });
      return;
    }

    if (parts[0] === "tasks" && parts[1] && parts[2] === "control" && method === "POST") {
      const taskId = parts[1];
      const body = (await readBody()) as Record<string, unknown>;
      const task = state.tasks[taskId];
      if (!task) {
        writeJson({ error: "Task not found" }, 404);
        return;
      }

      state.lastControlBody = body;
      task.runtimeControl = { ...task.runtimeControl, mode: "paused", reason: "request", updatedAt: nowIso() };
      task.status = body.action === "pause" ? "interrupted" : task.status;
      writeJson({ task });
      return;
    }

    if (parts[0] === "tasks" && parts[1] && parts[2] === "teach-steps" && method === "POST") {
      const task = state.tasks[parts[1]];
      if (!task) {
        writeJson({ error: "Task not found" }, 404);
        return;
      }
      const body = (await readBody()) as Record<string, unknown>;
      state.lastTeachBody = body;
      task.trace = {
        ...task.trace,
        events: [
          ...task.trace?.events,
          { message: "teach step", role: "agent", type: "teach-step.recorded", createdAt: nowIso() }
        ]
      };
      writeJson({ task });
      return;
    }

    writeJson({ error: "not_found" }, 404);
  });

  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

test("cli run sends structured inputs and returns created task", async () => {
  const dataDir = await createTempDir("agentos-cli-");
  const api = await startCliApiFixture();
  const env = {
    ...process.env,
    AGENTOS_BASE_URL: api.baseUrl,
    AGENTOS_DATA_DIR: dataDir
  };

  try {
    const result = await execFileAsync(
      process.execPath,
      [
        "dist/bin/agentos.js",
        "run",
        "Prepare quarterly update",
        "--surface",
        "desktop",
        "--input",
        "target=planner",
        "--input",
        "note=a=statement",
        "--json"
      ],
      {
        cwd: process.cwd(),
        env
      }
    );
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.goal, "Prepare quarterly update");
    assert.equal(api.state.lastTaskBody?.goal, "Prepare quarterly update");
    assert.deepEqual(api.state.lastTaskBody?.inputs, { target: "planner", note: "a=statement" });
  } finally {
    await api.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("cli run --wait returns completed task when polling", async () => {
  const dataDir = await createTempDir("agentos-cli-");
  const api = await startCliApiFixture();
  const env = {
    ...process.env,
    AGENTOS_BASE_URL: api.baseUrl,
    AGENTOS_DATA_DIR: dataDir
  };

  try {
    const createResult = await execFileAsync(
      process.execPath,
      ["dist/bin/agentos.js", "run", "Wait until done", "--json", "--wait", "--timeout", "8000", "--surface", "desktop"],
      { cwd: process.cwd(), env }
    );
    const done = JSON.parse(createResult.stdout);
    assert.equal(done.status, "completed");
  } finally {
    await api.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("cli can run a natural-language goal directly without the run subcommand", async () => {
  const dataDir = await createTempDir("agentos-cli-");
  const api = await startCliApiFixture();
  const env = {
    ...process.env,
    AGENTOS_BASE_URL: api.baseUrl,
    AGENTOS_DATA_DIR: dataDir
  };

  try {
    const result = await execFileAsync(
      process.execPath,
      ["dist/bin/agentos.js", "Prepare quarterly update directly", "--surface", "desktop", "--json"],
      { cwd: process.cwd(), env }
    );
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "completed");
    assert.equal(api.state.lastTaskBody?.goal, "Prepare quarterly update directly");
    assert.equal(api.state.lastTaskBody?.preferredSurface, "desktop");
  } finally {
    await api.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("cli interactive shell accepts natural-language tasks with slash-command defaults", async () => {
  const dataDir = await createTempDir("agentos-cli-");
  const api = await startCliApiFixture();
  const env = {
    ...process.env,
    AGENTOS_BASE_URL: api.baseUrl,
    AGENTOS_DATA_DIR: dataDir
  };

  try {
    const session = await runCliSession(
      ["dist/bin/agentos.js"],
      "/surface browser\n/workspace cli-main\nPrepare the inbox summary\n/exit\n",
      env
    );

    assert.match(session.stdout, /AgentOS onboarding/);
    assert.match(session.stdout, /AgentOS interactive shell/);
    assert.match(session.stdout, /Default surface: browser/);
    assert.match(session.stdout, /Default workspace: cli-main/);
    assert.match(session.stdout, /COMPLETED task-1/);
    assert.equal(api.state.lastTaskBody?.goal, "Prepare the inbox summary");
    assert.equal(api.state.lastTaskBody?.preferredSurface, "browser");
    assert.equal(api.state.lastTaskBody?.workspaceName, "cli-main");
  } finally {
    await api.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("cli setup summarizes readiness and recommended next steps", async () => {
  const dataDir = await createTempDir("agentos-cli-");
  const api = await startCliApiFixture();
  const env = {
    ...process.env,
    AGENTOS_BASE_URL: api.baseUrl,
    AGENTOS_DATA_DIR: dataDir
  };

  try {
    const result = await execFileAsync(process.execPath, ["dist/bin/agentos.js", "setup"], {
      cwd: process.cwd(),
      env
    });

    assert.match(result.stdout, /AgentOS setup/);
    assert.match(result.stdout, /Status: needs attention/);
    assert.match(result.stdout, /Install source: source checkout or npm link/);
    assert.match(result.stdout, /Auto-start: not installed, launchd/);
    assert.match(result.stdout, /Recommended next steps:/);
    assert.match(result.stdout, /agentos setup --fix/);
    assert.match(result.stdout, /agentos packs ls/);
  } finally {
    await api.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("cli setup --json returns structured onboarding data", async () => {
  const dataDir = await createTempDir("agentos-cli-");
  const api = await startCliApiFixture();
  const env = {
    ...process.env,
    AGENTOS_BASE_URL: api.baseUrl,
    AGENTOS_DATA_DIR: dataDir
  };

  try {
    const result = await execFileAsync(process.execPath, ["dist/bin/agentos.js", "setup", "--json"], {
      cwd: process.cwd(),
      env
    });

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.startedDaemon, false);
    assert.equal(payload.daemon.running, true);
    assert.equal(payload.installSource.source, "source");
    assert.equal(payload.doctor.modelConfigured, false);
    assert.equal(payload.doctor.blockedLivePackCount, 2);
    assert.equal(Array.isArray(payload.recommendedActions), true);
    assert.equal(payload.recommendedActions.some((entry: string) => entry.includes("agentos setup --fix")), true);
    assert.equal(Array.isArray(payload.blockingIssues), true);
  } finally {
    await api.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("cli setup --fix --dry-run reports planned low-risk fixes", async () => {
  const dataDir = await createTempDir("agentos-cli-");
  const api = await startCliApiFixture();
  const env = {
    ...process.env,
    AGENTOS_BASE_URL: api.baseUrl,
    AGENTOS_DATA_DIR: dataDir
  };

  try {
    const result = await execFileAsync(process.execPath, ["dist/bin/agentos.js", "setup", "--fix", "--dry-run", "--json"], {
      cwd: process.cwd(),
      env
    });

    const payload = JSON.parse(result.stdout);
    assert.equal(Array.isArray(payload.plannedFixes), true);
    assert.equal(payload.plannedFixes.some((entry: string) => entry.includes("runtime directory")), true);
    assert.equal(payload.plannedFixes.some((entry: string) => entry.includes("auto-start")), true);
    assert.equal(Array.isArray(payload.appliedFixes), true);
    assert.equal(payload.appliedFixes.length, 0);
  } finally {
    await api.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("cli interactive shell exposes the /setup shortcut", async () => {
  const dataDir = await createTempDir("agentos-cli-");
  const api = await startCliApiFixture();
  const env = {
    ...process.env,
    AGENTOS_BASE_URL: api.baseUrl,
    AGENTOS_DATA_DIR: dataDir
  };

  try {
    const session = await runCliSession(["dist/bin/agentos.js"], "/setup\n/exit\n", env);
    assert.match(session.stdout, /AgentOS interactive shell/);
    assert.match(session.stdout, /AgentOS setup/);
    assert.match(session.stdout, /Recommended next steps:/);
  } finally {
    await api.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("cli uninstall --dry-run reports the planned cleanup steps", async () => {
  const dataDir = await createTempDir("agentos-cli-");
  const api = await startCliApiFixture();
  const env = {
    ...process.env,
    AGENTOS_BASE_URL: api.baseUrl,
    AGENTOS_DATA_DIR: dataDir
  };

  try {
    const result = await execFileAsync(
      process.execPath,
      ["dist/bin/agentos.js", "uninstall", "--purge", "--dry-run", "--json"],
      { cwd: process.cwd(), env }
    );

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.installSource.source, "source");
    assert.equal(payload.dryRun, true);
    assert.equal(Array.isArray(payload.plannedActions), true);
    assert.equal(payload.plannedActions.some((entry: string) => entry.includes("global `agentos` CLI link")), true);
    assert.equal(payload.plannedActions.some((entry: string) => entry.includes("Delete the data directory")), true);
  } finally {
    await api.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("cli ps --json lists queued tasks", async () => {
  const dataDir = await createTempDir("agentos-cli-");
  const api = await startCliApiFixture();
  const env = {
    ...process.env,
    AGENTOS_BASE_URL: api.baseUrl,
    AGENTOS_DATA_DIR: dataDir
  };

  try {
    const runResult = await execFileAsync(
      process.execPath,
      ["dist/bin/agentos.js", "run", "Track backlog", "--json", "--surface", "desktop"],
      { cwd: process.cwd(), env }
    );
    const created = JSON.parse(runResult.stdout);

    const psResult = await execFileAsync(process.execPath, ["dist/bin/agentos.js", "ps", "--json"], { cwd: process.cwd(), env });
    const tasks = JSON.parse(psResult.stdout);
    assert.equal(Array.isArray(tasks), true);
    assert.equal(tasks.some((task) => task.id === created.id), true);
  } finally {
    await api.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("cli inspect requires a task id", async () => {
  const dataDir = await createTempDir("agentos-cli-");
  const api = await startCliApiFixture();
  const env = {
    ...process.env,
    AGENTOS_BASE_URL: api.baseUrl,
    AGENTOS_DATA_DIR: dataDir
  };

  try {
    const error = await execFileAsync(process.execPath, ["dist/bin/agentos.js", "inspect", "--json"], {
      cwd: process.cwd(),
      env
    }).catch((cause) => cause as { stderr: string });
    assert.match(error.stderr, /inspect requires a task id/);
  } finally {
    await api.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("cli watch add requires a goal", async () => {
  const dataDir = await createTempDir("agentos-cli-");
  const api = await startCliApiFixture();
  const env = {
    ...process.env,
    AGENTOS_BASE_URL: api.baseUrl,
    AGENTOS_DATA_DIR: dataDir
  };

  try {
    const error = await execFileAsync(process.execPath, ["dist/bin/agentos.js", "watch", "add", "--json"], {
      cwd: process.cwd(),
      env
    }).catch((cause) => cause as { stderr: string });
    assert.match(error.stderr, /watch add requires a goal/);
  } finally {
    await api.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("cli watch add posts composed payload and exposes created watch", async () => {
  const dataDir = await createTempDir("agentos-cli-");
  const api = await startCliApiFixture();
  const env = {
    ...process.env,
    AGENTOS_BASE_URL: api.baseUrl,
    AGENTOS_DATA_DIR: dataDir
  };

  try {
    const addResult = await execFileAsync(
      process.execPath,
      [
        "dist/bin/agentos.js",
        "watch",
        "add",
        "Track incoming Slack mentions",
        "--pack",
        "cli-live",
        "--workspace",
        "cli-main",
        "--input",
        "mode=monitor",
        "--approval",
        "confirm_required",
        "--reply-policy",
        "approve_once_then_auto",
        "--reply-approval-window-ms",
        "120000",
        "--cooldown-ms",
        "60000",
        "--max-auto-actions-per-day",
        "2",
        "--max-consecutive-failures",
        "4",
        "--quiet-hours",
        "22-8",
        "--json"
      ],
      { cwd: process.cwd(), env }
    );

    const watch = JSON.parse(addResult.stdout);
    assert.equal(watch.status, "watching");
    assert.equal(watch.goal, "Track incoming Slack mentions");
    assert.equal(watch.preferredSurface, "desktop");
    assert.equal(watch.workspaceName, "cli-main");
    assert.equal(watch.livePack, "cli-live");
    assert.deepEqual(api.state.lastWatchBody?.inputs, { mode: "monitor" });
    assert.deepEqual(api.state.lastWatchBody?.governance, {
      approvalMode: "confirm_required",
      replyPolicy: "approve_once_then_auto",
      replyApprovalWindowMs: 120000,
      cooldownMs: 60000,
      maxAutoActionsPerDay: 2,
      maxConsecutiveFailures: 4,
      quietHours: {
        startHour: 22,
        endHour: 8
      }
    });
  } finally {
    await api.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("cli control posts the requested action", async () => {
  const dataDir = await createTempDir("agentos-cli-");
  const api = await startCliApiFixture();
  const env = {
    ...process.env,
    AGENTOS_BASE_URL: api.baseUrl,
    AGENTOS_DATA_DIR: dataDir
  };

  try {
    const runResult = await execFileAsync(
      process.execPath,
      ["dist/bin/agentos.js", "run", "Task for control", "--json", "--surface", "desktop"],
      { cwd: process.cwd(), env }
    );
    const created = JSON.parse(runResult.stdout);

    const controlResult = await execFileAsync(
      process.execPath,
      ["dist/bin/agentos.js", "control", created.id, "pause", "--json"],
      { cwd: process.cwd(), env }
    );
    const controlled = JSON.parse(controlResult.stdout);

    assert.equal(controlled.id, created.id);
    assert.equal(controlled.status, "interrupted");
    assert.equal(api.state.lastControlBody?.action, "pause");
  } finally {
    await api.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("cli logs prints trace events in plain mode and json mode returns raw events", async () => {
  const dataDir = await createTempDir("agentos-cli-");
  const api = await startCliApiFixture();
  const env = {
    ...process.env,
    AGENTOS_BASE_URL: api.baseUrl,
    AGENTOS_DATA_DIR: dataDir
  };

  try {
    const runResult = await execFileAsync(
      process.execPath,
      ["dist/bin/agentos.js", "run", "Task with trace", "--json", "--surface", "desktop"],
      { cwd: process.cwd(), env }
    );
    const created = JSON.parse(runResult.stdout);

    const plain = await execFileAsync(process.execPath, ["dist/bin/agentos.js", "logs", created.id], {
      cwd: process.cwd(),
      env
    });
    assert.match(plain.stdout, /task\.created/);

    const json = await execFileAsync(process.execPath, ["dist/bin/agentos.js", "logs", created.id, "--json"], {
      cwd: process.cwd(),
      env
    });
    const events = JSON.parse(json.stdout);
    assert.equal(Array.isArray(events), true);
    assert.equal(events[0].type, "task.created");
  } finally {
    await api.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("cli teach-step sends action payload to teach endpoint", async () => {
  const dataDir = await createTempDir("agentos-cli-");
  const api = await startCliApiFixture();
  const env = {
    ...process.env,
    AGENTOS_BASE_URL: api.baseUrl,
    AGENTOS_DATA_DIR: dataDir
  };

  try {
    const runResult = await execFileAsync(
      process.execPath,
      ["dist/bin/agentos.js", "run", "Task for teaching", "--json", "--surface", "desktop"],
      { cwd: process.cwd(), env }
    );
    const created = JSON.parse(runResult.stdout);

    const teachResult = await execFileAsync(
      process.execPath,
      [
        "dist/bin/agentos.js",
        "teach-step",
        created.id,
        "--action",
        "clickTarget",
        "--target",
        "submit-btn",
        "--text",
        "Submit now",
        "--url",
        "https://example.org",
        "--app",
        "DemoApp",
        "--surface",
        "browser",
        "--label",
        "Approve",
        "--json"
      ],
      { cwd: process.cwd(), env }
    );

    const taught = JSON.parse(teachResult.stdout);
    assert.equal(taught.id, created.id);
    assert.equal(api.state.lastTeachBody?.step?.action, "clickTarget");
    assert.equal(api.state.lastTeachBody?.step?.surface, "browser");
    assert.equal(api.state.lastTeachBody?.step?.label, "Approve");
    assert.equal(api.state.lastTeachBody?.step?.params?.targetQuery, "submit-btn");
    assert.equal(api.state.lastTeachBody?.step?.params?.text, "Submit now");
  } finally {
    await api.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("cli memory search enforces a query and learns route is reachable", async () => {
  const dataDir = await createTempDir("agentos-cli-");
  const api = await startCliApiFixture();
  const env = {
    ...process.env,
    AGENTOS_BASE_URL: api.baseUrl,
    AGENTOS_DATA_DIR: dataDir
  };

  try {
    const error = await execFileAsync(
      process.execPath,
      ["dist/bin/agentos.js", "memory", "search", "--json"],
      { cwd: process.cwd(), env }
    ).catch((cause) => cause as { stderr: string });

    assert.match(error.stderr, /memory search requires a query/);
  } finally {
    await api.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("cli watch teach requires a completed task id", async () => {
  const dataDir = await createTempDir("agentos-cli-");
  const api = await startCliApiFixture();
  const env = {
    ...process.env,
    AGENTOS_BASE_URL: api.baseUrl,
    AGENTOS_DATA_DIR: dataDir
  };

  try {
    const error = await execFileAsync(
      process.execPath,
      ["dist/bin/agentos.js", "watch", "teach", "--goal", "Follow up inbound", "--json"],
      { cwd: process.cwd(), env }
    ).catch((cause) => cause as { stderr: string });

    assert.match(error.stderr, /watch teach requires a completed task id/);
  } finally {
    await api.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("cli watch teach posts task payload and exposes created watch", async () => {
  const dataDir = await createTempDir("agentos-cli-");
  const api = await startCliApiFixture();
  const env = {
    ...process.env,
    AGENTOS_BASE_URL: api.baseUrl,
    AGENTOS_DATA_DIR: dataDir
  };

  try {
    const runResult = await execFileAsync(
      process.execPath,
      ["dist/bin/agentos.js", "run", "Completed source task", "--json", "--surface", "desktop"],
      { cwd: process.cwd(), env }
    );
    const created = JSON.parse(runResult.stdout);

    const teachResult = await execFileAsync(
      process.execPath,
      [
        "dist/bin/agentos.js",
        "watch",
        "teach",
        created.id,
        "Follow up new messages in inbox",
        "--pack",
        "cli-live",
        "--workspace",
        "cli-watch",
        "--json"
      ],
      { cwd: process.cwd(), env }
    );
    const watch = JSON.parse(teachResult.stdout);

    assert.equal(watch.status, "watching");
    assert.equal(watch.goal, "Follow up new messages in inbox");
    assert.equal(watch.livePack, "cli-live");
    assert.equal(watch.workspaceName, "cli-watch");
    assert.equal(api.state.lastWatchBody?.taskId, created.id);
  } finally {
    await api.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("cli watch ls/inspect/disable/enable/rm operate as expected", async () => {
  const dataDir = await createTempDir("agentos-cli-");
  const api = await startCliApiFixture();
  const env = {
    ...process.env,
    AGENTOS_BASE_URL: api.baseUrl,
    AGENTOS_DATA_DIR: dataDir
  };

  try {
    const addResult = await execFileAsync(
      process.execPath,
      [
        "dist/bin/agentos.js",
        "watch",
        "add",
        "Notify when reply is needed",
        "--pack",
        "cli-live",
        "--workspace",
        "cli-watch",
        "--json"
      ],
      { cwd: process.cwd(), env }
    );
    const created = JSON.parse(addResult.stdout);

    const lsResult = await execFileAsync(process.execPath, ["dist/bin/agentos.js", "watch", "ls", "--json"], {
      cwd: process.cwd(),
      env
    });
    const list = JSON.parse(lsResult.stdout);
    assert.equal(Array.isArray(list), true);
    assert.equal(list.some((watch) => watch.id === created.id), true);

    const inspectResult = await execFileAsync(
      process.execPath,
      ["dist/bin/agentos.js", "watch", "inspect", created.id, "--json"],
      { cwd: process.cwd(), env }
    );
    const inspect = JSON.parse(inspectResult.stdout);
    assert.equal(inspect.id, created.id);

    const disableResult = await execFileAsync(
      process.execPath,
      ["dist/bin/agentos.js", "watch", "disable", created.id, "--json"],
      { cwd: process.cwd(), env }
    );
    const disabled = JSON.parse(disableResult.stdout);
    assert.equal(disabled.status, "paused");

    const enableResult = await execFileAsync(
      process.execPath,
      ["dist/bin/agentos.js", "watch", "enable", created.id, "--json"],
      { cwd: process.cwd(), env }
    );
    const enabled = JSON.parse(enableResult.stdout);
    assert.equal(enabled.status, "watching");

    const retryResult = await execFileAsync(
      process.execPath,
      ["dist/bin/agentos.js", "watch", "retry", created.id, "--json"],
      { cwd: process.cwd(), env }
    );
    const retried = JSON.parse(retryResult.stdout);
    assert.equal(retried.status, "watching");

    const rmResult = await execFileAsync(
      process.execPath,
      ["dist/bin/agentos.js", "watch", "rm", created.id, "--json"],
      { cwd: process.cwd(), env }
    );
    const rm = JSON.parse(rmResult.stdout);
    assert.equal(rm.ok, true);
  } finally {
    await api.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
