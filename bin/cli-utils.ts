import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { resolveConfig } from "../src/config.js";
import { getDaemonInstallStatus, launchAgentPath } from "../src/daemon-autostart.js";
import {
  daemonLogPath,
  readDaemonRuntime,
  rotateDaemonLogs
} from "../src/daemon-state.js";
import type {
  DraftRecord,
  LivePackInfo,
  TaskSnapshot,
  WatchHealth,
  WatchRule
} from "../src/types/runtime-schema.js";
import type { DaemonStatus } from "../src/types/system.js";

export const config = resolveConfig();
export const distBinDir = path.dirname(fileURLToPath(import.meta.url));
export const distRoot = path.resolve(distBinDir, "..");
export const runtimeEntry = path.join(distRoot, "src/index.js");
const execFileAsync = promisify(execFile);

export type CliOptionScalar = string | boolean;
export type CliOptionValue = CliOptionScalar | CliOptionScalar[];
export type CliOptions = Record<string, CliOptionValue | undefined> & {
  json?: boolean;
  foreground?: boolean;
  timeout?: string | boolean;
};

export interface ParsedArgs {
  positionals: string[];
  options: CliOptions;
}

interface ErrorPayload {
  error?: string;
}

function toCamelCase(value: string) {
  return String(value)
    .replace(/^--/, "")
    .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: CliOptions = {};

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

export function listify(value: CliOptionValue | undefined): CliOptionScalar[] {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

export function parseInputs(value: CliOptionValue | undefined): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const entry of listify(value)) {
    const [key, ...rest] = String(entry).split("=");
    if (!key || !rest.length) {
      continue;
    }
    inputs[key] = rest.join("=");
  }
  return inputs;
}

export function boolOption(value: CliOptionValue | undefined): boolean {
  if (Array.isArray(value)) {
    return boolOption(value.at(-1));
  }
  if (value === true) {
    return true;
  }
  if (value == null) {
    return false;
  }
  return !["false", "0", "no"].includes(String(value).toLowerCase());
}

export function baseUrl() {
  return process.env.AGENTOS_BASE_URL ?? `http://127.0.0.1:${config.port}`;
}

export function isRemoteControlPlaneMode() {
  return Boolean(process.env.AGENTOS_BASE_URL);
}

export async function apiRequest<TResponse extends object>(
  method: string,
  pathname: string,
  body: unknown = null
): Promise<TResponse> {
  const response = await fetch(`${baseUrl()}${pathname}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  }).catch((error) => {
    throw new Error(`Failed to reach AgentOS at ${baseUrl()}: ${error.message}`);
  });

  const payload = (await response.json().catch(() => ({}))) as TResponse & ErrorPayload;
  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }

  return payload;
}

export function print(data: unknown, options: CliOptions = {}) {
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

export function formatTask(task: Pick<TaskSnapshot, "id" | "status" | "goal">) {
  return `${task.id}  ${task.status.padEnd(11)}  ${task.goal}`;
}

export function formatWatch(
  rule: Pick<WatchRule, "id" | "status" | "goal" | "livePack"> & {
    health?: WatchHealth | null;
  }
) {
  const health = rule.health?.state ? String(rule.health.state).padEnd(9) : "n/a".padEnd(9);
  return `${rule.id}  ${String(rule.status).padEnd(18)}  ${health}  ${rule.livePack.padEnd(20)}  ${rule.goal}`;
}

export function formatPack(pack: LivePackInfo) {
  const health = pack.ready === false ? "blocked" : pack.healthChecks?.some((check) => check.status === "warning") ? "warn" : "ready";
  return `${pack.name.padEnd(20)}  ${String(pack.category ?? pack.family).padEnd(13)}  ${pack.surface.padEnd(7)}  ${health.padEnd(7)}  ${pack.description}`;
}

export function formatDraft(draft: Pick<DraftRecord, "id" | "status" | "livePack" | "summary">) {
  return `${draft.id}  ${String(draft.status).padEnd(9)}  ${String(draft.livePack ?? "-").padEnd(20)}  ${draft.summary ?? "(no summary)"}`;
}

export async function waitForTask(taskId: string, timeoutMs = 30000): Promise<TaskSnapshot> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const payload = await apiRequest<{ task: TaskSnapshot }>("GET", `/tasks/${taskId}`);
    if (["completed", "failed", "blocked", "interrupted"].includes(payload.task.status)) {
      return payload.task;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for task ${taskId}`);
}

export async function waitForDaemon(timeoutMs = 10000): Promise<DaemonStatus> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return await fetchDaemonStatus();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("Timed out waiting for the daemon to start.");
}

export async function fetchDaemonStatus(): Promise<DaemonStatus> {
  const payload = await apiRequest<{ daemon: DaemonStatus }>("GET", "/daemon/status");
  return payload.daemon;
}

async function startDetachedDaemon(): Promise<DaemonStatus> {
  const runtime = await readDaemonRuntime(config.daemonDir);
  if (runtime.running && runtime.state?.pid) {
    const runningPort = runtime.state.port ? ` on port ${runtime.state.port}` : "";
    throw new Error(`AgentOS daemon is already running with pid ${runtime.state.pid}${runningPort}.`);
  }

  await fsp.mkdir(config.daemonDir, { recursive: true });
  await rotateDaemonLogs(config.daemonDir);
  const logPath = daemonLogPath(config.daemonDir);
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
  return waitForDaemon();
}

