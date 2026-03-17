import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_LOG_MAX_BYTES = Number(process.env.AGENTOS_DAEMON_LOG_MAX_BYTES ?? 1024 * 1024);
const DEFAULT_LOG_BACKUPS = Number(process.env.AGENTOS_DAEMON_LOG_BACKUPS ?? 5);

export interface DaemonStateSnapshot {
  pid?: number;
  port?: number | string;
  [key: string]: unknown;
}

export interface DaemonRuntime {
  running: boolean;
  state: DaemonStateSnapshot | null;
}

function pidFile(daemonDir: string): string {
  return path.join(daemonDir, "daemon.pid");
}

function portFile(daemonDir: string): string {
  return path.join(daemonDir, "daemon.port");
}

function stateFile(daemonDir: string): string {
  return path.join(daemonDir, "state.json");
}

export function daemonLogPath(daemonDir: string): string {
  return path.join(daemonDir, "daemon.log");
}

export function daemonLogPaths(daemonDir: string, backups = DEFAULT_LOG_BACKUPS): string[] {
  return [
    daemonLogPath(daemonDir),
    ...Array.from({ length: backups }, (_, index) => `${daemonLogPath(daemonDir)}.${index + 1}`)
  ];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function isProcessAlive(pid?: number | null): boolean {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function writeDaemonState(
  daemonDir: string,
  state: DaemonStateSnapshot
): Promise<void> {
  await fs.mkdir(daemonDir, { recursive: true });
  await Promise.all([
    fs.writeFile(pidFile(daemonDir), String(state.pid ?? process.pid), "utf8"),
    fs.writeFile(portFile(daemonDir), String(state.port ?? ""), "utf8"),
    fs.writeFile(stateFile(daemonDir), JSON.stringify(state, null, 2), "utf8")
  ]);
}

export async function readDaemonState(
  daemonDir: string
): Promise<DaemonStateSnapshot | null> {
  if (!(await fileExists(stateFile(daemonDir)))) {
    return null;
  }

  try {
    const raw = await fs.readFile(stateFile(daemonDir), "utf8");
    return JSON.parse(raw) as DaemonStateSnapshot;
  } catch {
    return null;
  }
}

export async function clearDaemonState(daemonDir: string): Promise<void> {
  await Promise.all(
    [pidFile(daemonDir), portFile(daemonDir), stateFile(daemonDir)].map(
      (filePath) => fs.rm(filePath, { force: true }).catch(() => {})
    )
  );
}

export async function rotateDaemonLogs(
  daemonDir: string,
  {
    maxBytes = DEFAULT_LOG_MAX_BYTES,
    backups = DEFAULT_LOG_BACKUPS
  }: {
    maxBytes?: number;
    backups?: number;
  } = {}
): Promise<void> {
  const logPath = daemonLogPath(daemonDir);
  try {
    const stat = await fs.stat(logPath);
    if (stat.size < maxBytes) {
      return;
    }
  } catch {
    return;
  }

  for (let index = backups; index >= 1; index -= 1) {
    const current = `${logPath}.${index}`;
    const next = `${logPath}.${index + 1}`;
    if (index === backups) {
      await fs.rm(current, { force: true }).catch(() => {});
      continue;
    }
    await fs.rename(current, next).catch(() => {});
  }

  await fs.rename(logPath, `${logPath}.1`).catch(() => {});
}

export async function appendDaemonMarker(
  daemonDir: string,
  marker: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await fs.mkdir(daemonDir, { recursive: true });
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    marker,
    ...metadata
  });
  await fs.appendFile(daemonLogPath(daemonDir), `${line}\n`, "utf8");
}

export async function readDaemonLogTail(
  daemonDir: string,
  maxBytes = 64 * 1024
): Promise<string> {
  try {
    const content = await fs.readFile(daemonLogPath(daemonDir), "utf8");
    return content.slice(-maxBytes);
  } catch {
    return "";
  }
}

export async function readDaemonRuntime(
  daemonDir: string
): Promise<DaemonRuntime> {
  const state = await readDaemonState(daemonDir);
  if (!state) {
    return {
      running: false,
      state: null
    };
  }

  const running = isProcessAlive(Number(state.pid));
  if (!running) {
    await clearDaemonState(daemonDir);
  }

  return {
    running,
    state: running ? state : null
  };
}
