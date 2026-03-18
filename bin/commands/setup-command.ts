import { apiRequest, baseUrl, ensureDaemonRunning, print, type CliOptions } from "../cli-utils.js";
import type { DaemonInstallStatus, DoctorReport, SetupReport } from "../../src/types/system.js";

function formatInstallStatus(install: DaemonInstallStatus) {
  if (!install.supported) {
    return "unsupported on this platform";
  }

  const parts = [install.installed ? "installed" : "not installed", install.mode];
  if (install.installed && install.loaded === false) {
    parts.push("not loaded");
  }
  return parts.join(", ");
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

function buildRecommendedActions(doctor: DoctorReport) {
  const actions: string[] = [];

  if (doctor.install.supported && !doctor.install.installed) {
    actions.push("Run `agentos daemon install` so AgentOS starts automatically when you log in.");
  }
  if (!doctor.browserExecutable) {
    actions.push("Set `AGENTOS_BROWSER_EXECUTABLE` to a Chrome, Chromium, or Edge binary before relying on browser tasks.");
  }
  if (!doctor.modelConfigured) {
    actions.push("Set `MODEL_API_KEY`, `MODEL_BASE_URL`, and `MODEL_NAME`, then rerun `agentos setup`.");
  }
  if (!doctor.native.available || !doctor.native.compatible) {
    actions.push("Run `npm run native:build` if you want reliable desktop automation from the local sidecar.");
  }
  if (doctor.blockedLivePackCount > 0) {
    actions.push("Run `agentos packs ls` to see which live packs are blocked and what they are missing.");
  }
  if (doctor.pendingDraftCount > 0) {
    actions.push("Run `agentos drafts ls` to review or approve pending drafts.");
  }
  if (doctor.awaitingApprovalWatchCount > 0 || doctor.backoffWatchCount > 0 || doctor.degradedWatchCount > 0) {
    actions.push("Run `agentos watch ls` to review watches that are paused, degraded, awaiting approval, or in backoff.");
  }

  actions.push("Start the interactive shell with `agentos`, or run a first goal like `agentos \"Open example.com and capture a screenshot\" --surface browser`.");
  return actions;
}

function renderSetupReport(report: SetupReport) {
  const lines = [
    "AgentOS setup",
    "",
    `Status: ${report.ok ? "ready" : "needs attention"}`,
    `Daemon: ${report.daemon.running ? "running" : "not running"} at ${baseUrl()}`,
    report.startedDaemon ? "Daemon startup: started a local daemon automatically for this setup check" : "Daemon startup: daemon was already reachable",
    `Auto-start: ${formatInstallStatus(report.doctor.install)}`,
    `Browser: ${report.doctor.browserExecutable ?? "not detected"}`,
    `Model: ${report.doctor.modelConfigured ? "configured" : "not configured"}`,
    `Native sidecar: ${formatNativeStatus(report.doctor)}`,
    `Live packs: ${report.doctor.readyLivePackCount}/${report.doctor.livePackCount} ready`,
    `Watch health: ${report.doctor.degradedWatchCount} degraded, ${report.doctor.awaitingApprovalWatchCount} awaiting approval, ${report.doctor.backoffWatchCount} in backoff`,
    `Queue: ${report.doctor.pendingDraftCount} pending drafts, ${report.doctor.pendingProposalCount} pending proposals`
  ];

  if (report.doctor.warnings.length) {
    lines.push("", "Warnings:");
    for (const warning of report.doctor.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  lines.push("", "Recommended next steps:");
  for (const action of report.recommendedActions) {
    lines.push(`- ${action}`);
  }

  return lines.join("\n");
}

export async function commandSetup(options: CliOptions) {
  const runtime = await ensureDaemonRunning();
  const payload = await apiRequest<{ doctor: DoctorReport }>("GET", "/doctor");
  const report: SetupReport = {
    ok: Boolean(payload.doctor.ok && runtime.daemon.running),
    startedDaemon: runtime.startedDaemon,
    daemon: runtime.daemon,
    doctor: payload.doctor,
    recommendedActions: buildRecommendedActions(payload.doctor)
  };

  print(options.json ? report : renderSetupReport(report), options);
}
