import fsp from "node:fs/promises";

import { getDaemonInstallStatus } from "../../src/daemon-autostart.js";
import { readDaemonRuntime } from "../../src/daemon-state.js";
import { detectInstallSource } from "../../src/install-source.js";
import type { UninstallReport } from "../../src/types/system.js";
import {
  boolOption,
  config,
  isRemoteControlPlaneMode,
  print,
  stopDaemonProcess,
  uninstallDaemonAutostart,
  unlinkGlobalCli,
  type CliOptions
} from "../cli-utils.js";

function renderUninstallReport(report: UninstallReport) {
  const lines = [
    "AgentOS uninstall",
    "",
    `Install source: ${report.installSource.label}`,
    `Data directory: ${report.dataDir}`,
    `Mode: ${report.dryRun ? "dry run" : "execute"}`
  ];

  if (report.appliedActions.length) {
    lines.push("", "Applied actions:");
    for (const action of report.appliedActions) {
      lines.push(`- ${action}`);
    }
  }

  if (report.plannedActions.length) {
    lines.push("", report.dryRun ? "Planned actions:" : "Remaining actions:");
    for (const action of report.plannedActions) {
      lines.push(`- ${action}`);
    }
  }

  if (report.manualSteps.length) {
    lines.push("", "Manual steps:");
    for (const step of report.manualSteps) {
      lines.push(`- ${step}`);
    }
  }

  return lines.join("\n");
}

export async function commandUninstall(options: CliOptions) {
  const dryRun = boolOption(options.dryRun);
  const purge = boolOption(options.purge);
  const installSource = await detectInstallSource();
  const install = await getDaemonInstallStatus();
  const report: UninstallReport = {
    installSource,
    stoppedDaemon: false,
    removedAutostart: false,
    removedCliLink: false,
    removedDataDir: false,
    keptDataDir: !purge,
    dryRun,
    plannedActions: [],
    appliedActions: [],
    manualSteps: [],
    dataDir: config.dataDir
  };

  if (!isRemoteControlPlaneMode()) {
    const stopAction = "Stop the local daemon process.";
    const runtime = await readDaemonRuntime(config.daemonDir);
    if (runtime.running && runtime.state?.pid) {
      if (dryRun) {
        report.plannedActions.push(stopAction);
      } else {
        const stopResult = await stopDaemonProcess();
        if (stopResult.stopped) {
          report.stoppedDaemon = true;
          report.appliedActions.push(stopAction);
        }
      }
    }
  }

  if (install.supported && install.installed) {
    const autostartAction = "Remove daemon auto-start for the current user.";
    if (dryRun) {
      report.plannedActions.push(autostartAction);
    } else {
      await uninstallDaemonAutostart();
      report.removedAutostart = true;
      report.appliedActions.push(autostartAction);
    }
  }

  if (installSource.source === "source") {
    const unlinkAction = "Remove the global `agentos` CLI link created by `npm link`.";
    if (dryRun) {
      report.plannedActions.push(unlinkAction);
    } else {
      const unlinkResult = await unlinkGlobalCli();
      if (unlinkResult.removed) {
        report.removedCliLink = true;
        report.appliedActions.push(unlinkAction);
      } else {
        report.manualSteps.push("If `agentos` is still linked globally, run `npm run cli:unlink` from the source checkout.");
      }
    }
  }

  if (purge) {
    const purgeAction = `Delete the data directory at ${config.dataDir}.`;
    if (dryRun) {
      report.plannedActions.push(purgeAction);
    } else {
      await fsp.rm(config.dataDir, { recursive: true, force: true });
      report.removedDataDir = true;
      report.keptDataDir = false;
      report.appliedActions.push(purgeAction);
    }
  } else {
    report.manualSteps.push(`Local data was kept. Remove ${config.dataDir} manually if you want a full reset.`);
  }

  if (installSource.source === "macos_pkg") {
    report.manualSteps.push("For the packaged install, remove `/usr/local/bin/agentos` and the installed files under `/opt/agentos` after AgentOS exits.");
  } else if (installSource.source === "windows_msi") {
    report.manualSteps.push("For the packaged install, use Installed Apps to remove AgentOS itself.");
  }

  print(options.json ? report : renderUninstallReport(report), options);
}
