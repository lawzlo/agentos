import fs from "node:fs/promises";
import path from "node:path";

import { boolOption, config, print, type CliOptions } from "../cli-utils.js";
import { collectDesktopProbe, type DesktopProbeDeps, type DesktopProbeReport, type DesktopProbeRequest } from "./desktop-command.js";
import { BrowserSurfaceAdapter } from "../../src/runtime/adapters/browser-surface.js";
import {
  analyzeConversationPack,
  detectBrowserManualIntervention,
  runnerTypeForPack,
  type DesktopConversationPackAnalysis,
  type DesktopProbeCandidateSummary
} from "../../src/runtime/live-pack-registry.js";
import type {
  SceneType,
  SurfaceRecoveryAction,
  SurfaceRunnerType,
  TaskRecord,
  WatchRule,
  WorkspaceProfile,
  WorldState
} from "../../src/types/runtime-schema.js";

type SurfaceName = "browser" | "desktop";

export type SurfaceReadinessState =
  | "ready"
  | "blocked_signin"
  | "blocked_verification"
  | "blocked_access_denied"
  | "needs_takeover"
  | "no_visible_thread"
  | "no_visible_composer"
  | "focus_lost"
  | "degraded_ocr"
  | "browser_unavailable";

interface BrowserStateAdapter {
  act(args: {
    task: TaskRecord;
    workspace: WorkspaceProfile;
    traceId: string | null;
    step: { action: string; params?: Record<string, unknown>; label?: string };
  }): Promise<unknown>;
  observe(args: {
    task: TaskRecord;
    workspace: WorkspaceProfile;
    traceId: string | null;
    label?: string;
  }): Promise<WorldState>;
  shutdown(): Promise<void>;
}

export interface SurfaceStateRequest {
  surface: SurfaceName;
  appName: string | null;
  packName: string | null;
  workspaceName: string;
  sampleLimit: number;
  timeoutMs: number;
  requireAccessibility: boolean;
  waitReady: boolean;
  url: string | null;
  browserProfilePath: string | null;
}

export interface SurfaceStateReport {
  request: SurfaceStateRequest;
  surface: SurfaceName;
  ready: boolean;
  readinessState: SurfaceReadinessState;
  blockers: SurfaceReadinessState[];
  runnerType: SurfaceRunnerType;
  scene: SceneType | null;
  selectedTarget: string | null;
  skipReasons: string[];
  recoverySuggested: SurfaceRecoveryAction | null;
  frontmostApp: string | null;
  activeWindow: string | null;
  visibleTextPreview: string[];
  capturePath: string | null;
  ocrAvailable: boolean | null;
  ocrError: string | null;
  threadCandidates: DesktopProbeCandidateSummary[];
  composeCandidate: DesktopProbeCandidateSummary | null;
  sendCandidate: DesktopProbeCandidateSummary | null;
  packAnalysis: DesktopConversationPackAnalysis | null;
  manualIntervention: {
    kind: string | null;
    detail: string | null;
    action: string | null;
    summary: string | null;
  } | null;
}

export interface SurfaceStateDeps {
  desktopProbe?: (request: DesktopProbeRequest, deps?: DesktopProbeDeps) => Promise<DesktopProbeReport>;
  desktopProbeDeps?: DesktopProbeDeps;
  browserAdapter?: BrowserStateAdapter;
  workspace?: WorkspaceProfile;
  nowIso?: () => string;
}

function genericSceneFromPackAnalysis(packAnalysis: DesktopConversationPackAnalysis | null): SceneType | null {
  if (!packAnalysis) {
    return null;
  }
  return packAnalysis.scene ?? (packAnalysis.composeCandidate ? "thread" : packAnalysis.unreadCandidate ? "list" : "unknown");
}

