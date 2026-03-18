import fsp from "node:fs/promises";
import path from "node:path";

import { detectInstallSource } from "../../src/install-source.js";
import type { LivePackInfo } from "../../src/types/runtime-schema.js";
import type {
  DoctorReport,
  SetupCommandTemplate,
  SetupPackSummary,
  SetupReport,
  SetupStatusCheck
} from "../../src/types/system.js";
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

function runtimeDirectoryTargets() {
  return [
    config.dataDir,
    config.daemonDir,
    config.inboxDir,
    path.join(config.dataDir, "bin"),
    path.join(config.dataDir, "workspaces"),
    path.join(config.dataDir, "workspace-profiles")
  ];
}

async function findMissingRuntimeDirectories() {
  const missing: string[] = [];
  for (const target of runtimeDirectoryTargets()) {
    try {
      await fsp.access(target);
    } catch {
      missing.push(target);
    }
  }
  return missing;
}

async function ensureRuntimeDirectories(dryRun: boolean) {
  const fixes: string[] = [];
  for (const target of await findMissingRuntimeDirectories()) {
    fixes.push(`Ensure runtime directory exists: ${target}`);
    if (!dryRun) {
      await fsp.mkdir(target, { recursive: true });
    }
  }
  return fixes;
}

function classifyPack(pack: LivePackInfo): SetupPackSummary {
  const blockedCheck = pack.healthChecks?.find((check) => check.status === "blocked");
  const warningCheck = pack.healthChecks?.find((check) => check.status === "warning");
  const status = blockedCheck ? "blocking" : warningCheck ? "warning" : "ready";
  const detail =
    blockedCheck?.detail ??
    warningCheck?.detail ??
    (pack.surface === "browser"
      ? "Browser runtime looks available. Login/session is not verified during setup."
      : "Desktop runtime looks available.");
  const nextStep =
    blockedCheck?.detail
      ? blockedCheck.detail
      : pack.surface === "browser"
        ? "Open the target site once and sign in before enabling this pack."
        : pack.surface === "desktop"
          ? "Open the desktop app once and make sure Accessibility and Screen Recording permissions are granted if needed."
          : null;

  return {
    name: pack.name,
    surface: pack.surface,
    category: pack.category,
    status,
    detail,
    sessionState: pack.surface === "browser" ? "not_checked" : "not_required",
    nextStep
  };
}

function packStatusRank(status: SetupPackSummary["status"]) {
  return status === "blocking" ? 0 : status === "warning" ? 1 : 2;
}

function buildSuggestedCommands({
  doctor,
  packs
}: {
  doctor: DoctorReport;
  packs: SetupPackSummary[];
}): SetupCommandTemplate[] {
  const commands: SetupCommandTemplate[] = [];

  if (doctor.browserExecutable) {
    commands.push({
      id: "browser-smoke",
      label: "Browser smoke test",
      command: 'agentos "Open example.com, click More information, then capture a screenshot" --surface browser',
      reason: "Fastest low-risk way to verify browser automation."
    });
  }

  if ((process.platform === "linux" || doctor.native.available) && doctor.native.compatible) {
    commands.push({
      id: "desktop-smoke",
      label: "Desktop smoke test",
      command: 'agentos "Open a local text editor, type a short note, and wait for me" --surface desktop',
      reason: "Checks desktop automation without needing a third-party app pack."
    });
  }

  if (packs.some((pack) => pack.name === "slack-browser" && pack.status === "ready")) {
    commands.push({
      id: "slack-watch",
      label: "Slack watch rule",
      command: 'agentos watch add "Always watch Slack and reply to low-risk unread threads in my style" --surface browser --workspace personal-main',
      reason: "Turns a ready Slack pack into a standing workflow."
    });
  } else if (packs.some((pack) => pack.name === "generic-mail-browser" && pack.status === "ready")) {
    commands.push({
      id: "mail-watch",
      label: "Mail watch rule",
      command: 'agentos watch add "Always watch my email, draft replies for new customer messages, and leave risky replies for approval" --surface browser --workspace personal-main',
      reason: "Good first real workflow once browser mail is signed in."
    });
  } else if (packs.some((pack) => pack.name === "boss-browser" && pack.status === "ready")) {
    commands.push({
      id: "boss-watch",
      label: "BOSS watch rule",
      command: 'agentos watch add "Always watch BOSS直聘, review new candidates, and draft polite follow-ups" --surface browser --workspace recruiting-main',
      reason: "Exercises a real recruiting pack with drafts-first behavior."
    });
  }

  if (commands.length < 3) {
    commands.push({
      id: "daily-digest-job",
      label: "Daily digest job",
      command: "agentos jobs add daily_digest --hour 18",
      reason: "Good first always-on job: a daily summary without risky side effects."
    });
  }

  if (commands.length < 3 && doctor.browserExecutable) {
    commands.push({
      id: "morning-scan-job",
      label: "Morning scan job",
      command: "agentos jobs add morning_scan --workspace personal-main --surface browser --hour 9",
      reason: "Turns AgentOS into a recurring morning operator instead of one-off automation."
    });
  }

  return commands.slice(0, 3);
}

