import fsp from "node:fs/promises";
import path from "node:path";

import { detectInstallSource } from "../../src/install-source.js";
import type { DoctorReport, SetupReport } from "../../src/types/system.js";
import {
  apiRequest,
  baseUrl,
  boolOption,
  config,
  ensureDaemonRunning,
  fetchDaemonStatus,
  installDaemonAutostart,
  isRemoteControlPlaneMode,
  print,
  type CliOptions
} from "../cli-utils.js";

function collectBlockingIssues(doctor: DoctorReport) {
  const issues: string[] = [];

  if (!doctor.modelConfigured) {
    issues.push("Model access is not configured, so planning and reply drafting will stay degraded.");
  }
  if (!doctor.store.compatible) {
    issues.push(
      `The local store schema (${doctor.store.schemaVersion}) does not match the runtime expectation (${doctor.version.storeSchemaVersion}).`
    );
  }
  if (doctor.native.available && !doctor.native.compatible) {
    issues.push("The native desktop sidecar protocol does not match this runtime.");
  }

  return issues;
}

function buildRecommendedActions(report: SetupReport) {
  const actions: string[] = [];

  if (report.doctor.install.supported && !report.doctor.install.installed) {
    actions.push("Run `agentos setup --fix` or `agentos daemon install` so AgentOS starts when you log in.");
  }
  if (!report.doctor.browserExecutable) {
    actions.push("Set `AGENTOS_BROWSER_EXECUTABLE` to Chrome, Chromium, or Edge before relying on browser tasks.");
  }
  if (!report.doctor.modelConfigured) {
    actions.push("Set `MODEL_API_KEY`, `MODEL_BASE_URL`, and `MODEL_NAME`, then rerun `agentos setup`.");
  }
  if (!report.doctor.native.available || !report.doctor.native.compatible) {
    actions.push("Run `npm run native:build` if you want reliable desktop automation from the native sidecar.");
  }
  if (report.doctor.blockedLivePackCount > 0) {
    actions.push("Run `agentos packs ls` to see which live packs are blocked and why.");
  }
  if (report.doctor.pendingDraftCount > 0) {
    actions.push("Run `agentos drafts ls` to review or approve pending drafts.");
  }
  if (report.doctor.awaitingApprovalWatchCount > 0 || report.doctor.backoffWatchCount > 0 || report.doctor.degradedWatchCount > 0) {
    actions.push("Run `agentos watch ls` to review watches that are degraded, in backoff, or waiting for approval.");
  }

  actions.push("Start the shell with `agentos`, or run a first goal like `agentos \"Open example.com and capture a screenshot\" --surface browser`.");
  return actions;
}

function formatNativeStatus(doctor: DoctorReport) {
  if (!doctor.native.available) {
    return doctor.native.reason ? `missing (${doctor.native.reason})` : "missing";
  }
  if (!doctor.native.compatible) {
    return `incompatible (protocol ${doctor.native.health?.nativeProtocolVersion ?? "unknown"})`;
  }
  if (doctor.native.permissions && Object.values(doctor.native.permissions).some((value) => value === false)) {
    return "ready, but desktop permissions are incomplete";
  }
  return "ready";
}

async function ensureRuntimeDirectories(dryRun: boolean) {
  const targets = [
    config.dataDir,
    config.daemonDir,
    config.inboxDir,
    path.join(config.dataDir, "bin"),
    path.join(config.dataDir, "workspaces"),
    path.join(config.dataDir, "workspace-profiles")
  ];
  const fixes: string[] = [];

  for (const target of targets) {
    try {
      await fsp.access(target);
    } catch {
      fixes.push(`Ensure runtime directory exists: ${target}`);
      if (!dryRun) {
        await fsp.mkdir(target, { recursive: true });
      }
    }
  }

  return fixes;
}

async function applySetupFixes(report: SetupReport, dryRun: boolean) {
  const plannedFixes = [...report.plannedFixes];
  const appliedFixes = [...report.appliedFixes];

  for (const fix of await ensureRuntimeDirectories(dryRun)) {
    if (dryRun) {
      plannedFixes.push(fix);
    } else {
      appliedFixes.push(fix);
    }
  }

  if (report.doctor.install.supported && !report.doctor.install.installed) {
    const autostartFix = "Install daemon auto-start for the current user.";
    if (isRemoteControlPlaneMode()) {
      plannedFixes.push(`${autostartFix} Skipped because AGENTOS_BASE_URL is set.`);
    } else if (dryRun) {
      plannedFixes.push(autostartFix);
    } else {
      await installDaemonAutostart();
      appliedFixes.push(autostartFix);
    }
  }

  return {
    plannedFixes,
    appliedFixes
  };
}

