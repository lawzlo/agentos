#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveConfig } from "../src/config.js";
import { daemonLogPath, readDaemonRuntime } from "../src/daemon-state.js";

const config = resolveConfig();
const distBinDir = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(distBinDir, "..");
const runtimeEntry = path.join(distRoot, "src/index.js");

function toCamelCase(value) {
  return String(value)
    .replace(/^--/, "")
    .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function parseArgs(argv) {
  const positionals = [];
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith("--")) {
      positionals.push(entry);
      continue;
    }

    const key = toCamelCase(entry);
    const next = argv[index + 1];
    const value = next && !next.startsWith("--") ? next : true;
    if (value !== true) {
      index += 1;
    }

    if (options[key] == null) {
      options[key] = value;
    } else if (Array.isArray(options[key])) {
      options[key].push(value);
    } else {
      options[key] = [options[key], value];
    }
  }

  return { positionals, options };
}

function listify(value) {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function parseInputs(value) {
  const inputs = {};
  for (const entry of listify(value)) {
    const [key, ...rest] = String(entry).split("=");
    if (!key || !rest.length) {
      continue;
    }
    inputs[key] = rest.join("=");
  }
  return inputs;
}

function boolOption(value) {
  if (value === true) {
    return true;
  }
  if (value == null) {
    return false;
  }
  return !["false", "0", "no"].includes(String(value).toLowerCase());
}

function baseUrl() {
  return process.env.AGENTOS_BASE_URL ?? `http://127.0.0.1:${config.port}`;
}

async function apiRequest(method, pathname, body = null) {
  const response = await fetch(`${baseUrl()}${pathname}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  }).catch((error) => {
    throw new Error(`Failed to reach AgentOS at ${baseUrl()}: ${error.message}`);
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }

  return payload;
}

function print(data: unknown, options: Record<string, any> = {}) {
  if (options.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (typeof data === "string") {
    console.log(data);
    return;
  }

  console.log(JSON.stringify(data, null, 2));
}

function formatTask(task) {
  return `${task.id}  ${task.status.padEnd(11)}  ${task.goal}`;
}

function formatWatch(rule) {
  return `${rule.id}  ${String(rule.status).padEnd(10)}  ${rule.livePack.padEnd(20)}  ${rule.goal}`;
}

async function waitForTask(taskId, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const payload = await apiRequest("GET", `/tasks/${taskId}`);
    if (["completed", "failed", "blocked", "interrupted"].includes(payload.task.status)) {
      return payload.task;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for task ${taskId}`);
}

async function waitForDaemon(timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const payload = await apiRequest("GET", "/daemon/status");
      return payload.daemon;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("Timed out waiting for the daemon to start.");
}

async function daemonStatus(options) {
  try {
    const payload = await apiRequest("GET", "/daemon/status");
    print(payload.daemon, options);
    return;
  } catch {}

  const runtime = await readDaemonRuntime(config.daemonDir);
  if (!runtime.running) {
    print(options.json ? { running: false } : "AgentOS daemon is not running.", options);
    return;
  }

  print(
    {
      running: true,
      ...(runtime.state ?? {})
    },
    options
  );
}

async function daemonStart(options) {
  try {
    const payload = await apiRequest("GET", "/daemon/status");
    print(options.json ? payload.daemon : `AgentOS daemon already running on port ${payload.daemon.port}.`, options);
    return;
  } catch {}

  await fsp.mkdir(config.daemonDir, { recursive: true });
  const logPath = daemonLogPath(config.daemonDir);

  if (boolOption(options.foreground)) {
    const child = spawn(process.execPath, [runtimeEntry], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(config.port),
        AGENTOS_DATA_DIR: config.dataDir
      },
      stdio: "inherit"
    });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  const out = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, [runtimeEntry], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(config.port),
      AGENTOS_DATA_DIR: config.dataDir
    },
    detached: true,
    stdio: ["ignore", out, out]
  });
  child.unref();

  const daemon = await waitForDaemon();
  print(options.json ? daemon : `Started AgentOS daemon on http://127.0.0.1:${daemon.port}`, options);
}