function buildStatusChecks({
  doctor,
  startedDaemon,
  missingRuntimeDirectories,
  appliedFixes,
  packSummaries
}: {
  doctor: DoctorReport;
  startedDaemon: boolean;
  missingRuntimeDirectories: string[];
  appliedFixes: string[];
  packSummaries: SetupPackSummary[];
}): SetupStatusCheck[] {
  const fixedDirectory = appliedFixes.some((fix) => fix.startsWith("Ensure runtime directory exists:"));
  const fixedAutostart = appliedFixes.includes("Install daemon auto-start for the current user.");
  const blockedPackCount = packSummaries.filter((pack) => pack.status === "blocking").length;
  const warningPackCount = packSummaries.filter((pack) => pack.status === "warning").length;

  return [
    {
      id: "daemon",
      label: "Daemon runtime",
      status: startedDaemon ? "fixed" : "ready",
      detail: startedDaemon
        ? "A local daemon was started automatically for this setup run."
        : "The AgentOS daemon is already reachable."
    },
    {
      id: "data-dir",
      label: "Runtime directories",
      status: fixedDirectory ? "fixed" : missingRuntimeDirectories.length ? "warning" : "ready",
      detail: fixedDirectory
        ? `Missing runtime directories under ${config.dataDir} were created during setup.`
        : missingRuntimeDirectories.length
          ? `Some runtime directories were missing under ${config.dataDir}.`
          : `Runtime directories are present under ${config.dataDir}.`,
      nextStep: fixedDirectory ? null : missingRuntimeDirectories.length ? "Run `agentos setup --fix` to create the missing directories." : null
    },
    {
      id: "autostart",
      label: "Auto-start",
      status: doctor.install.supported
        ? fixedAutostart
          ? "fixed"
          : doctor.install.installed
            ? "ready"
            : "warning"
        : "info",
      detail: doctor.install.supported
        ? fixedAutostart
          ? "AgentOS auto-start was installed for the current user during setup."
          : doctor.install.installed
            ? "AgentOS is configured to start automatically when you log in."
            : "AgentOS is not yet configured to start automatically."
        : "Auto-start is not implemented on this platform.",
      nextStep:
        doctor.install.supported && !doctor.install.installed && !fixedAutostart
          ? "Run `agentos setup --fix` or `agentos daemon install`."
          : null
    },
    {
      id: "browser-runtime",
      label: "Browser runtime",
      status: doctor.browserExecutable ? "ready" : "blocking",
      detail: doctor.browserExecutable
        ? `Detected browser executable: ${doctor.browserExecutable}`
        : "No Chrome, Chromium, or Edge executable was detected.",
      nextStep: doctor.browserExecutable ? "Open the sites you care about and sign in before enabling browser packs." : "Set `AGENTOS_BROWSER_EXECUTABLE` to a Chrome-compatible binary."
    },
    {
      id: "browser-sessions",
      label: "Browser app sessions",
      status: doctor.browserExecutable ? "info" : "warning",
      detail: doctor.browserExecutable
        ? "Slack, mail, BOSS, and docs sessions are not verified during setup. They are checked when a pack runs."
        : "Browser sessions cannot be checked until a browser runtime is configured.",
      nextStep: doctor.browserExecutable ? "Open each target site once and confirm you are signed in." : null
    },
    {
      id: "model",
      label: "Model access",
      status: doctor.modelConfigured ? "ready" : "blocking",
      detail: doctor.modelConfigured
        ? "Model access is configured."
        : "Model access is missing, so planning and reply drafting will stay degraded.",
      nextStep: doctor.modelConfigured ? null : "Set `MODEL_API_KEY`, `MODEL_BASE_URL`, and `MODEL_NAME`."
    },
    {
      id: "native-sidecar",
      label: "Desktop sidecar",
      status: process.platform === "linux" ? "info" : !doctor.native.available || !doctor.native.compatible ? "blocking" : "ready",
      detail:
        process.platform === "linux"
          ? "Linux desktop automation does not require the native sidecar."
          : !doctor.native.available
            ? doctor.native.reason ?? "The native desktop sidecar is unavailable."
            : !doctor.native.compatible
              ? "The native desktop sidecar protocol does not match the runtime."
              : "The native desktop sidecar is available.",
      nextStep:
        process.platform === "linux" || (doctor.native.available && doctor.native.compatible)
          ? null
          : "Run `npm run native:build` to rebuild the native sidecar."
    },
    {
      id: "desktop-permissions",
      label: "Desktop permissions",
      status:
        process.platform === "linux"
          ? "info"
          : doctor.native.permissions && Object.values(doctor.native.permissions).some((value) => value === false)
            ? "warning"
            : doctor.native.available && doctor.native.compatible
              ? "ready"
              : "info",
      detail:
        process.platform === "linux"
          ? "Linux permission checks are not required in the same way."
          : doctor.native.permissions && Object.values(doctor.native.permissions).some((value) => value === false)
            ? "Accessibility or Screen Recording permission is missing."
            : doctor.native.available && doctor.native.compatible
              ? "Desktop automation permissions look available."
              : "Desktop permissions will be checked after the sidecar is available.",
      nextStep:
        process.platform === "linux" || !(doctor.native.permissions && Object.values(doctor.native.permissions).some((value) => value === false))
          ? null
          : "Grant Accessibility and Screen Recording permissions in system settings, then rerun `agentos setup`."
    },
    {
      id: "store",
      label: "Local store",
      status: doctor.store.compatible ? "ready" : "blocking",
      detail: doctor.store.compatible
        ? "The local store schema matches this runtime."
        : `The store schema (${doctor.store.schemaVersion}) does not match the runtime expectation (${doctor.version.storeSchemaVersion}).`
    },
    {
      id: "packs",
      label: "Pack availability",
      status: blockedPackCount > 0 ? "warning" : warningPackCount > 0 ? "warning" : "ready",
      detail:
        blockedPackCount > 0
          ? `${blockedPackCount} pack(s) are blocked and ${warningPackCount} need attention.`
          : warningPackCount > 0
            ? `${warningPackCount} pack(s) need attention, but nothing is hard-blocked.`
            : "Available packs look ready at the runtime level."
    }
  ];
}