function browserSceneFromState({
  request,
  packAnalysis,
  manualIntervention
}: {
  request: SurfaceStateRequest;
  packAnalysis: DesktopConversationPackAnalysis | null;
  manualIntervention: ReturnType<typeof detectBrowserManualIntervention> | null;
}): {
  runnerType: SurfaceRunnerType;
  scene: SceneType | null;
  selectedTarget: string | null;
  skipReasons: string[];
  recoverySuggested: SurfaceRecoveryAction | null;
} {
  const runnerType = runnerTypeForPack(request.packName, "browser");
  const interventionKind = manualIntervention?.metadata?.manualInterventionKind ?? null;
  if (interventionKind === "login" || interventionKind === "session_expired") {
    return {
      runnerType,
      scene: "signin",
      selectedTarget: null,
      skipReasons: ["blocked_signin"],
      recoverySuggested: "complete_signin"
    };
  }
  if (interventionKind === "verification") {
    return {
      runnerType,
      scene: "verification",
      selectedTarget: null,
      skipReasons: ["blocked_verification"],
      recoverySuggested: "complete_verification"
    };
  }
  if (interventionKind === "access_denied") {
    return {
      runnerType,
      scene: "foreign_view",
      selectedTarget: null,
      skipReasons: ["blocked_access_denied"],
      recoverySuggested: "takeover"
    };
  }

  return {
    runnerType,
    scene: genericSceneFromPackAnalysis(packAnalysis),
    selectedTarget: String(packAnalysis?.selectedTarget ?? packAnalysis?.unreadCandidate?.text ?? "").trim() || null,
    skipReasons: Array.isArray(packAnalysis?.skipReasons) ? packAnalysis.skipReasons : [],
    recoverySuggested: packAnalysis?.recoveryAction ?? null
  };
}

function desktopSceneFromState({
  request,
  packAnalysis
}: {
  request: SurfaceStateRequest;
  packAnalysis: DesktopConversationPackAnalysis | null;
}): {
  runnerType: SurfaceRunnerType;
  scene: SceneType | null;
  selectedTarget: string | null;
  skipReasons: string[];
  recoverySuggested: SurfaceRecoveryAction | null;
} {
  return {
    runnerType: packAnalysis?.runnerType ?? runnerTypeForPack(request.packName, "desktop"),
    scene: genericSceneFromPackAnalysis(packAnalysis),
    selectedTarget: String(packAnalysis?.selectedTarget ?? packAnalysis?.unreadCandidate?.text ?? "").trim() || null,
    skipReasons: Array.isArray(packAnalysis?.skipReasons) ? packAnalysis.skipReasons : [],
    recoverySuggested: packAnalysis?.recoveryAction ?? null
  };
}

function safeName(value: string) {
  return String(value).trim().toLowerCase().replaceAll(/[^a-z0-9-]+/g, "-") || "surface-state";
}

function inferDesktopPackName(appName: string): string | null {
  const normalized = String(appName ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized.includes("wechat") || normalized.includes("微信")) {
    return "wechat-desktop";
  }
  if (normalized.includes("slack")) {
    return "slack-desktop";
  }
  if (normalized.includes("outlook")) {
    return "outlook-desktop";
  }
  if (normalized === "mail" || normalized.includes("邮件")) {
    return "generic-mail-desktop";
  }
  return null;
}

function inferDesktopAppName(packName: string | null): string | null {
  switch (String(packName ?? "").trim()) {
    case "wechat-desktop":
      return "WeChat";
    case "slack-desktop":
      return "Slack";
    case "outlook-desktop":
      return "Microsoft Outlook";
    case "generic-mail-desktop":
      return "Mail";
    default:
      return null;
  }
}

function inferBrowserPackName(url: string): string | null {
  const normalized = String(url ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized.includes("slack.com")) {
    return "slack-browser";
  }
  if (normalized.includes("zhipin.com")) {
    return "boss-browser";
  }
  if (normalized.includes("mail.google.com") || normalized.includes("outlook.live.com") || normalized.includes("outlook.office.com")) {
    return "generic-mail-browser";
  }
  return null;
}