async function daemonStop(options) {
  const runtime = await readDaemonRuntime(config.daemonDir);
  if (!runtime.running || !runtime.state?.pid) {
    print(options.json ? { stopped: false, reason: "not_running" } : "AgentOS daemon is not running.", options);
    return;
  }

  process.kill(Number(runtime.state.pid), "SIGTERM");
  print(options.json ? { stopped: true, pid: Number(runtime.state.pid) } : "Stopping AgentOS daemon.", options);
}

async function daemonLogs(options) {
  const logPath = daemonLogPath(config.daemonDir);
  const content = await fsp.readFile(logPath, "utf8").catch(() => "");
  print(options.json ? { logPath, content } : content || "No daemon log found yet.", options);
}

function launchAgentPath() {
  return path.join(os.homedir(), "Library/LaunchAgents", "com.agentos.daemon.plist");
}

async function daemonInstall(options) {
  if (process.platform === "darwin") {
    const plistPath = launchAgentPath();
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.agentos.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${runtimeEntry}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENTOS_DATA_DIR</key>
    <string>${config.dataDir}</string>
    <key>PORT</key>
    <string>${config.port}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${process.cwd()}</string>
  <key>StandardOutPath</key>
  <string>${daemonLogPath(config.daemonDir)}</string>
  <key>StandardErrorPath</key>
  <string>${daemonLogPath(config.daemonDir)}</string>
</dict>
</plist>
`;
    await fsp.mkdir(path.dirname(plistPath), { recursive: true });
    await fsp.mkdir(config.daemonDir, { recursive: true });
    await fsp.writeFile(plistPath, plist, "utf8");
    print(options.json ? { installed: true, path: plistPath } : `Installed launchd agent at ${plistPath}`, options);
    return;
  }

  if (process.platform === "win32") {
    print(
      options.json
        ? {
            installed: true,
            command: `schtasks /Create /SC ONLOGON /TN AgentOS /TR "\\"${process.execPath}\\" \\"${runtimeEntry}\\"" /F`
          }
        : "Windows auto-start is configured through Task Scheduler. Run the generated command manually on Windows.",
      options
    );
    return;
  }

  throw new Error("Auto-install is only implemented for macOS and Windows.");
}

async function daemonUninstall(options) {
  if (process.platform === "darwin") {
    const plistPath = launchAgentPath();
    await fsp.rm(plistPath, { force: true }).catch(() => {});
    print(options.json ? { removed: true, path: plistPath } : `Removed ${plistPath}`, options);
    return;
  }

  if (process.platform === "win32") {
    print(
      options.json ? { removed: true, command: "schtasks /Delete /TN AgentOS /F" } : "Remove the Task Scheduler entry on Windows with: schtasks /Delete /TN AgentOS /F",
      options
    );
    return;
  }

  throw new Error("Auto-uninstall is only implemented for macOS and Windows.");
}

async function commandRun(positionals, options) {
  const goal = positionals.join(" ").trim();
  if (!goal) {
    throw new Error("run requires a goal");
  }

  const taskPayload = {
    goal,
    preferredSurface: options.surface,
    workspaceName: options.workspace,
    skillName: options.skill,
    executionMode: options.mode,
    inputs: parseInputs(options.input)
  };
  const response = await apiRequest("POST", "/tasks", taskPayload);

  if (boolOption(options.wait)) {
    const task = await waitForTask(response.task.id, Number(options.timeout ?? 30000));
    print(task, options);
    return;
  }

  print(options.json ? response.task : `Queued ${response.task.id}`, options);
}

async function commandPs(options) {
  const payload = await apiRequest("GET", `/tasks?limit=${Number(options.limit ?? 20)}`);
  if (options.json) {
    print(payload.tasks, options);
    return;
  }
  console.log(payload.tasks.map(formatTask).join("\n") || "No tasks found.");
}

async function commandInspect(taskId, options) {
  if (!taskId) {
    throw new Error("inspect requires a task id");
  }
  const payload = await apiRequest("GET", `/tasks/${taskId}`);
  print(payload.task, options);
}

async function commandLogs(taskId, options) {
  if (!taskId) {
    throw new Error("logs requires a task id");
  }
  const payload = await apiRequest("GET", `/tasks/${taskId}`);
  const events = payload.task.trace?.events ?? [];
  if (options.json) {
    print(events, options);
    return;
  }
  console.log(
    events.map((event) => `${event.createdAt}  ${event.role}/${event.type}  ${event.message}`).join("\n") ||
      "No trace events yet."
  );
}

async function commandControl(positionals, options) {
  const [taskId, action] = positionals;
  if (!taskId || !action) {
    throw new Error("control requires <task-id> and an action");
  }

  const payload = await apiRequest("POST", `/tasks/${taskId}/control`, {
    action,
    note: options.note ?? null,
    reason: options.reason ?? null
  });
  print(payload.task, options);
}

async function commandTeachStep(positionals, options) {
  const [taskId] = positionals;
  if (!taskId || !options.action) {
    throw new Error("teach-step requires <task-id> and --action");
  }

  const params: Record<string, any> = {};
  if (options.target) {
    params.targetQuery = options.target;
  }
  if (options.text) {
    params.text = options.text;
  }
  if (options.url) {
    params.url = options.url;
  }
  if (options.app) {
    params.name = options.app;
  }

  const payload = await apiRequest("POST", `/tasks/${taskId}/teach-steps`, {
    step: {
      action: options.action,
      surface: options.surface,
      label: options.label,
      params
    }
  });
  print(payload.task, options);
}

async function commandWatch(subcommand, positionals, options) {
  if (subcommand === "add") {
    const goal = positionals.join(" ").trim();
    if (!goal) {
      throw new Error("watch add requires a goal");
    }

    const payload = await apiRequest("POST", "/watches", {
      goal,
      preferredSurface: options.surface,
      workspaceName: options.workspace,
      skillName: options.skill,
      appTarget: options.app,
      livePack: options.pack,
      pollIntervalMs: options.interval ? Number(options.interval) : undefined,
      inputs: parseInputs(options.input)
    });
    print(payload.watch, options);
    return;
  }

  if (subcommand === "teach") {
    const [taskId, ...goalParts] = positionals;
    if (!taskId) {
      throw new Error("watch teach requires a completed task id");
    }

    const payload = await apiRequest("POST", "/watches/from-task", {
      taskId,
      watchRuleId: options.watch ?? null,
      goal: goalParts.join(" ").trim() || undefined,
      preferredSurface: options.surface,
      workspaceName: options.workspace,
      skillName: options.skill,
      appTarget: options.app,
      livePack: options.pack,
      pollIntervalMs: options.interval ? Number(options.interval) : undefined,
      enabled: options.enabled == null ? true : boolOption(options.enabled),
      triggerTexts: listify(options.trigger)
    });
    print(payload.watch, options);
    return;
  }

  if (subcommand === "ls") {
    const payload = await apiRequest("GET", "/watches");
    if (options.json) {
      print(payload.watches, options);
      return;
    }
    console.log(payload.watches.map(formatWatch).join("\n") || "No watch rules found.");
    return;
  }

  if (subcommand === "inspect") {
    const [watchId] = positionals;
    const payload = await apiRequest("GET", `/watches/${watchId}`);
    print(payload.watch, options);
    return;
  }

  if (subcommand === "enable" || subcommand === "disable") {
    const [watchId] = positionals;
    const payload = await apiRequest("POST", `/watches/${watchId}/${subcommand}`);
    print(payload.watch, options);
    return;
  }

  if (subcommand === "rm") {
    const [watchId] = positionals;
    const payload = await apiRequest("DELETE", `/watches/${watchId}`);
    print(payload, options);
    return;
  }

  throw new Error(`Unsupported watch command: ${subcommand}`);
}

async function commandSkills(subcommand, positionals, options) {
  if (subcommand === "ls") {
    const payload = await apiRequest("GET", "/skills");
    if (options.json) {
      print(payload.skills, options);
      return;
    }
    console.log(payload.skills.map((skill) => `${skill.name}  ${skill.surfaceScope}`).join("\n") || "No skills found.");
    return;
  }

  if (subcommand === "inspect") {
    const [name] = positionals;
    const payload = await apiRequest("GET", `/skills/${encodeURIComponent(name)}`);
    print(payload.skill, options);
    return;
  }

  if (subcommand === "run") {
    const [name, ...goalParts] = positionals;
    const response = await apiRequest("POST", "/tasks", {
      goal: goalParts.join(" ").trim() || `Run ${name}`,
      skillName: name,
      preferredSurface: options.surface,
      workspaceName: options.workspace,
      inputs: parseInputs(options.input)
    });
    if (boolOption(options.wait)) {
      const task = await waitForTask(response.task.id, Number(options.timeout ?? 30000));
      print(task, options);
      return;
    }
    print(response.task, options);
    return;
  }

  throw new Error(`Unsupported skills command: ${subcommand}`);
}

async function main() {
  const [command, subcommand, ...rest] = process.argv.slice(2);
  const { positionals, options } = parseArgs(rest) as {
    positionals: string[];
    options: Record<string, any>;
  };
  const json = boolOption(options.json);
  const sharedOptions: Record<string, any> = {
    ...options,
    json
  };

  if (!command || command === "help" || command === "--help") {
    print(
      `agentos daemon start|stop|status|logs|install|uninstall
agentos run "<goal>" [--surface browser|desktop] [--workspace name] [--skill name] [--input key=value] [--wait]
agentos ps [--limit 20]
agentos inspect <task-id>
agentos logs <task-id>
agentos control <task-id> pause|resume|takeover|request_takeover|return|return_to_agent|stop [--note "..."]
agentos teach-step <task-id> --action clickTarget [--target "..."] [--text "..."] [--surface browser|desktop]
agentos watch add "<goal>" [--pack live-pack] [--skill name] [--workspace name] [--input key=value]
agentos watch teach <task-id> "<goal>" [--watch id] [--pack live-pack] [--workspace name]
agentos watch ls|inspect|enable|disable|rm
agentos skills ls|inspect|run`,
      sharedOptions
    );
    return;
  }

  if (command === "daemon") {
    if (subcommand === "start") {
      await daemonStart(sharedOptions);
      return;
    }
    if (subcommand === "stop") {
      await daemonStop(sharedOptions);
      return;
    }
    if (subcommand === "status") {
      await daemonStatus(sharedOptions);
      return;
    }
    if (subcommand === "logs") {
      await daemonLogs(sharedOptions);
      return;
    }
    if (subcommand === "install") {
      await daemonInstall(sharedOptions);
      return;
    }
    if (subcommand === "uninstall") {
      await daemonUninstall(sharedOptions);
      return;
    }
    throw new Error(`Unsupported daemon command: ${subcommand ?? "(none)"}`);
  }

  if (command === "run") {
    await commandRun([subcommand, ...positionals].filter(Boolean), sharedOptions);
    return;
  }

  if (command === "ps") {
    await commandPs(sharedOptions);
    return;
  }

  if (command === "inspect") {
    await commandInspect(subcommand, sharedOptions);
    return;
  }

  if (command === "logs") {
    await commandLogs(subcommand, sharedOptions);
    return;
  }

  if (command === "control") {
    await commandControl([subcommand, ...positionals], sharedOptions);
    return;
  }

  if (command === "teach-step") {
    await commandTeachStep([subcommand, ...positionals], sharedOptions);
    return;
  }

  if (command === "watch") {
    await commandWatch(subcommand, positionals, sharedOptions);
    return;
  }

  if (command === "skills") {
    await commandSkills(subcommand, positionals, sharedOptions);
    return;
  }

  throw new Error(`Unsupported command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
