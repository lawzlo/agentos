import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DaemonInstallStatus } from "./types/system.js";

const execFileAsync = promisify(execFile);

export function launchAgentPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", "com.agentos.daemon.plist");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function getDaemonInstallStatus(): Promise<DaemonInstallStatus> {
  if (process.platform === "darwin") {
    const plistPath = launchAgentPath();
    const installed = await fileExists(plistPath);
    let loaded: boolean | null = null;

    if (installed) {
      const uid = process.getuid?.();
      if (uid != null) {
        loaded = await execFileAsync("launchctl", ["print", `gui/${uid}/com.agentos.daemon`])
          .then(() => true)
          .catch(() => false);
      }
    }

    return {
      supported: true,
      mode: "launchd",
      installed,
      loaded,
      label: "com.agentos.daemon",
      path: plistPath
    };
  }

  if (process.platform === "win32") {
    const installed = await execFileAsync("schtasks", ["/Query", "/TN", "AgentOS"])
      .then(() => true)
      .catch(() => false);

    return {
      supported: true,
      mode: "task-scheduler",
      installed,
      loaded: installed,
      label: "AgentOS",
      command: "schtasks /Query /TN AgentOS"
    };
  }

  return {
    supported: false,
    mode: "unsupported",
    installed: false,
    loaded: null,
    label: null,
    path: null
  };
}
