import fs from "node:fs/promises";
import path from "node:path";

import { boolOption, config, print, type CliOptions } from "../cli-utils.js";
import { AgentModelClient } from "../../src/runtime/model-client.js";
import { DesktopSurfaceAdapter, type DesktopSurfaceTimeoutConfig } from "../../src/runtime/adapters/desktop-surface.js";
import {
  analyzeDesktopConversationPackWithVision,
  type DesktopConversationPackAnalysis,
  type DesktopProbeCandidateSummary
} from "../../src/runtime/live-pack-registry.js";
import type { InteractionCandidate, TaskRecord, WorkspaceProfile, WorldState } from "../../src/types/runtime-schema.js";

interface DesktopProbeAdapter {
  focus(args: { step?: { params?: Record<string, unknown> } }): Promise<unknown>;
  waitForAppReady?: (args: {
    appName: string;
    timeoutMs?: number;
    pollMs?: number;
    stablePolls?: number;
    requireAccessibility?: boolean;
    minAccessibilityCandidates?: number;
  }) => Promise<Record<string, unknown>>;
  observe(args: {
    task: TaskRecord;
    workspace: WorkspaceProfile;
    traceId: string | null;
    label?: string;
    recentActions?: unknown[];
    targetAppName?: string;
  }): Promise<WorldState>;
  inspectApp?: (args: { appName: string }) => Promise<{
    targetAppName: string;
    frontmostApp: string | null;
    accessibility: { elements?: unknown[] } | null;
    windows?: Array<Record<string, unknown>>;
    accessibilityCandidateCount: number;
    interactionCandidates: InteractionCandidate[];
    visibleText: string;
  }>;
  shutdown(): Promise<void>;
}

export interface DesktopProbeRequest {
  appName: string;
  packName: string | null;
  workspaceName: string;
  sampleLimit: number;
  timeoutMs: number;
  requireAccessibility: boolean;
  waitReady: boolean;
}

export interface DesktopProbeReport {
  request: DesktopProbeRequest;
  readiness: Record<string, unknown> | null;
  frontmostApp: string | null;
  windowCount: number;
  accessibilityElementCount: number;
  accessibilityCandidateCount: number;
  ocrBlockCount: number;
  ocrAvailable: boolean;
  ocrError: string | null;
  capturePath: string | null;
  visibleTextPreview: string[];
  topCandidates: DesktopProbeCandidateSummary[];
  targetAppInspection: {
    frontmostApp: string | null;
    accessibilityElementCount: number;
    accessibilityCandidateCount: number;
    visibleTextPreview: string[];
    topCandidates: DesktopProbeCandidateSummary[];
  } | null;
  packAnalysis: DesktopConversationPackAnalysis | null;
}

export interface DesktopProbeDeps {
  adapter?: DesktopProbeAdapter;
  workspace?: WorkspaceProfile;
  nowIso?: () => string;
  modelClient?: Pick<AgentModelClient, "supportsImageJson" | "analyzeImageJson">;
}

function safeName(value: string) {
  return String(value).trim().toLowerCase().replaceAll(/[^a-z0-9-]+/g, "-") || "desktop-probe";
}