function buildStateTask(surface: SurfaceName, label: string, nowIso: () => string): TaskRecord {
  const timestamp = nowIso();
  return {
    id: `state-${Date.now()}`,
    goal: `Inspect ${surface} state for ${label}`,
    status: "running",
    priority: "normal",
    triggerSource: "manual",
    deadline: null,
    preferredSurface: surface,
    workspaceId: null,
    traceId: null,
    taskSpec: {
      goal: `Inspect ${surface} state for ${label}`,
      preferredSurface: surface
    },
    plan: [],
    result: null,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

async function createStateWorkspace(
  request: SurfaceStateRequest,
  nowIso: () => string
): Promise<WorkspaceProfile> {
  const rootPath = path.join(config.dataDir, "surface-states", safeName(request.workspaceName || request.appName || request.packName || request.surface));
  const profilePath = request.surface === "browser" && request.browserProfilePath
    ? (path.isAbsolute(request.browserProfilePath)
        ? request.browserProfilePath
        : path.resolve(rootPath, request.browserProfilePath))
    : path.join(rootPath, "profile");
  const downloadsPath = path.join(rootPath, "downloads");
  const artifactsPath = path.join(rootPath, "artifacts");
  const scratchPath = path.join(rootPath, "scratch");
  await Promise.all([
    fs.mkdir(path.dirname(profilePath), { recursive: true }),
    fs.mkdir(downloadsPath, { recursive: true }),
    fs.mkdir(artifactsPath, { recursive: true }),
    fs.mkdir(scratchPath, { recursive: true })
  ]);

  const timestamp = nowIso();
  return {
    id: `surface-state-${Date.now()}`,
    name: request.workspaceName,
    rootPath,
    profilePath,
    downloadsPath,
    artifactsPath,
    scratchPath,
    metadata: {
      surfaceState: true,
      surface: request.surface,
      appName: request.appName,
      packName: request.packName
    },
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function createBrowserAdapter(): BrowserStateAdapter {
  return new BrowserSurfaceAdapter({
    artifactStore: {
      async registerExistingFile({
        taskId,
        traceId,
        kind,
        label,
        filePath,
        metadata = {}
      }: {
        taskId: string;
        traceId: string | null;
        kind: string;
        label: string;
        filePath: string;
        metadata?: Record<string, unknown>;
      }) {
        return {
          id: `artifact-${Date.now()}`,
          taskId,
          traceId,
          kind,
          label,
          path: filePath,
          metadata,
          createdAt: new Date().toISOString()
        };
      }
    } as never,
    browserExecutable: config.browserExecutable ?? null,
    headless: config.headless
  }) as BrowserStateAdapter;
}

function buildSyntheticStateRule(request: SurfaceStateRequest): WatchRule {
  const timestamp = new Date().toISOString();
  return {
    id: `state-${Date.now()}`,
    goal: `Inspect ${request.packName ?? request.surface} state`,
    enabled: true,
    status: "watching",
    preferredSurface: request.surface,
    workspaceName: request.workspaceName,
    skillName: null,
    appTarget: request.appName,
    livePack: request.packName ?? `${request.surface}-state`,
    pollIntervalMs: 1000,
    watchProfile: {},
    taskInputs: request.url ? { startUrl: request.url } : {},
    dedupeState: {},
    lastObservedAt: null,
    lastTriggeredAt: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function deriveDesktopReadiness(report: DesktopProbeReport): {
  ready: boolean;
  readinessState: SurfaceReadinessState;
  blockers: SurfaceReadinessState[];
} {
  const blockers: SurfaceReadinessState[] = [];
  const targetApp = String(report.request.appName ?? "").trim().toLowerCase();
  const frontmostApp = String(report.frontmostApp ?? "").trim().toLowerCase();
  if (targetApp && frontmostApp && !frontmostApp.includes(targetApp.toLowerCase())) {
    blockers.push("focus_lost");
  }
  if (report.ocrAvailable === false) {
    blockers.push("degraded_ocr");
  }
  if (report.packAnalysis) {
    if (report.packAnalysis.foreground === false && !blockers.includes("focus_lost")) {
      blockers.push("focus_lost");
    }
    if (!report.packAnalysis.unreadCandidate) {
      blockers.push("no_visible_thread");
    } else if (!report.packAnalysis.composeCandidate) {
      blockers.push("no_visible_composer");
    }
  } else if (report.readiness && report.readiness.ready === false) {
    blockers.push("needs_takeover");
  }

  return {
    ready: blockers.length === 0,
    readinessState: blockers[0] ?? "ready",
    blockers
  };
}

function deriveBrowserReadiness({
  request,
  worldState,
  packAnalysis,
  manualIntervention
}: {
  request: SurfaceStateRequest;
  worldState: WorldState;
  packAnalysis: DesktopConversationPackAnalysis | null;
  manualIntervention: ReturnType<typeof detectBrowserManualIntervention> | null;
}): {
  ready: boolean;
  readinessState: SurfaceReadinessState;
  blockers: SurfaceReadinessState[];
} {
  const blockers: SurfaceReadinessState[] = [];
  const interventionKind = manualIntervention?.metadata?.manualInterventionKind ?? null;
  if (interventionKind === "verification") {
    blockers.push("blocked_verification");
  } else if (interventionKind === "login" || interventionKind === "session_expired") {
    blockers.push("blocked_signin");
  } else if (interventionKind === "access_denied") {
    blockers.push("blocked_access_denied");
  }

  if (!blockers.length && request.packName && packAnalysis) {
    if (!packAnalysis.unreadCandidate) {
      blockers.push("no_visible_thread");
    } else if (!packAnalysis.composeCandidate && request.packName !== "boss-browser") {
      blockers.push("no_visible_composer");
    }
  }

  if (!blockers.length && !String(worldState.visibleText ?? "").trim()) {
    blockers.push("needs_takeover");
  }

  return {
    ready: blockers.length === 0,
    readinessState: blockers[0] ?? "ready",
    blockers
  };
}

function renderSurfaceState(report: SurfaceStateReport): string {
  const lines: string[] = [];
  lines.push("AgentOS state");
  lines.push("");
  lines.push(`Surface: ${report.surface}`);
  lines.push(`Pack: ${report.request.packName ?? "(none)"}`);
  lines.push(`Runner: ${report.runnerType}`);
  lines.push(`Scene: ${report.scene ?? "unknown"}`);
  lines.push(`Readiness: ${report.readinessState}`);
  lines.push(`Blockers: ${report.blockers.length ? report.blockers.join(", ") : "none"}`);
  if (report.selectedTarget) {
    lines.push(`Selected target: ${report.selectedTarget}`);
  }
  if (report.recoverySuggested && report.recoverySuggested !== "none") {
    lines.push(`Recovery suggested: ${report.recoverySuggested}`);
  }
  if (report.skipReasons.length) {
    lines.push(`Skip reasons: ${report.skipReasons.join(", ")}`);
  }
  if (report.frontmostApp) {
    lines.push(`Frontmost app: ${report.frontmostApp}`);
  }
  if (report.activeWindow) {
    lines.push(`Active window: ${report.activeWindow}`);
  }
  if (report.capturePath) {
    lines.push(`Capture: ${report.capturePath}`);
  }
  if (report.ocrAvailable === false) {
    lines.push(`OCR: unavailable (${report.ocrError ?? "unknown error"})`);
  }
  if (report.visibleTextPreview.length) {
    lines.push("");
    lines.push("Visible text preview:");
    for (const line of report.visibleTextPreview) {
      lines.push(`- ${line}`);
    }
  }
  if (report.threadCandidates.length) {
    lines.push("");
    lines.push("Thread candidates:");
    for (const candidate of report.threadCandidates) {
      lines.push(`- ${candidate.text} (score=${candidate.score ?? "n/a"}, source=${candidate.source})`);
    }
  }
  lines.push("");
  lines.push(`Composer candidate: ${report.composeCandidate?.text ?? "(none)"}`);
  lines.push(`Send candidate: ${report.sendCandidate?.text ?? "(none)"}`);
  if (report.manualIntervention) {
    lines.push("");
    lines.push(`Manual intervention: ${report.manualIntervention.kind ?? "unknown"}`);
    if (report.manualIntervention.summary) {
      lines.push(report.manualIntervention.summary);
    }
    if (report.manualIntervention.action) {
      lines.push(`Next action: ${report.manualIntervention.action}`);
    }
  }
  return lines.join("\n");
}

async function collectBrowserState(
  request: SurfaceStateRequest,
  deps: SurfaceStateDeps = {}
): Promise<SurfaceStateReport> {
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  if (!deps.browserAdapter && !config.browserExecutable) {
    return {
      request,
      surface: "browser",
      ready: false,
      readinessState: "browser_unavailable",
      blockers: ["browser_unavailable"],
      runnerType: "browser_native",
      scene: "unknown",
      selectedTarget: null,
      skipReasons: ["browser_unavailable"],
      recoverySuggested: "takeover",
      frontmostApp: null,
      activeWindow: null,
      visibleTextPreview: [],
      capturePath: null,
      ocrAvailable: null,
      ocrError: null,
      threadCandidates: [],
      composeCandidate: null,
      sendCandidate: null,
      packAnalysis: null,
      manualIntervention: null
    };
  }

  const adapter = deps.browserAdapter ?? createBrowserAdapter();
  const workspace = deps.workspace ?? (await createStateWorkspace(request, nowIso));
  const task = buildStateTask("browser", request.packName ?? request.url ?? "browser", nowIso);

  try {
    if (request.url) {
      await adapter.act({
        task,
        workspace,
        traceId: null,
        step: {
          action: "openUrl",
          params: {
            url: request.url,
            waitUntil: "domcontentloaded",
            timeoutMs: request.timeoutMs
          }
        }
      });
    }

    const worldState = await adapter.observe({
      task,
      workspace,
      traceId: null,
      label: `state-browser-${safeName(request.packName ?? request.url ?? "current")}`
    });
    const packAnalysis = request.packName ? analyzeConversationPack(request.packName, worldState) : null;
    const manualIntervention = request.packName
      ? detectBrowserManualIntervention({
          packName: request.packName,
          worldState,
          rule: buildSyntheticStateRule(request),
          dedupeState: {}
        })
      : null;
    const readiness = deriveBrowserReadiness({
      request,
      worldState,
      packAnalysis,
      manualIntervention
    });
    const sceneState = browserSceneFromState({
      request,
      packAnalysis,
      manualIntervention
    });

    return {
      request,
      surface: "browser",
      ready: readiness.ready,
      readinessState: readiness.readinessState,
      blockers: readiness.blockers,
      runnerType: sceneState.runnerType,
      scene: sceneState.scene,
      selectedTarget: sceneState.selectedTarget,
      skipReasons: sceneState.skipReasons,
      recoverySuggested: sceneState.recoverySuggested,
      frontmostApp: String(worldState.appContext?.title ?? "").trim() || null,
      activeWindow: String(worldState.appContext?.url ?? "").trim() || null,
      visibleTextPreview: String(worldState.visibleText ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, Math.max(3, request.sampleLimit)),
      capturePath: typeof worldState.capture?.path === "string" ? worldState.capture.path : null,
      ocrAvailable: null,
      ocrError: null,
      threadCandidates: packAnalysis?.topUnreadCandidates ?? [],
      composeCandidate: packAnalysis?.composeCandidate ?? null,
      sendCandidate: packAnalysis?.sendCandidate ?? null,
      packAnalysis,
      manualIntervention: manualIntervention
        ? {
            kind: manualIntervention.metadata?.manualInterventionKind ?? null,
            detail: manualIntervention.metadata?.manualInterventionDetail ?? null,
            action: manualIntervention.metadata?.manualInterventionAction ?? null,
            summary: manualIntervention.summary ?? null
          }
        : null
    };
  } finally {
    if (!deps.browserAdapter) {
      await adapter.shutdown().catch(() => null);
    }
  }
}

export async function collectSurfaceState(
  request: SurfaceStateRequest,
  deps: SurfaceStateDeps = {}
): Promise<SurfaceStateReport> {
  if (request.surface === "browser") {
    return collectBrowserState(request, deps);
  }

  const desktopProbe = deps.desktopProbe ?? collectDesktopProbe;
  const report = await desktopProbe(
    {
      appName: request.appName ?? "",
      packName: request.packName,
      workspaceName: request.workspaceName,
      sampleLimit: request.sampleLimit,
      timeoutMs: request.timeoutMs,
      requireAccessibility: request.requireAccessibility,
      waitReady: request.waitReady
    },
    deps.desktopProbeDeps
  );
  const readiness = deriveDesktopReadiness(report);
  const activeWindow = report.targetAppInspection?.topCandidates?.[0]?.hints?.[0] ?? null;
  const sceneState = desktopSceneFromState({
    request,
    packAnalysis: report.packAnalysis
  });

  return {
    request,
    surface: "desktop",
    ready: readiness.ready,
    readinessState: readiness.readinessState,
    blockers: readiness.blockers,
    runnerType: sceneState.runnerType,
    scene: sceneState.scene,
    selectedTarget: sceneState.selectedTarget,
    skipReasons: sceneState.skipReasons,
    recoverySuggested: sceneState.recoverySuggested,
    frontmostApp: report.frontmostApp,
    activeWindow: activeWindow || report.targetAppInspection?.frontmostApp || null,
    visibleTextPreview: report.visibleTextPreview,
    capturePath: report.capturePath,
    ocrAvailable: report.ocrAvailable,
    ocrError: report.ocrError,
    threadCandidates: report.packAnalysis?.topUnreadCandidates ?? report.topCandidates,
    composeCandidate: report.packAnalysis?.composeCandidate ?? null,
    sendCandidate: report.packAnalysis?.sendCandidate ?? null,
    packAnalysis: report.packAnalysis,
    manualIntervention: null
  };
}

export async function commandState(subcommand: string | undefined, positionals: string[], options: CliOptions) {
  if (subcommand && !subcommand.startsWith("--")) {
    throw new Error(`Unsupported state command: ${subcommand}`);
  }

  const requestedPack = typeof options.pack === "string" ? options.pack : null;
  const requestedSurface = typeof options.surface === "string" ? String(options.surface).trim().toLowerCase() : "";
  const surface = (
    requestedSurface === "desktop"
    || String(requestedPack ?? "").endsWith("-desktop")
    || Boolean(options.app)
  )
    ? "desktop"
    : "browser";
  const firstPositional = String(positionals[0] ?? "").trim();
  const rawDesktopApp =
    surface === "desktop"
      ? (typeof options.app === "string" ? options.app : firstPositional || inferDesktopAppName(requestedPack) || "")
      : "";
  const appName = surface === "desktop" ? String(rawDesktopApp).trim() || null : null;
  const rawBrowserUrl =
    surface === "browser"
      ? (typeof options.url === "string" ? options.url : firstPositional || "")
      : "";
  const inferredPackName =
    requestedPack
    ?? (surface === "desktop" ? inferDesktopPackName(appName ?? "") : inferBrowserPackName(rawBrowserUrl));
  const request: SurfaceStateRequest = {
    surface,
    appName,
    packName: inferredPackName,
    workspaceName: typeof options.workspace === "string" ? options.workspace : `state-${surface}-${safeName(appName ?? inferredPackName ?? "current")}`,
    sampleLimit: Math.max(1, Math.min(Number(options.limit ?? 8), 20)),
    timeoutMs: Math.max(250, Number(options.timeoutMs ?? 1800)),
    requireAccessibility: options.requireAccessibility == null ? true : boolOption(options.requireAccessibility),
    waitReady: options.waitReady == null ? true : boolOption(options.waitReady),
    url: surface === "browser" ? (String(rawBrowserUrl).trim() || null) : null,
    browserProfilePath:
      surface === "browser"
        ? String(options.profile ?? options.browserProfilePath ?? process.env.AGENTOS_BROWSER_PROFILE_PATH ?? "").trim() || null
        : null
  };

  if (surface === "desktop" && !request.appName) {
    throw new Error("state --surface desktop requires --app <name> or a desktop pack that implies an app target");
  }

  const report = await collectSurfaceState(request);
  if (options.json) {
    print(report, options);
    return;
  }

  print(renderSurfaceState(report), options);
}
