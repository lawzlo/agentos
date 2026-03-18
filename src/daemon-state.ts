import fs from "node:fs/promises";
import path from "node:path";

import type {
  DaemonLifecycle,
  DaemonPreviousExit,
  DaemonStartupRecovery
} from "./types/system.js";

const DEFAULT_LOG_MAX_BYTES = Number(process.env.AGENTOS_DAEMON_LOG_MAX_BYTES ?? 1024 * 1024);
const DEFAULT_LOG_BACKUPS = Number(process.env.AGENTOS_DAEMON_LOG_BACKUPS ?? 5);

export interface DaemonStateSnapshot {
  pid?: number;
  port?: number | string;
  lifecycle?: DaemonLifecycle | null;
  startupRecovery?: DaemonStartupRecovery | null;
  [key: string]: unknown;
}

export interface DaemonRuntime {
  running: boolean;
  state: DaemonStateSnapshot | null;
  staleState?: DaemonStateSnapshot | null;
}

interface DaemonMarkerRecord {
  timestamp?: string;
  marker: string;
  reason?: unknown;
  type?: unknown;
  message?: unknown;
  [key: string]: unknown;
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

function parseDaemonMarkerLine(line: string): DaemonMarkerRecord | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || typeof parsed.marker !== "string") {
      return null;
    }
    return parsed as DaemonMarkerRecord;
  } catch {
    return null;
  }
}

export async function readRecentDaemonMarkers(
  daemonDir: string,
  limit = 20
): Promise<DaemonMarkerRecord[]> {
  const tail = await readDaemonLogTail(daemonDir);
  return tail
    .split(/\r?\n/)
    .map(parseDaemonMarkerLine)
    .filter((entry): entry is DaemonMarkerRecord => Boolean(entry))
    .slice(-limit);
}

export async function readLatestDaemonMarker(
  daemonDir: string,
  allowedMarkers = ["daemon.stopped", "daemon.crash", "daemon.started"]
): Promise<DaemonMarkerRecord | null> {
  const allowed = new Set(allowedMarkers);
  const markers = await readRecentDaemonMarkers(daemonDir);
  for (let index = markers.length - 1; index >= 0; index -= 1) {
    const candidate = markers[index];
    if (allowed.has(candidate.marker)) {
      return candidate;
    }
  }
  return null;
}

function markerReason(marker: DaemonMarkerRecord | null): string | null {
  if (!marker) {
    return null;
  }

  if (typeof marker.reason === "string" && marker.reason.trim()) {
    return marker.reason;
  }

  const type = typeof marker.type === "string" && marker.type.trim() ? marker.type : null;
  const message = typeof marker.message === "string" && marker.message.trim() ? marker.message : null;
  if (type && message) {
    return `${type}: ${message}`;
  }
  return message ?? type;
}

export async function inferDaemonPreviousExit(
  daemonDir: string,
  { staleState = null }: { staleState?: DaemonStateSnapshot | null } = {}
): Promise<DaemonPreviousExit> {
  const marker = await readLatestDaemonMarker(daemonDir);
  if (staleState) {
    if (marker?.marker === "daemon.crash") {
      return {
        kind: "crash",
        clean: false,
        marker: marker.marker,
        timestamp: typeof marker.timestamp === "string" ? marker.timestamp : null,
        reason: markerReason(marker)
      };
    }

    if (marker?.marker === "daemon.stopped") {
      return {
        kind: "clean_shutdown",
        clean: true,
        marker: marker.marker,
        timestamp: typeof marker.timestamp === "string" ? marker.timestamp : null,
        reason: markerReason(marker)
      };
    }

    return {
      kind: "stale_runtime",
      clean: false,
      marker: marker?.marker ?? null,
      timestamp: typeof marker?.timestamp === "string" ? marker.timestamp : null,
      reason:
        markerReason(marker) ??
        `The previous daemon process (${staleState.pid ?? "unknown"}) was no longer running when this session started.`
    };
  }

  if (marker?.marker === "daemon.crash") {
    return {
      kind: "crash",
      clean: false,
      marker: marker.marker,
      timestamp: typeof marker.timestamp === "string" ? marker.timestamp : null,
      reason: markerReason(marker)
    };
  }

  if (marker?.marker === "daemon.stopped") {
    return {
      kind: "clean_shutdown",
      clean: true,
      marker: marker.marker,
      timestamp: typeof marker.timestamp === "string" ? marker.timestamp : null,
      reason: markerReason(marker)
    };
  }

  return {
    kind: "fresh_start",
    clean: true,
    marker: marker?.marker ?? null,
    timestamp: typeof marker?.timestamp === "string" ? marker.timestamp : null,
    reason: null
  };
}

export function daemonStartReason(
  previousExit: DaemonPreviousExit
): DaemonLifecycle["lastStartReason"] {
  if (previousExit.kind === "clean_shutdown") {
    return "restart_after_clean_shutdown";
  }
  if (previousExit.kind === "crash") {
    return "restart_after_crash";
  }
  if (previousExit.kind === "stale_runtime") {
    return "restart_after_stale_runtime";
  }
  return "fresh_start";
}

export function buildDaemonLifecycle({
  previousExit,
  startupRecovery
}: {
  previousExit: DaemonPreviousExit;
  startupRecovery: DaemonStartupRecovery;
}): DaemonLifecycle {
  return {
    lastStartReason: daemonStartReason(previousExit),
    previousExit,
    startupRecovery
  };
}

export async function readDaemonRuntime(
  daemonDir: string
): Promise<DaemonRuntime> {
  const state = await readDaemonState(daemonDir);
  if (!state) {
    return {
      running: false,
      state: null,
      staleState: null
    };
  }

  const running = isProcessAlive(Number(state.pid));
  if (!running) {
    await clearDaemonState(daemonDir);
    return {
      running,
      state: null,
      staleState: state
    };
  }

  return {
    running,
    state: running ? state : null,
    staleState: null
  };
}