function inferDesktopProbePackName(appName: string): string | null {
  const normalized = String(appName ?? "").trim().toLowerCase();
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

function summarizeCandidate(candidate: InteractionCandidate): DesktopProbeCandidateSummary {
  return {
    id: String(candidate.id ?? ""),
    text: String(candidate.text ?? "").trim(),
    role: typeof candidate.role === "string" ? candidate.role : null,
    interactive: Boolean(candidate.isInteractive),
    source: String((candidate.sourceHints as Record<string, unknown> | undefined)?.source ?? "unknown"),
    bounds: (candidate.bounds as DesktopProbeCandidateSummary["bounds"]) ?? undefined,
    hints: [
      String((candidate.sourceHints as Record<string, unknown> | undefined)?.ariaLabel ?? "").trim(),
      String((candidate.sourceHints as Record<string, unknown> | undefined)?.placeholder ?? "").trim(),
      String((candidate.sourceHints as Record<string, unknown> | undefined)?.windowTitle ?? "").trim()
    ].filter(Boolean)
  };
}

function buildProbeTask(appName: string, nowIso: () => string): TaskRecord {
  const timestamp = nowIso();
  return {
    id: `probe-${Date.now()}`,
    goal: `Desktop probe for ${appName}`,
    status: "running",
    priority: "normal",
    triggerSource: "manual",
    deadline: null,
    preferredSurface: "desktop",
    workspaceId: null,
    traceId: null,
    taskSpec: {
      goal: `Desktop probe for ${appName}`,
      preferredSurface: "desktop"
    },
    plan: [],
    result: null,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

async function createProbeWorkspace(appName: string, workspaceName: string, nowIso: () => string): Promise<WorkspaceProfile> {
  const rootPath = path.join(config.dataDir, "desktop-probes", safeName(workspaceName || appName));
  const profilePath = path.join(rootPath, "profile");
  const downloadsPath = path.join(rootPath, "downloads");
  const artifactsPath = path.join(rootPath, "artifacts");
  const scratchPath = path.join(rootPath, "scratch");
  await Promise.all([
    fs.mkdir(profilePath, { recursive: true }),
    fs.mkdir(downloadsPath, { recursive: true }),
    fs.mkdir(artifactsPath, { recursive: true }),
    fs.mkdir(scratchPath, { recursive: true })
  ]);

  const timestamp = nowIso();
  return {
    id: `desktop-probe-${Date.now()}`,
    name: workspaceName,
    rootPath,
    profilePath,
    downloadsPath,
    artifactsPath,
    scratchPath,
    metadata: {
      probe: true,
      appName
    },
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function createProbeTimeouts(request: DesktopProbeRequest): Partial<DesktopSurfaceTimeoutConfig> {
  const baseTimeoutMs = Math.max(250, Number(request.timeoutMs ?? 1800));
  return {
    focusMs: Math.min(2000, baseTimeoutMs),
    frontmostMs: Math.min(1800, baseTimeoutMs),
    captureMs: Math.max(1200, Math.min(5000, baseTimeoutMs)),
    ocrMs: Math.max(1200, Math.min(5000, baseTimeoutMs)),
    windowsMs: Math.min(1800, baseTimeoutMs),
    permissionsMs: Math.min(1500, baseTimeoutMs),
    accessibilityMs: Math.min(2200, baseTimeoutMs)
  };
}

function createProbeAdapter(request: DesktopProbeRequest): DesktopProbeAdapter {
  return new DesktopSurfaceAdapter({
    dataDir: config.dataDir,
    visualModelClient: new AgentModelClient(config.model),
    timeouts: createProbeTimeouts(request),
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
    }
  }) as DesktopProbeAdapter;
}

function renderDesktopProbe(report: DesktopProbeReport) {
  const lines: string[] = [];
  lines.push("Desktop probe");
  lines.push("");
  lines.push(`Target app: ${report.request.appName}`);
  lines.push(`Pack analysis: ${report.request.packName ?? "(none)"}`);
  lines.push(`Frontmost app: ${report.frontmostApp ?? "(unknown)"}`);
  if (report.readiness) {
    lines.push(
      `Readiness: ${report.readiness.ready ? "ready" : "not ready"}`
        + `, accessibility candidates=${report.readiness.accessibilityCandidateCount ?? 0}`
    );
  }
  lines.push(
    `World state: windows=${report.windowCount}, AX elements=${report.accessibilityElementCount},`
      + ` AX candidates=${report.accessibilityCandidateCount}, OCR blocks=${report.ocrBlockCount}`
  );
  if (!report.ocrAvailable) {
    lines.push(`OCR: unavailable (${report.ocrError ?? "unknown error"})`);
  }
  if (report.capturePath) {
    lines.push(`Capture: ${report.capturePath}`);
  }
  if (report.visibleTextPreview.length) {
    lines.push("");
    lines.push("Visible text preview:");
    for (const line of report.visibleTextPreview) {
      lines.push(`- ${line}`);
    }
  }
  if (report.topCandidates.length) {
    lines.push("");
    lines.push("Top candidates:");
    for (const candidate of report.topCandidates) {
      lines.push(
        `- [${candidate.source}] ${candidate.role ?? "unknown"} ${candidate.interactive ? "interactive" : "passive"}: ${candidate.text}`
      );
    }
  }
  if (report.targetAppInspection) {
    lines.push("");
    lines.push(`Target app AX frontmost: ${report.targetAppInspection.frontmostApp ?? "(unknown)"}`);
    lines.push(
      `Target app AX: elements=${report.targetAppInspection.accessibilityElementCount},`
        + ` candidates=${report.targetAppInspection.accessibilityCandidateCount}`
    );
    if (report.targetAppInspection.visibleTextPreview.length) {
      lines.push("Target app visible text preview:");
      for (const line of report.targetAppInspection.visibleTextPreview) {
        lines.push(`- ${line}`);
      }
    }
  }
  if (report.packAnalysis) {
    lines.push("");
    lines.push(`Pack foreground: ${report.packAnalysis.foreground ? "yes" : "no"}`);
    lines.push(`Unread candidate: ${report.packAnalysis.unreadCandidate?.text ?? "(none)"}`);
    lines.push(`Composer candidate: ${report.packAnalysis.composeCandidate?.text ?? "(none)"}`);
    lines.push(`Send candidate: ${report.packAnalysis.sendCandidate?.text ?? "(none)"}`);
    if (report.packAnalysis.topUnreadCandidates.length) {
      lines.push("Top unread candidates:");
      for (const candidate of report.packAnalysis.topUnreadCandidates) {
        lines.push(`- ${candidate.text} (score=${candidate.score ?? "n/a"}, source=${candidate.source})`);
      }
    }
  }
  return lines.join("\n");
}

export async function collectDesktopProbe(request: DesktopProbeRequest, deps: DesktopProbeDeps = {}): Promise<DesktopProbeReport> {
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const adapter = deps.adapter ?? createProbeAdapter(request);
  const workspace = deps.workspace ?? (await createProbeWorkspace(request.appName, request.workspaceName, nowIso));
  const modelClient = deps.modelClient ?? new AgentModelClient(config.model);
  const task = buildProbeTask(request.appName, nowIso);

  try {
    await adapter
      .focus({
        step: {
          params: {
            name: request.appName
          }
        }
      })
      .catch(() => null);

    const readiness =
      request.waitReady && typeof adapter.waitForAppReady === "function"
        ? await adapter.waitForAppReady({
            appName: request.appName,
            timeoutMs: request.timeoutMs,
            pollMs: 150,
            stablePolls: 2,
            requireAccessibility: request.requireAccessibility,
            minAccessibilityCandidates: request.requireAccessibility ? 1 : 0
          })
        : null;

    const worldState = await adapter.observe({
      task,
      workspace,
      traceId: null,
      label: `desktop-probe-${safeName(request.appName)}`,
      targetAppName: request.appName
    });
    const targetInspection = typeof adapter.inspectApp === "function" ? await adapter.inspectApp({ appName: request.appName }) : null;

    const interactionCandidates = Array.isArray(worldState.interactionCandidates) ? worldState.interactionCandidates : [];
    const visibleTextPreview = String(worldState.visibleText ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, Math.max(3, request.sampleLimit));
    const targetInspectionHasSignals = Boolean(
      targetInspection
      && (
        Number(targetInspection.accessibilityCandidateCount ?? 0) > 0
        || (Array.isArray(targetInspection.interactionCandidates) && targetInspection.interactionCandidates.length > 0)
        || String(targetInspection.visibleText ?? "").trim()
      )
    );
    const packAnalysisWorldState =
      targetInspection && request.packName && targetInspectionHasSignals
        ? ({
            ...worldState,
            appContext: {
              ...(worldState.appContext ?? {}),
              appName: targetInspection.frontmostApp ?? null,
              targetAppName: request.appName,
              windows:
                Array.isArray(targetInspection.windows) && targetInspection.windows.length
                  ? targetInspection.windows
                  : ((worldState.appContext ?? {}) as Record<string, unknown>).windows,
              accessibility: targetInspection.accessibility,
              accessibilityCandidateCount: targetInspection.accessibilityCandidateCount
            },
            interactionCandidates:
              Array.isArray(targetInspection.interactionCandidates) && targetInspection.interactionCandidates.length
                ? targetInspection.interactionCandidates
                : worldState.interactionCandidates,
            visibleText: String(targetInspection.visibleText ?? "").trim() || String(worldState.visibleText ?? ""),
            ocrBlocks: Array.isArray(worldState.ocrBlocks) ? worldState.ocrBlocks : [],
            capture: worldState.capture
          } as WorldState)
        : worldState;
    const packAnalysis = request.packName
      ? await analyzeDesktopConversationPackWithVision({
          packName: request.packName,
          worldState: packAnalysisWorldState,
          modelClient,
          timeoutMs: Math.max(5000, request.timeoutMs)
        })
      : null;
    const appContext = (worldState.appContext ?? {}) as Record<string, unknown>;
    const accessibility = (appContext.accessibility ?? null) as { elements?: unknown[] } | null;
    const topCandidates = interactionCandidates
      .slice(0, Math.max(1, request.sampleLimit))
      .map((candidate) => summarizeCandidate(candidate));
    const targetVisibleTextPreview = String(targetInspection?.visibleText ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, Math.max(3, request.sampleLimit));
    const targetTopCandidates = Array.isArray(targetInspection?.interactionCandidates)
      ? targetInspection.interactionCandidates.slice(0, Math.max(1, request.sampleLimit)).map((candidate) => summarizeCandidate(candidate))
      : [];

    return {
      request,
      readiness: readiness ? { ...readiness } : null,
      frontmostApp: typeof appContext.appName === "string" ? appContext.appName : null,
      windowCount: Array.isArray(appContext.windows) ? appContext.windows.length : 0,
      accessibilityElementCount: Array.isArray(accessibility?.elements) ? accessibility.elements.length : 0,
      accessibilityCandidateCount: Number(appContext.accessibilityCandidateCount ?? 0),
      ocrBlockCount: Array.isArray(worldState.ocrBlocks) ? worldState.ocrBlocks.length : 0,
      ocrAvailable: appContext.ocrAvailable !== false,
      ocrError: typeof appContext.ocrError === "string" ? appContext.ocrError : null,
      capturePath: typeof worldState.capture?.path === "string" ? worldState.capture.path : null,
      visibleTextPreview,
      topCandidates,
      targetAppInspection: targetInspection
        ? {
            frontmostApp: targetInspection.frontmostApp,
            accessibilityElementCount: Array.isArray(targetInspection.accessibility?.elements)
              ? targetInspection.accessibility.elements.length
              : 0,
            accessibilityCandidateCount: Number(targetInspection.accessibilityCandidateCount ?? 0),
            visibleTextPreview: targetVisibleTextPreview,
            topCandidates: targetTopCandidates
          }
        : null,
      packAnalysis
    };
  } finally {
    if (!deps.adapter) {
      await adapter.shutdown().catch(() => null);
    }
  }
}

export async function commandDesktop(subcommand: string | undefined, positionals: string[], options: CliOptions) {
  if (subcommand !== "probe") {
    throw new Error(`Unsupported desktop command: ${subcommand ?? "(none)"}`);
  }

  const appName = String(options.app ?? positionals[0] ?? "").trim();
  if (!appName) {
    throw new Error("desktop probe requires --app <name> or a positional app name");
  }

  const sampleLimit = Math.max(1, Math.min(Number(options.limit ?? 8), 20));
  const request: DesktopProbeRequest = {
    appName,
    packName: typeof options.pack === "string" ? options.pack : inferDesktopProbePackName(appName),
    workspaceName: typeof options.workspace === "string" ? options.workspace : `desktop-probe-${safeName(appName)}`,
    sampleLimit,
    timeoutMs: Math.max(250, Number(options.timeoutMs ?? 1800)),
    requireAccessibility: options.requireAccessibility == null ? true : boolOption(options.requireAccessibility),
    waitReady: options.waitReady == null ? true : boolOption(options.waitReady)
  };

  const report = await collectDesktopProbe(request);
  if (options.json) {
    print(report, options);
    return;
  }

  print(renderDesktopProbe(report), options);
}