export async function restartLocalDaemon(timeoutMs = 10000): Promise<{
  restarted: boolean;
  daemon: DaemonStatus | null;
}> {
  const runtime = await readDaemonRuntime(config.daemonDir);
  if (!runtime.running || !runtime.state?.pid) {
    return { restarted: false, daemon: null };
  }

  process.kill(Number(runtime.state.pid), "SIGTERM");
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = await readDaemonRuntime(config.daemonDir);
    if (!current.running) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return {
    restarted: true,
    daemon: await startDetachedDaemon()
  };
}

export async function ensureDaemonRunning(options: CliOptions = {}): Promise<{
  daemon: DaemonStatus;
  startedDaemon: boolean;
}> {
  try {
    return {
      daemon: await fetchDaemonStatus(),
      startedDaemon: false
    };
  } catch (error) {
    if (process.env.AGENTOS_BASE_URL) {
      throw error;
    }

    return {
      daemon: await startDetachedDaemon(),
      startedDaemon: true
    };
  }
}

export async function daemonStatus(options: CliOptions) {
  try {
    const daemon = await fetchDaemonStatus();
    print(daemon, options);
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

export async function daemonStart(options: CliOptions) {
  try {
    const daemon = await fetchDaemonStatus();
    print(options.json ? daemon : `AgentOS daemon already running on port ${daemon.port}.`, options);
    return;
  } catch {}

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

  const daemon = await startDetachedDaemon();
  print(options.json ? daemon : `Started AgentOS daemon on http://127.0.0.1:${daemon.port}`, options);
}

export async function stopDaemonProcess() {
  const runtime = await readDaemonRuntime(config.daemonDir);
  if (!runtime.running || !runtime.state?.pid) {
    return { stopped: false, reason: "not_running" as const };
  }

  process.kill(Number(runtime.state.pid), "SIGTERM");
  return { stopped: true, pid: Number(runtime.state.pid) };
}

export async function daemonStop(options: CliOptions) {
  const result = await stopDaemonProcess();
  if (!result.stopped) {
    print(options.json ? result : "AgentOS daemon is not running.", options);
    return;
  }
  print(options.json ? result : "Stopping AgentOS daemon.", options);
}

export async function daemonRestart(options: CliOptions) {
  const restarted = await restartLocalDaemon(Number(options.timeout ?? 10000));
  if (restarted.restarted) {
    print(
      options.json
        ? restarted.daemon
        : `Restarted AgentOS daemon on http://127.0.0.1:${restarted.daemon?.port ?? config.port}`,
      options
    );
    return;
  }

  await daemonStart(options);
}

export async function daemonLogs(options: CliOptions) {
  const logPath = daemonLogPath(config.daemonDir);
  const content = await fsp.readFile(logPath, "utf8").catch(() => "");
  print(options.json ? { logPath, content } : content || "No daemon log found yet.", options);
}

export async function installDaemonAutostart() {
  if (process.platform === "darwin") {
    const plistPath = launchAgentPath();
    const workingDirectory = path.resolve(distRoot, "..");
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
  <string>${workingDirectory}</string>
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
    const uid = process.getuid?.();
    if (uid != null) {
      const domain = `gui/${uid}`;
      await execFileAsync("launchctl", ["bootout", domain, plistPath]).catch(() => {});
      await execFileAsync("launchctl", ["bootstrap", domain, plistPath]);
      await execFileAsync("launchctl", ["enable", `${domain}/com.agentos.daemon`]).catch(() => {});
      await execFileAsync("launchctl", ["kickstart", "-k", `${domain}/com.agentos.daemon`]).catch(() => {});
    }
    const install = await getDaemonInstallStatus();
    return { installed: true, path: plistPath, install };
  }

  if (process.platform === "win32") {
    const taskCommand = `"${process.execPath}" "${runtimeEntry}"`;
    await execFileAsync("schtasks", ["/Create", "/SC", "ONLOGON", "/TN", "AgentOS", "/TR", taskCommand, "/F"]);
    const install = await getDaemonInstallStatus();
    return {
      installed: true,
      command: `schtasks /Create /SC ONLOGON /TN AgentOS /TR "${taskCommand}" /F`,
      install
    };
  }

  throw new Error("Auto-install is only implemented for macOS and Windows.");
}

export async function daemonInstall(options: CliOptions) {
  const result = await installDaemonAutostart();
  print(
    options.json
      ? result
      : process.platform === "darwin"
        ? `Installed launchd agent at ${String(result.path ?? "")}`
        : "Installed the AgentOS Task Scheduler entry.",
    options
  );
}

export async function uninstallDaemonAutostart() {
  if (process.platform === "darwin") {
    const plistPath = launchAgentPath();
    const uid = process.getuid?.();
    if (uid != null) {
      await execFileAsync("launchctl", ["bootout", `gui/${uid}`, plistPath]).catch(() => {});
    }
    await fsp.rm(plistPath, { force: true }).catch(() => {});
    return { removed: true, path: plistPath };
  }

  if (process.platform === "win32") {
    await execFileAsync("schtasks", ["/Delete", "/TN", "AgentOS", "/F"]).catch(() => {});
    return { removed: true, command: "schtasks /Delete /TN AgentOS /F" };
  }

  throw new Error("Auto-uninstall is only implemented for macOS and Windows.");
}

export async function daemonUninstall(options: CliOptions) {
  const result = await uninstallDaemonAutostart();
  print(
    options.json
      ? result
      : process.platform === "darwin"
        ? `Removed ${String(result.path ?? "")}`
        : "Removed the AgentOS Task Scheduler entry.",
    options
  );
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export async function unlinkGlobalCli() {
  try {
    await execFileAsync(npmCommand(), ["unlink", "-g", "agentos"]);
    return { removed: true };
  } catch (error) {
    return {
      removed: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}
