import fs from "node:fs/promises";
import path from "node:path";

import {
  daemonLogPath,
  daemonLogPaths,
  readDaemonLogTail,
  readDaemonRuntime
} from "./daemon-state.js";
import type { AgentOsConfig } from "./config.js";
import type { ControlPlane } from "./runtime/control-plane.js";
import type { DaemonStatus, DoctorBundle, DoctorBundleSnapshot } from "./types/system.js";

export async function createDiagnosticBundle({
  controlPlane,
  config,
  daemon
}: {
  controlPlane: Pick<ControlPlane, "doctor" | "listTasks" | "listWatchRules" | "listDrafts" | "listProposals">;
  config: AgentOsConfig;
  daemon: DaemonStatus;
}): Promise<DoctorBundle> {
  const bundleId = `doctor-${Date.now()}`;
  const bundlePath = path.join(config.daemonDir, "bundles", bundleId);
  await fs.mkdir(bundlePath, { recursive: true });

  const [doctor, daemonRuntime, logTail] = await Promise.all([
    controlPlane.doctor(),
    readDaemonRuntime(config.daemonDir),
    readDaemonLogTail(config.daemonDir)
  ]);

  const snapshot: DoctorBundleSnapshot = {
    createdAt: new Date().toISOString(),
    doctor,
    daemon,
    daemonRuntime,
    install: {
      dataDir: config.dataDir,
      daemonDir: config.daemonDir,
      dbPath: config.dbPath,
      inboxDir: config.inboxDir,
      browserExecutable: config.browserExecutable ?? null
    }
  };

  const recentTasks = controlPlane.listTasks(20);
  const recentWatches = controlPlane.listWatchRules();
  const recentDrafts = controlPlane.listDrafts(50);
  const recentProposals = controlPlane.listProposals(50);

  await Promise.all([
    fs.writeFile(path.join(bundlePath, "doctor.json"), JSON.stringify(snapshot, null, 2), "utf8"),
    fs.writeFile(path.join(bundlePath, "tasks.json"), JSON.stringify(recentTasks, null, 2), "utf8"),
    fs.writeFile(path.join(bundlePath, "watches.json"), JSON.stringify(recentWatches, null, 2), "utf8"),
    fs.writeFile(path.join(bundlePath, "drafts.json"), JSON.stringify(recentDrafts, null, 2), "utf8"),
    fs.writeFile(path.join(bundlePath, "proposals.json"), JSON.stringify(recentProposals, null, 2), "utf8"),
    fs.writeFile(path.join(bundlePath, "daemon-log-tail.txt"), logTail, "utf8")
  ]);

  const copiedLogs: string[] = [];
  for (const logFile of daemonLogPaths(config.daemonDir)) {
    try {
      await fs.access(logFile);
      const target = path.join(bundlePath, path.basename(logFile));
      await fs.copyFile(logFile, target);
      copiedLogs.push(target);
    } catch {
    }
  }

  const stateFile = path.join(config.daemonDir, "state.json");
  try {
    await fs.copyFile(stateFile, path.join(bundlePath, "daemon-state.json"));
  } catch {
  }

  return {
    bundleId,
    bundlePath,
    doctor,
    copiedLogs,
    manifest: {
      files: [
        "doctor.json",
        "tasks.json",
        "watches.json",
        "drafts.json",
        "proposals.json",
        "daemon-log-tail.txt",
        ...(copiedLogs.length ? copiedLogs.map((entry) => path.basename(entry)) : [])
      ]
    }
  };
}
