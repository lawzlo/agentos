import fs from "node:fs/promises";
import path from "node:path";

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