function renderSetupReport(report: SetupReport, options: { compact?: boolean } = {}) {
  const lines = [
    options.compact ? "AgentOS onboarding" : "AgentOS setup",
    "",
    `Status: ${report.ok ? "ready" : "needs attention"}`,
    `Install source: ${report.installSource.label}`,
    `Daemon: ${report.daemon.running ? "running" : "not running"} at ${baseUrl()}`,
    report.startedDaemon
      ? "Daemon startup: started a local daemon automatically for this setup check"
      : "Daemon startup: daemon was already reachable",
    `Auto-start: ${report.doctor.install.supported ? `${report.doctor.install.installed ? "installed" : "not installed"}, ${report.doctor.install.mode}` : "unsupported on this platform"}`,
    `Data directory: ${config.dataDir}`,
    `Browser: ${report.doctor.browserExecutable ?? "not detected"}`,
    `Model: ${report.doctor.modelConfigured ? "configured" : "not configured"}`,
    `Native sidecar: ${formatNativeStatus(report.doctor)}`,
    `Live packs: ${report.doctor.readyLivePackCount}/${report.doctor.livePackCount} ready`,
    `Watch health: ${report.doctor.degradedWatchCount} degraded, ${report.doctor.awaitingApprovalWatchCount} awaiting approval, ${report.doctor.backoffWatchCount} in backoff`,
    `Queue: ${report.doctor.pendingDraftCount} pending drafts, ${report.doctor.pendingProposalCount} pending proposals`
  ];

  if (report.blockingIssues.length) {
    lines.push("", "Blocking issues:");
    for (const issue of report.blockingIssues) {
      lines.push(`- ${issue}`);
    }
  }

  if (report.doctor.warnings.length) {
    lines.push("", "Warnings:");
    for (const warning of report.doctor.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (report.appliedFixes.length) {
    lines.push("", "Applied fixes:");
    for (const fix of report.appliedFixes) {
      lines.push(`- ${fix}`);
    }
  }

  if (report.plannedFixes.length) {
    lines.push("", options.compact ? "Next fixes:" : "Planned fixes:");
    for (const fix of report.plannedFixes) {
      lines.push(`- ${fix}`);
    }
  }

  lines.push("", options.compact ? "Suggested next steps:" : "Recommended next steps:");
  for (const action of report.recommendedActions) {
    lines.push(`- ${action}`);
  }

  return lines.join("\n");
}

export async function buildSetupReport(options: {
  fix?: boolean;
  dryRun?: boolean;
} = {}): Promise<SetupReport> {
  const runtime = await ensureDaemonRunning();
  let doctor = (await apiRequest<{ doctor: DoctorReport }>("GET", "/doctor")).doctor;
  let daemon = runtime.daemon;
  const installSource = await detectInstallSource();
  let report: SetupReport = {
    ok: Boolean(doctor.ok && daemon.running),
    startedDaemon: runtime.startedDaemon,
    daemon,
    doctor,
    installSource,
    blockingIssues: collectBlockingIssues(doctor),
    plannedFixes: [],
    appliedFixes: [],
    recommendedActions: []
  };

  if (options.fix) {
    const fixes = await applySetupFixes(report, Boolean(options.dryRun));
    report = {
      ...report,
      plannedFixes: fixes.plannedFixes,
      appliedFixes: fixes.appliedFixes
    };

    if (!options.dryRun && report.appliedFixes.length) {
      doctor = (await apiRequest<{ doctor: DoctorReport }>("GET", "/doctor")).doctor;
      daemon = await fetchDaemonStatus().catch(() => daemon);
      report = {
        ...report,
        daemon,
        doctor,
        blockingIssues: collectBlockingIssues(doctor)
      };
    }
  }

  report.recommendedActions = buildRecommendedActions(report);
  report.ok = Boolean(report.daemon.running && report.blockingIssues.length === 0 && report.doctor.warnings.length === 0);
  return report;
}

export function renderOnboardingNotice(report: SetupReport) {
  return renderSetupReport(report, { compact: true });
}

export async function commandSetup(options: CliOptions) {
  const report = await buildSetupReport({
    fix: boolOption(options.fix),
    dryRun: boolOption(options.dryRun)
  });
  print(options.json ? report : renderSetupReport(report), options);
}