function collectBlockingIssues(checks: SetupStatusCheck[]) {
  return checks.filter((check) => check.status === "blocking").map((check) => `${check.label}: ${check.detail}`);
}

function buildRecommendedActions(report: SetupReport) {
  const actions: string[] = [];

  if (
    report.statusChecks.some(
      (check) => (check.id === "autostart" || check.id === "data-dir") && check.status === "warning"
    )
  ) {
    actions.push("Run `agentos setup --fix` to install low-risk defaults like runtime directories and auto-start.");
  }
  if (report.statusChecks.some((check) => check.id === "browser-runtime" && check.status === "blocking")) {
    actions.push("Configure a browser runtime before expecting browser packs to work.");
  }
  if (report.statusChecks.some((check) => check.id === "model" && check.status === "blocking")) {
    actions.push("Configure your model endpoint and API key so AgentOS can plan and draft properly.");
  }
  if (report.packSummaries.some((pack) => pack.status !== "ready" && pack.surface === "browser")) {
    actions.push("Sign in to the sites you plan to automate before enabling browser-based watch rules.");
  }
  if (report.doctor.pendingDraftCount > 0) {
    actions.push("Run `agentos drafts ls` to review or approve pending drafts.");
  }
  if (report.doctor.awaitingApprovalWatchCount > 0 || report.doctor.backoffWatchCount > 0 || report.doctor.degradedWatchCount > 0) {
    actions.push("Run `agentos watch ls` to review watches that are degraded, in backoff, or waiting for approval.");
  }
  if (report.packSummaries.some((pack) => pack.status !== "ready")) {
    actions.push("Run `agentos packs ls` for a full pack-by-pack health breakdown.");
  }
  for (const template of report.suggestedCommands) {
    actions.push(`Try ${template.label.toLowerCase()}: \`${template.command}\``);
  }

  return actions;
}

function renderCheck(check: SetupStatusCheck) {
  return `[${check.status}] ${check.label}: ${check.detail}${check.nextStep ? ` Next: ${check.nextStep}` : ""}`;
}

