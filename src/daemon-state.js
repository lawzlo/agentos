import fs from "node:fs/promises";
import path from "node:path";

function pidFile(daemonDir) {
  return path.join(daemonDir, "daemon.pid");
}

function portFile(daemonDir) {
  return path.join(daemonDir, "daemon.port");
}

function stateFile(daemonDir) {
  return path.join(daemonDir, "state.json");
}

export function daemonLogPath(daemonDir) {
  return path.join(daemonDir, "daemon.log");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function isProcessAlive(pid) {
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

export async function writeDaemonState(daemonDir, state) {
  await fs.mkdir(daemonDir, { recursive: true });
  await Promise.all([
    fs.writeFile(pidFile(daemonDir), String(state.pid ?? process.pid), "utf8"),
    fs.writeFile(portFile(daemonDir), String(state.port ?? ""), "utf8"),
    fs.writeFile(stateFile(daemonDir), JSON.stringify(state, null, 2), "utf8")
  ]);
}

export async function readDaemonState(daemonDir) {
  if (!(await fileExists(stateFile(daemonDir)))) {
    return null;
  }

  try {
    const raw = await fs.readFile(stateFile(daemonDir), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function clearDaemonState(daemonDir) {
  await Promise.all(
    [pidFile(daemonDir), portFile(daemonDir), stateFile(daemonDir)].map((filePath) =>
      fs.rm(filePath, { force: true }).catch(() => {})
    )
  );
}

export async function readDaemonRuntime(daemonDir) {
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