function renderPack(pack: SetupPackSummary) {
  const sessionNote =
    pack.sessionState === "not_checked"
      ? " Session/login is not verified during setup."
      : "";
  return `[${pack.status}] ${pack.name}: ${pack.detail}${sessionNote}${pack.nextStep ? ` Next: ${pack.nextStep}` : ""}`;
}

function renderTemplate(template: SetupCommandTemplate) {
  return `- ${template.label}: \`${template.command}\`\n  ${template.reason}`;
}

function renderSetupReport(report: SetupReport, options: { compact?: boolean } = {}) {
  const packLimit = options.compact ? 4 : Math.max(report.packSummaries.length, 4);
  const lines = [
    options.compact ? "AgentOS onboarding" : "AgentOS setup",
    "",
    `Status: ${report.ok ? "ready" : "needs attention"}`,
    `Install source: ${report.installSource.label}`,
    `Daemon: ${report.daemon.running ? "running" : "not running"} at ${baseUrl()}`,
    `Data directory: ${config.dataDir}`
  ];

  lines.push("", options.compact ? "Key checks:" : "Setup checks:");
  for (const check of report.statusChecks) {
    lines.push(`- ${renderCheck(check)}`);
  }

  if (report.packSummaries.length) {
    lines.push("", "Pack availability:");
    for (const pack of report.packSummaries.slice(0, packLimit)) {
      lines.push(`- ${renderPack(pack)}`);
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

  if (report.suggestedCommands.length) {
    lines.push("", options.compact ? "Try one of these now:" : "Suggested commands:");
    for (const template of report.suggestedCommands) {
      lines.push(renderTemplate(template));
    }
  }

  if (report.recommendedActions.length) {
    lines.push("", options.compact ? "Suggested next steps:" : "Recommended next steps:");
    for (const action of report.recommendedActions) {
      lines.push(`- ${action}`);
    }
  }

  return lines.join("\n");
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

  return { plannedFixes, appliedFixes };
}

export async function buildSetupReport(options: {
  fix?: boolean;
  dryRun?: boolean;
} = {}): Promise<SetupReport> {
  const runtime = await ensureDaemonRunning();
  let doctor = (await apiRequest<{ doctor: DoctorReport }>("GET", "/doctor")).doctor;
  let daemon = runtime.daemon;
  let packs = (await apiRequest<{ packs: LivePackInfo[] }>("GET", "/packs").catch(() => ({ packs: [] }))).packs;
  const installSource = await detectInstallSource();
  let missingRuntimeDirectories = await findMissingRuntimeDirectories();
  let packSummaries = packs.map(classifyPack).sort((left, right) => packStatusRank(left.status) - packStatusRank(right.status) || left.name.localeCompare(right.name));
  let report: SetupReport = {
    ok: false,
    startedDaemon: runtime.startedDaemon,
    daemon,
    doctor,
    installSource,
    statusChecks: [],
    packSummaries,
    suggestedCommands: [],
    blockingIssues: [],
    plannedFixes: [],
    appliedFixes: [],
    recommendedActions: []
  };

  if (options.fix) {
    const fixes = await applySetupFixes(report, Boolean(options.dryRun));
    report.plannedFixes = fixes.plannedFixes;
    report.appliedFixes = fixes.appliedFixes;

    if (!options.dryRun && report.appliedFixes.length) {
      doctor = (await apiRequest<{ doctor: DoctorReport }>("GET", "/doctor")).doctor;
      daemon = await fetchDaemonStatus().catch(() => daemon);
      packs = (await apiRequest<{ packs: LivePackInfo[] }>("GET", "/packs").catch(() => ({ packs }))).packs;
      missingRuntimeDirectories = await findMissingRuntimeDirectories();
      packSummaries = packs.map(classifyPack).sort((left, right) => packStatusRank(left.status) - packStatusRank(right.status) || left.name.localeCompare(right.name));
      report.daemon = daemon;
      report.doctor = doctor;
      report.packSummaries = packSummaries;
    }
  }

  report.statusChecks = buildStatusChecks({
    doctor: report.doctor,
    startedDaemon: report.startedDaemon,
    missingRuntimeDirectories,
    appliedFixes: report.appliedFixes,
    packSummaries: report.packSummaries
  });
  report.blockingIssues = collectBlockingIssues(report.statusChecks);
  report.suggestedCommands = buildSuggestedCommands({
    doctor: report.doctor,
    packs: report.packSummaries
  });
  report.recommendedActions = buildRecommendedActions(report);
  report.ok = !report.statusChecks.some((check) => check.status === "blocking" || check.status === "warning");
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
