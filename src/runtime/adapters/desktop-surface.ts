import fs from "node:fs/promises";
import path from "node:path";

import { SurfaceAdapter } from "./surface-adapter.js";
import { MacOSHostBridge } from "../host-bridges/macos-bridge.js";
import { WindowsHostBridge } from "../host-bridges/windows-bridge.js";
import { createInteractionCandidate, createWorldState, normalizeBounds, summarizeRecentActions } from "../world-state.js";
import type { BoundsLike } from "../world-state.js";
import type { SidecarAccessibilityElementInfo, SidecarAccessibilitySnapshotResult } from "../../types/native-sidecar.js";
import type { AgentModelClient } from "../model-client.js";

export interface DesktopSurfaceTimeoutConfig {
  focusMs: number;
  frontmostMs: number;
  captureMs: number;
  windowsMs: number;
  permissionsMs: number;
  accessibilityMs: number;
}

const DEFAULT_DESKTOP_SURFACE_TIMEOUTS: DesktopSurfaceTimeoutConfig = {
  focusMs: 3200,
  frontmostMs: 1400,
  captureMs: 4500,
  windowsMs: 1500,
  permissionsMs: 1500,
  accessibilityMs: 1800
};

function pickBridge(options) {
  if (process.platform === "darwin") {
    return new MacOSHostBridge(options);
  }

  if (process.platform === "win32") {
    return new WindowsHostBridge(options);
  }

  return null;
}

function resolveWorkspacePath(workspace, targetPath) {
  const raw = String(targetPath ?? "").trim();
  if (!raw) {
    throw new Error("File path is required.");
  }

  return path.isAbsolute(raw) ? raw : path.resolve(workspace.rootPath, raw);
}

function resolveAppName(params: Record<string, unknown>) {
  const name = typeof params.name === "string" && params.name.trim() ? params.name : null;
  if (name) {
    return name;
  }

  const appName = typeof params.appName === "string" && params.appName.trim() ? params.appName : null;
  return appName;
}

function uniqueStrings(values: unknown[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (!text) {
      continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(text);
  }
  return result;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeSearchText(value: unknown) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function observationMatchesQuery(text: unknown, query: string) {
  const normalizedText = normalizeSearchText(text);
  const normalizedQuery = normalizeSearchText(query);
  const compactText = normalizeCompactSearchText(text);
  const compactQuery = normalizeCompactSearchText(query);
  if ((!normalizedText && !compactText) || (!normalizedQuery && !compactQuery)) {
    return false;
  }

  return (
    (normalizedText && normalizedQuery && normalizedText.includes(normalizedQuery))
    || (compactText && compactQuery && compactText.includes(compactQuery))
  );
}

function combinedObservationPreview(observations: Array<{ text?: unknown }> = []): string {
  return uniqueStrings(observations.map((entry) => entry?.text)).join(" ").trim();
}

function findRegionObservationMatch(
  observations: Array<{ text?: unknown; confidence?: unknown; box?: unknown }> = [],
  query: string
) {
  const directMatch = observations.find((entry) => observationMatchesQuery(entry?.text, query)) ?? null;
  if (directMatch) {
    return directMatch;
  }

  const combinedText = combinedObservationPreview(observations);
  if (!combinedText || !observationMatchesQuery(combinedText, query)) {
    return null;
  }

  return {
    text: combinedText,
    confidence: null,
    box: null,
    source: "combined_preview"
  };
}

function normalizeCompactSearchText(value: unknown) {
  return String(value ?? "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim()
    .toLowerCase();
}

function candidateSearchTexts(candidate: Record<string, unknown>) {
  const sourceHints = ((candidate.sourceHints ?? {}) as Record<string, unknown>) ?? {};
  return uniqueStrings([
    candidate.text,
    sourceHints.ariaLabel,
    sourceHints.placeholder,
    sourceHints.value,
    sourceHints.roleDescription
  ]);
}

function boundsProximityScore(
  candidateBounds: Record<string, unknown> | null | undefined,
  preferredBounds: Record<string, unknown> | null | undefined
) {
  if (!candidateBounds || !preferredBounds) {
    return 0;
  }

  const candidateCenterX = Number(candidateBounds.centerX ?? NaN);
  const candidateCenterY = Number(candidateBounds.centerY ?? NaN);
  const preferredCenterX = Number(preferredBounds.centerX ?? NaN);
  const preferredCenterY = Number(preferredBounds.centerY ?? NaN);
  if (
    !Number.isFinite(candidateCenterX) ||
    !Number.isFinite(candidateCenterY) ||
    !Number.isFinite(preferredCenterX) ||
    !Number.isFinite(preferredCenterY)
  ) {
    return 0;
  }

  const dx = candidateCenterX - preferredCenterX;
  const dy = candidateCenterY - preferredCenterY;
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (!Number.isFinite(distance)) {
    return 0;
  }
  if (distance <= 12) {
    return 30;
  }
  if (distance <= 48) {
    return 18;
  }
  if (distance <= 96) {
    return 8;
  }
  return 0;
}

function scoreInteractionCandidateForQuery(
  candidate: Record<string, unknown>,
  query: string,
  preferredBounds: Record<string, unknown> | null | undefined = null
) {
  const normalizedQuery = normalizeSearchText(query);
  const compactQuery = normalizeCompactSearchText(query);
  if (!normalizedQuery && !compactQuery) {
    return null;
  }

  let textScore = 0;
  for (const text of candidateSearchTexts(candidate)) {
    const normalizedText = normalizeSearchText(text);
    const compactText = normalizeCompactSearchText(text);
    if (!normalizedText && !compactText) {
      continue;
    }

    if (normalizedText && normalizedText === normalizedQuery) {
      textScore = Math.max(textScore, 120);
      continue;
    }
    if (compactText && compactQuery && compactText === compactQuery) {
      textScore = Math.max(textScore, 118);
      continue;
    }
    if (normalizedText && normalizedText.includes(normalizedQuery)) {
      textScore = Math.max(textScore, 108);
      continue;
    }
    if (compactText && compactQuery && compactText.includes(compactQuery)) {
      textScore = Math.max(textScore, 104);
      continue;
    }
    if (normalizedText && normalizedQuery.includes(normalizedText) && normalizedText.length >= 3) {
      textScore = Math.max(textScore, 96);
      continue;
    }
    if (compactText && compactQuery && compactQuery.includes(compactText) && compactText.length >= 3) {
      textScore = Math.max(textScore, 92);
    }
  }

  if (textScore === 0) {
    return null;
  }

  let score = textScore;
  if (candidate.isInteractive !== false) {
    score += 12;
  }
  const role = String(candidate.role ?? "").trim().toLowerCase();
  if (["row", "textbox", "button", "link", "text"].includes(role)) {
    score += 8;
  }
  if (String(((candidate.sourceHints ?? {}) as Record<string, unknown>).source ?? "").toLowerCase() === "accessibility") {
    score += 8;
  }
  score += boundsProximityScore((candidate.bounds ?? null) as Record<string, unknown> | null, preferredBounds);
  return score;
}

function findBestInteractionCandidateForQuery(
  candidates: Array<Record<string, unknown>>,
  query: string,
  preferredBounds: Record<string, unknown> | null | undefined = null
) {
  const ranked = candidates
    .map((candidate) => ({
      candidate,
      score: scoreInteractionCandidateForQuery(candidate, query, preferredBounds)
    }))
    .filter((entry): entry is { candidate: Record<string, unknown>; score: number } => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score);
  return ranked[0]?.candidate ?? null;
}

function normalizeAppKey(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function desktopAppAliases(value: unknown) {
  const normalized = normalizeAppKey(value);
  if (!normalized) {
    return [];
  }

  const aliases = new Set<string>([normalized]);
  if (normalized.includes("wechat") || normalized.includes("微信")) {
    aliases.add("wechat");
    aliases.add("微信");
  }
  if (normalized.includes("outlook")) {
    aliases.add("outlook");
    aliases.add("microsoft outlook");
  }
  if (normalized.includes("slack")) {
    aliases.add("slack");
  }
  if (normalized.includes("mail")) {
    aliases.add("mail");
    aliases.add("邮件");
  }

  return [...aliases];
}

function appMatchesTargetName(currentAppName: unknown, targetAppName: unknown) {
  const currentAliases = desktopAppAliases(currentAppName);
  const targetAliases = desktopAppAliases(targetAppName);
  if (!currentAliases.length || !targetAliases.length) {
    return false;
  }

  return currentAliases.some((current) =>
    targetAliases.some((target) => current.includes(target) || target.includes(current))
  );
}

function matchingDesktopWindowsForApp(windows: Array<Record<string, unknown>>, appName: unknown) {
  const aliases = desktopAppAliases(appName);
  if (!aliases.length) {
    return [];
  }

  return windows.filter((windowInfo) => {
    const ownerName = normalizeAppKey(windowInfo.ownerName);
    const windowName = normalizeAppKey(windowInfo.windowName);
    return aliases.some((alias) => ownerName.includes(alias) || windowName.includes(alias));
  });
}

function pickPrimaryWindowNumber(windows: Array<Record<string, unknown>>, appName: unknown) {
  const matching = matchingDesktopWindowsForApp(windows, appName);
  const ranked = matching
    .map((windowInfo) => {
      const bounds = (windowInfo.bounds ?? {}) as Record<string, unknown>;
      const width = Number(bounds.width ?? 0);
      const height = Number(bounds.height ?? 0);
      return {
        windowInfo,
        area: Math.max(0, width) * Math.max(0, height)
      };
    })
    .sort((left, right) => right.area - left.area);
  const windowNumber = Number(ranked[0]?.windowInfo?.windowNumber ?? NaN);
  return Number.isFinite(windowNumber) && windowNumber > 0 ? windowNumber : null;
}

function normalizeAccessibilityRole(role: unknown, subrole: unknown) {
  const roleKey = String(role ?? "").trim().toLowerCase();
  const subroleKey = String(subrole ?? "").trim().toLowerCase();

  if (roleKey.includes("text area") || roleKey.includes("text field") || roleKey.includes("search field")) {
    return "textbox";
  }
  if (roleKey.includes("button")) {
    return "button";
  }
  if (roleKey.includes("link")) {
    return "link";
  }
  if (roleKey.includes("row")) {
    return "row";
  }
  if (roleKey.includes("checkbox")) {
    return "checkbox";
  }
  if (roleKey.includes("static text") || roleKey.includes("text")) {
    return "text";
  }
  if (roleKey.includes("group") && subroleKey.includes("text")) {
    return "text";
  }

  return roleKey || null;
}

function accessibilityElementText(element: SidecarAccessibilityElementInfo) {
  const values = uniqueStrings([element.title, element.value, element.description]);
  return values[0] ?? "";
}

function isAccessibilityElementInteractive(element: SidecarAccessibilityElementInfo, role: string | null) {
  const actions = Array.isArray(element.actions) ? element.actions.map((entry) => String(entry ?? "").toLowerCase()) : [];
  if (actions.some((action) => action.includes("press") || action.includes("confirm"))) {
    return true;
  }

  return ["textbox", "button", "link", "row", "checkbox"].includes(String(role ?? "").toLowerCase());
}

function createAccessibilityCandidates(snapshot: SidecarAccessibilitySnapshotResult | null, surface = "desktop") {
  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : [];
  return elements
    .map((element, index) => {
      const role = normalizeAccessibilityRole(element.role, element.subrole);
      const text = accessibilityElementText(element);
      const bounds = element.bounds ? normalizeBounds(element.bounds as BoundsLike) : null;
      if (!text || !bounds) {
        return null;
      }

      return createInteractionCandidate(
        {
          id: element.id ?? `${surface}-ax-${index + 1}`,
          kind: "element",
          text,
          role,
          bounds,
          confidence: 0.98,
          sourceHints: {
            source: "accessibility",
            ariaLabel: element.title ?? "",
            placeholder: element.description ?? "",
            value: element.value ?? "",
            roleDescription: element.subrole ?? "",
            actions: Array.isArray(element.actions) ? element.actions : [],
            windowTitle: element.windowTitle ?? "",
            axRole: element.role ?? "",
            axSubrole: element.subrole ?? "",
            focused: Boolean(element.focused),
            enabled: element.enabled !== false
          },
          isInteractive: isAccessibilityElementInteractive(element, role)
        },
        index,
        surface
      );
    })
    .filter(Boolean);
}

function dedupeInteractionCandidates(candidates: Array<Record<string, unknown>>) {
  const seen = new Set<string>();
  const result: Array<Record<string, unknown>> = [];
  for (const candidate of candidates) {
    const bounds = (candidate.bounds ?? {}) as Record<string, unknown>;
    const key = [
      String(candidate.text ?? "").trim().toLowerCase(),
      String(candidate.role ?? "").trim().toLowerCase(),
      Math.round(Number(bounds.centerX ?? 0)),
      Math.round(Number(bounds.centerY ?? 0))
    ].join(":");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

export class DesktopSurfaceAdapter extends SurfaceAdapter {
  artifactStore: any;
  bridge: any;
  timeouts: DesktopSurfaceTimeoutConfig;
  visualModelClient: Pick<AgentModelClient, "supportsImageJson" | "analyzeImageJson"> | null;
  constructor({ artifactStore, dataDir, timeouts = {}, visualModelClient = null }) {
    super("desktop");
    this.artifactStore = artifactStore;
    this.bridge = pickBridge({ dataDir });
    this.timeouts = {
      ...DEFAULT_DESKTOP_SURFACE_TIMEOUTS,
      ...(timeouts ?? {})
    };
    this.visualModelClient = visualModelClient;
  }

  #requireBridge() {
    if (!this.bridge) {
      throw new Error(`Desktop automation is not available on ${process.platform}.`);
    }

    return this.bridge;
  }

  #visibleText(accessibilityCandidates) {
    return uniqueStrings([
      ...accessibilityCandidates.map((candidate) => candidate.text)
    ])
      .join("\n")
      .slice(0, 4000);
  }

  async #withTimeout(promise, timeoutMs, fallbackFactory) {
    let timeoutHandle: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise((resolve, reject) => {
          timeoutHandle = setTimeout(() => {
            if (typeof fallbackFactory === "function") {
              resolve(fallbackFactory());
              return;
            }
            reject(new Error(`Desktop bridge timed out after ${timeoutMs}ms.`));
          }, Math.max(1, timeoutMs));
        })
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  async #focusAppWithVerification(bridge, appName: string) {
    const result = await this.#withTimeout(
      bridge.focusApp(appName).catch(() => ({ focused: false })),
      this.timeouts.focusMs,
      () => ({ focused: false, timedOut: true })
    );
    if (typeof bridge.getFrontmostApp !== "function") {
      return result;
    }
    const frontmost = await this.#withTimeout(
      bridge.getFrontmostApp().catch(() => ({ appName: "" })),
      this.timeouts.frontmostMs,
      () => ({ appName: "" })
    );
    if (appMatchesTargetName(String(frontmost?.appName ?? ""), appName)) {
      return {
        ...(typeof result === "object" && result ? result : {}),
        focused: true,
        frontmostApp: String(frontmost?.appName ?? "").trim(),
        timedOut: false
      };
    }
    return result;
  }

  async discover() {
    return this.#withTimeout(
      this.#requireBridge().getFrontmostApp(),
      this.timeouts.frontmostMs,
      () => ({ appName: "" })
    );
  }

  async inspectApp({ appName }: { appName: string }) {
    const bridge = this.#requireBridge();
    const targetAppName = String(appName ?? "").trim();
    const frontmostApp = await this.#withTimeout(
      bridge.getFrontmostApp().catch(() => ({ appName: "" })),
      this.timeouts.frontmostMs,
      () => ({ appName: "" })
    );
    const accessibility =
      targetAppName && typeof bridge.getAccessibilitySnapshot === "function"
        ? await this.#withTimeout(
            bridge.getAccessibilitySnapshot(targetAppName).catch(() => null),
            this.timeouts.accessibilityMs,
            () => null
          )
        : null;
    const accessibilityCandidates = createAccessibilityCandidates(accessibility, "desktop");
    const windows =
      typeof bridge.listWindows === "function"
        ? await this.#withTimeout(
            bridge
              .listWindows()
              .then((result) =>
                Array.isArray(result?.windows)
                  ? result.windows.filter((entry) => {
                      const owner = String(entry?.ownerName ?? "").trim().toLowerCase();
                      const target = targetAppName.toLowerCase();
                      return owner === target || owner.includes(target);
                    })
                  : []
              )
              .catch(() => []),
            this.timeouts.windowsMs,
            () => []
          )
        : [];
    return {
      targetAppName,
      frontmostApp: String(frontmostApp?.appName ?? "").trim() || null,
      windows,
      accessibility,
      accessibilityCandidateCount: accessibilityCandidates.length,
      interactionCandidates: accessibilityCandidates,
      visibleText: this.#visibleText(accessibilityCandidates)
    };
  }

  async waitForAppReady({
    appName,
    timeoutMs = 1500,
    pollMs = 150,
    stablePolls = 2,
    requireAccessibility = false,
    minAccessibilityCandidates = 1
  }: {
    appName: string;
    timeoutMs?: number;
    pollMs?: number;
    stablePolls?: number;
    requireAccessibility?: boolean;
    minAccessibilityCandidates?: number;
  }) {
    const bridge = this.#requireBridge();
    const targetAppName = String(appName ?? "").trim();
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let attempts = 0;
    let stableMatches = 0;
    let lastFrontmostApp: string | null = null;
    let lastAccessibilityCandidateCount = 0;
    let lastAccessibilityError: string | null = null;

    while (Date.now() <= deadline) {
      attempts += 1;
      const frontmost = await this.#withTimeout(
        bridge.getFrontmostApp().catch(() => ({ appName: "" })),
        this.timeouts.frontmostMs,
        () => ({ appName: "" })
      );
      lastFrontmostApp = String(frontmost?.appName ?? "").trim() || null;
      const matchedFrontmostApp = appMatchesTargetName(lastFrontmostApp, targetAppName);

      let accessibilityCandidateCount = 0;
      let accessibilityError: string | null = null;
      if (matchedFrontmostApp && requireAccessibility && typeof bridge.getAccessibilitySnapshot === "function") {
        const snapshot = await this.#withTimeout(
          bridge
          .getAccessibilitySnapshot(lastFrontmostApp ?? targetAppName)
          .catch((error: unknown) => {
            accessibilityError = errorMessage(error);
            return null;
          }),
          this.timeouts.accessibilityMs,
          () => {
            accessibilityError = `accessibility snapshot timed out after ${this.timeouts.accessibilityMs}ms`;
            return null;
          }
        );
        accessibilityCandidateCount = createAccessibilityCandidates(snapshot, "desktop").length;
      }

      lastAccessibilityCandidateCount = accessibilityCandidateCount;
      lastAccessibilityError = accessibilityError;
      const ready =
        matchedFrontmostApp &&
        (!requireAccessibility || accessibilityCandidateCount >= Math.max(0, minAccessibilityCandidates));
      stableMatches = ready ? stableMatches + 1 : 0;
      if (stableMatches >= Math.max(1, stablePolls)) {
        return {
          ready: true,
          attempts,
          frontmostApp: lastFrontmostApp,
          matchedFrontmostApp,
          accessibilityCandidateCount,
          accessibilityReady: !requireAccessibility || accessibilityCandidateCount >= Math.max(0, minAccessibilityCandidates),
          accessibilityError
        };
      }

      if (Date.now() + pollMs > deadline) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    return {
      ready: false,
      attempts,
      frontmostApp: lastFrontmostApp,
      matchedFrontmostApp: appMatchesTargetName(lastFrontmostApp, targetAppName),
      accessibilityCandidateCount: lastAccessibilityCandidateCount,
      accessibilityReady:
        !requireAccessibility || lastAccessibilityCandidateCount >= Math.max(0, minAccessibilityCandidates),
      accessibilityError: lastAccessibilityError
    };
  }

  async observe({ task, workspace, traceId, label = "desktop-observe", recentActions = [], targetAppName = "" }) {
    const bridge = this.#requireBridge();
    const [frontmostApp, windows, permissions] = await Promise.all([
      this.#withTimeout(
        bridge.getFrontmostApp(),
        this.timeouts.frontmostMs,
        () => ({ appName: "" })
      ),
      this.#withTimeout(
      typeof bridge.listWindows === "function"
        ? bridge.listWindows().catch(() => ({ windows: [] }))
        : Promise.resolve({ windows: [] }),
        this.timeouts.windowsMs,
        () => ({ windows: [] })
      ),
      this.#withTimeout(
      typeof bridge.getPermissionsStatus === "function"
        ? bridge.getPermissionsStatus().catch(() => null)
        : Promise.resolve(null),
        this.timeouts.permissionsMs,
        () => null
      )
    ]);
    const windowsList = Array.isArray(windows.windows) ? (windows.windows as Array<Record<string, unknown>>) : [];
    const effectiveCaptureAppName = String(targetAppName ?? "").trim() || String(frontmostApp?.appName ?? "").trim();
    const windowNumber = pickPrimaryWindowNumber(windowsList, effectiveCaptureAppName);
    let captureError: string | null = null;
    const capture = await this.capture({ task, workspace, traceId, label, windowNumber }).catch((error: unknown) => {
      captureError = errorMessage(error);
      return null;
    });
    const actualCaptureWindowNumber = Number((capture?.metadata ?? null)?.windowNumber ?? NaN);
    const accessibility =
      typeof bridge.getAccessibilitySnapshot === "function" && effectiveCaptureAppName
        ? await this.#withTimeout(
            bridge.getAccessibilitySnapshot(String(effectiveCaptureAppName)).catch(() => null),
            this.timeouts.accessibilityMs,
            () => null
          )
        : null;
    const accessibilityCandidates = createAccessibilityCandidates(accessibility, "desktop");
    const interactionCandidates = dedupeInteractionCandidates([...accessibilityCandidates]);
    const visibleText = this.#visibleText(accessibilityCandidates);

    return createWorldState({
      surface: "desktop",
      workspaceId: workspace.id,
      appContext: {
        ...frontmostApp,
        windows: windowsList,
        captureWindowNumber: Number.isFinite(actualCaptureWindowNumber) && actualCaptureWindowNumber > 0 ? actualCaptureWindowNumber : null,
        permissions,
        accessibility,
        accessibilityCandidateCount: accessibilityCandidates.length,
        targetAppName: effectiveCaptureAppName || null,
        captureAvailable: Boolean(capture),
        captureError
      },
      capture,
      interactionCandidates,
      visibleText,
      recentActions: summarizeRecentActions(recentActions),
      summary: `${effectiveCaptureAppName || frontmostApp.appName} with ${accessibilityCandidates.length} accessibility candidates across ${(windows.windows ?? []).length} windows`
    });
  }

  async capture({ task, workspace, traceId, label = "desktop-capture", windowNumber = null, targetAppName = "" }) {
    const bridge = this.#requireBridge();
    const filePath = path.join(workspace.artifactsPath, `${Date.now()}-${label.replaceAll(/\s+/g, "-")}.png`);
    const effectiveTargetAppName = String(targetAppName ?? "").trim();
    let requestedWindowNumber = Number.isFinite(Number(windowNumber)) && Number(windowNumber) > 0
      ? Number(windowNumber)
      : null;
    if (!requestedWindowNumber && effectiveTargetAppName && typeof bridge.listWindows === "function") {
      const listedWindows = await this.#withTimeout(
        bridge.listWindows().catch(() => ({ windows: [] })),
        this.timeouts.windowsMs,
        () => ({ windows: [] })
      );
      const windowsList = Array.isArray(listedWindows?.windows) ? listedWindows.windows as Array<Record<string, unknown>> : [];
      requestedWindowNumber = pickPrimaryWindowNumber(windowsList, effectiveTargetAppName);
    }
    let captureResult: Record<string, unknown> | null = null;
    try {
      captureResult = await this.#withTimeout(
        bridge.captureScreen(filePath, requestedWindowNumber),
        this.timeouts.captureMs,
        null
      );
    } catch (error) {
      if (!requestedWindowNumber) {
        throw error;
      }
      captureResult = await this.#withTimeout(bridge.captureScreen(filePath, null), this.timeouts.captureMs, null);
    }
    const actualWindowNumber = Number(captureResult?.windowNumber ?? NaN);
    return this.artifactStore.registerExistingFile({
      workspace,
      taskId: task.id,
      traceId,
      kind: "screenshot",
      label,
      filePath,
      metadata: {
        surface: "desktop",
        ...(Number.isFinite(actualWindowNumber) && actualWindowNumber > 0 ? { windowNumber: actualWindowNumber } : {})
      }
    });
  }

  async focus(args: { step?: { params?: Record<string, unknown> } } = {}) {
    const bridge = this.#requireBridge();
    const step = args.step;
    const appName = step?.params ? resolveAppName(step.params) : null;
    if (appName) {
      return this.#focusAppWithVerification(bridge, appName);
    }

    return { focused: false };
  }

  async #resolveTargetPoint({
    task,
    workspace,
    traceId,
    step,
    label,
    allowBoundsFallback = true
  }: {
    task: any;
    workspace: any;
    traceId: any;
    step: { id?: string; params?: Record<string, unknown> };
    label: string;
    allowBoundsFallback?: boolean;
  }): Promise<
    | {
        kind: "interaction" | "bounds";
        point: { x: number; y: number };
        candidate?: Record<string, unknown> | null;
      }
    | null
  > {
    const params = step.params ?? {};
    const target = params.target as Record<string, unknown> | undefined;
    const targetText = String(params.targetQuery ?? target?.text ?? "").trim();
    const preferredBounds = (target?.bounds ?? null) as Record<string, unknown> | null;

    const observation = await this.observe({
      task,
      workspace,
      traceId,
      label,
      recentActions: [],
      targetAppName: resolveAppName(params) ?? ""
    }).catch(() => null);

    if (targetText) {
      const interactionCandidates = Array.isArray((observation as { interactionCandidates?: unknown[] } | null)?.interactionCandidates)
        ? ((observation as { interactionCandidates?: Array<Record<string, unknown>> }).interactionCandidates ?? [])
        : [];
      const interactionMatch = findBestInteractionCandidateForQuery(interactionCandidates, targetText, preferredBounds);
      if (interactionMatch?.bounds) {
        return {
          kind: "interaction",
          point: {
            x: Number((interactionMatch.bounds as Record<string, unknown>).centerX ?? 0),
            y: Number((interactionMatch.bounds as Record<string, unknown>).centerY ?? 0)
          },
          candidate: interactionMatch
        };
      }
    }

    if (allowBoundsFallback && preferredBounds) {
      return {
        kind: "bounds",
        point: {
          x: Number(preferredBounds.centerX ?? 0),
          y: Number(preferredBounds.centerY ?? 0)
        },
        candidate: target ?? null
      };
    }

    return null;
  }

  async act({ task, step, workspace, traceId }) {
    const params = step.params ?? {};

    switch (step.action) {
      case "readFileText": {
        const filePath = resolveWorkspacePath(workspace, params.path);
        return { path: filePath, text: await fs.readFile(filePath, "utf8") };
      }
      case "writeFileText": {
        const filePath = resolveWorkspacePath(workspace, params.path);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, String(params.text ?? ""), "utf8");
        return { path: filePath, written: true };
      }
      case "appendFileText": {
        const filePath = resolveWorkspacePath(workspace, params.path);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.appendFile(filePath, String(params.text ?? ""), "utf8");
        return { path: filePath, appended: true };
      }
      case "moveFile": {
        const fromPath = resolveWorkspacePath(workspace, params.from);
        const toPath = resolveWorkspacePath(workspace, params.to);
        await fs.mkdir(path.dirname(toPath), { recursive: true });
        await fs.rename(fromPath, toPath);
        return { fromPath, toPath, moved: true };
      }
      case "copyFile": {
        const fromPath = resolveWorkspacePath(workspace, params.from);
        const toPath = resolveWorkspacePath(workspace, params.to);
        await fs.mkdir(path.dirname(toPath), { recursive: true });
        await fs.copyFile(fromPath, toPath);
        return { fromPath, toPath, copied: true };
      }
      case "listFiles": {
        const dirPath = resolveWorkspacePath(workspace, params.path ?? ".");
        return { path: dirPath, entries: await fs.readdir(dirPath) };
      }
    }

    const bridge = this.#requireBridge();

    switch (step.action) {
      case "launchApp": {
        const appName = resolveAppName(params);
        if (!appName) {
          throw new Error("launchApp requires a name or appName parameter.");
        }
        return this.#withTimeout(
          bridge.launchApp(appName),
          this.timeouts.focusMs,
          () => ({ launched: false, timedOut: true })
        );
      }
      case "focusApp": {
        const appName = resolveAppName(params);
        if (!appName) {
          throw new Error("focusApp requires a name or appName parameter.");
        }
        return this.#focusAppWithVerification(bridge, appName);
      }
      case "typeText":
        return bridge.typeText(params.text ?? "");
      case "pressKey":
        return bridge.pressKey(params.key, params.modifiers ?? []);
      case "moveMouse":
        return bridge.moveMouse(params.x, params.y);
      case "clickAt":
        return bridge.clickAt(params.x, params.y);
      case "scroll":
      case "scrollSurface":
        return bridge.scroll(params.dx ?? 0, params.dy ?? 0);
      case "clickText": {
        const targetText = String(params.text ?? "").trim();
        const observation = await this.observe({ task, workspace, traceId, label: `click-text-${step.id}` });
        const candidate = findBestInteractionCandidateForQuery(
          Array.isArray(observation?.interactionCandidates) ? observation.interactionCandidates as Array<Record<string, unknown>> : [],
          targetText
        );
        if (!candidate?.bounds) {
          throw new Error(`Could not locate text "${params.text}" on screen.`);
        }
        const bounds = candidate.bounds as Record<string, unknown>;
        await bridge.clickAt(Number(bounds.centerX ?? 0), Number(bounds.centerY ?? 0));
        return { found: true, method: "interaction", match: candidate };
      }
      case "waitForText": {
        const timeoutMs = params.timeoutMs ?? 10000;
        const pollMs = params.pollMs ?? 500;
        const started = Date.now();
        const targetText = String(params.text ?? "").trim();

        while (Date.now() - started < timeoutMs) {
          const observation = await this.observe({ task, workspace, traceId, label: `wait-${step.id}` });
          const interactionCandidates = Array.isArray(observation?.interactionCandidates)
            ? observation.interactionCandidates as Array<Record<string, unknown>>
            : [];
          const foundCandidate = findBestInteractionCandidateForQuery(interactionCandidates, targetText);
          if (foundCandidate || String(observation?.visibleText ?? "").includes(targetText)) {
            return {
              found: true,
              method: foundCandidate ? "interaction" : "visibleText",
              match: foundCandidate ?? { text: targetText }
            };
          }
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }

        throw new Error(`Timed out waiting for text "${params.text}" on screen.`);
      }
      case "clickTarget":
      case "focusTarget": {
        const target = params.target as Record<string, unknown> | undefined;
        const resolved = await this.#resolveTargetPoint({
          task,
          workspace,
          traceId,
          step,
          label: `target-${step.id}`,
          allowBoundsFallback: params.allowBoundsFallback !== false
        });
        if (!resolved) {
          throw new Error(`Target ${target?.id ?? "unknown"} is missing bounds.`);
        }
        return bridge.clickAt(resolved.point.x, resolved.point.y);
      }
      case "typeIntoTarget": {
        const resolved = await this.#resolveTargetPoint({
          task,
          workspace,
          traceId,
          step,
          label: `type-target-${step.id}`,
          allowBoundsFallback: params.allowBoundsFallback !== false
        });
        if (resolved) {
          await bridge.clickAt(resolved.point.x, resolved.point.y);
        }
        const inputMethod = String(params.inputMethod ?? "type").trim().toLowerCase();
        if (params.clear !== false) {
          await bridge.pressKey("a", ["cmd"]);
          await new Promise((resolve) => setTimeout(resolve, inputMethod === "paste" ? 100 : 60));
          if (inputMethod !== "paste") {
            await bridge.pressKey("delete", []);
            await new Promise((resolve) => setTimeout(resolve, 80));
          }
        }
        if (inputMethod === "paste" && typeof bridge.pasteText === "function") {
          return bridge.pasteText(params.text ?? "");
        }
        return bridge.typeText(params.text ?? "");
      }
      case "waitForTarget": {
        const timeoutMs = params.timeoutMs ?? 10000;
        const pollMs = params.pollMs ?? 500;
        const targetText = String(params.target?.text ?? params.targetQuery ?? "").trim();
        const started = Date.now();

        while (Date.now() - started < timeoutMs) {
          const resolved = await this.#resolveTargetPoint({
            task,
            workspace,
            traceId,
            step,
            label: `wait-target-${step.id}`,
            allowBoundsFallback: false
          });
          if (resolved) {
            return { found: true, method: resolved.kind, match: { text: targetText } };
          }
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }

        throw new Error(`Timed out waiting for target "${targetText}".`);
      }
      case "extractFromTarget":
        return { text: params.target?.text ?? "" };
      case "wait":
        await new Promise((resolve) => setTimeout(resolve, params.ms ?? 1000));
        return { waitedMs: params.ms ?? 1000 };
      case "shell":
        return bridge.runCommand(params.command, params.cwd ?? workspace.rootPath);
      case "capture":
        return this.capture({ task, workspace, traceId, label: params.label ?? step.label });
      default:
        throw new Error(`Unsupported desktop action: ${step.action}`);
    }
  }

  async verify({ task, workspace, traceId, expectation = {} }: { task: any; workspace: any; traceId: any; expectation?: any }) {
    const bridge = this.#requireBridge();
    const details: Record<string, any> = {};
    const check = expectation as Record<string, any>;
    let capture: { path: string } | null = null;

    if (check.frontmostApp) {
      const expectedApp = String(check.frontmostApp ?? "").trim();
      const frontmost = await this.#withTimeout(
        bridge.getFrontmostApp().catch(() => ({ appName: "" })),
        this.timeouts.frontmostMs,
        () => ({ appName: "" })
      );
      details.frontmostApp = frontmost.appName;
      if (!appMatchesTargetName(frontmost.appName, expectedApp)) {
        const listedWindows = typeof bridge.listWindows === "function"
          ? await this.#withTimeout(
              bridge.listWindows().catch(() => ({ windows: [] })),
              this.timeouts.windowsMs,
              () => ({ windows: [] })
            )
          : { windows: [] };
        const matchingWindows = matchingDesktopWindowsForApp(
          Array.isArray(listedWindows?.windows) ? listedWindows.windows as Array<Record<string, unknown>> : [],
          expectedApp
        );
        details.frontmostAppFallback = matchingWindows.length > 0;
        details.frontmostAppWindowMatchCount = matchingWindows.length;
        if (!matchingWindows.length) {
          return { ok: false, details };
        }
      }
    }

    if (check.fileExists) {
      try {
        await fs.access(check.fileExists);
        details.fileExists = true;
      } catch {
        return { ok: false, details: { ...details, fileExists: false } };
      }
    }

    const regionTextVisible = check.regionTextVisible as
      | { text?: string; region?: { x?: number; y?: number; width?: number; height?: number }; scale?: number }
      | undefined;
    if (typeof regionTextVisible?.text === "string" && regionTextVisible.text.trim()) {
      const observation = await this.observe({ task, workspace, traceId, label: "verify-region-text" });
      const visible = String(observation?.visibleText ?? "");
      const match = visible.includes(regionTextVisible.text)
        ? { text: regionTextVisible.text, source: "visibleText" }
        : null;
      details.regionTextVisible = Boolean(match);
      details.regionTextQuery = regionTextVisible.text;
      if (!match) {
        details.regionTextPreview = visible.split("\n").slice(0, 8);
        return { ok: false, details };
      }
      details.regionTextMatch = match;
    }

    const regionTextAnyVisible = Array.isArray(check.regionTextAnyVisible)
      ? (check.regionTextAnyVisible as Array<{
          text?: string;
          region?: { x?: number; y?: number; width?: number; height?: number };
          scale?: number;
        }>)
      : [];
    if (regionTextAnyVisible.length > 0) {
      const observation = await this.observe({ task, workspace, traceId, label: "verify-region-text-any" });
      const visible = String(observation?.visibleText ?? "");
      const attemptedChecks: Array<Record<string, unknown>> = [];
      let matchedCheck: Record<string, unknown> | null = null;
      for (const entry of regionTextAnyVisible) {
        const text = String(entry?.text ?? "").trim();
        if (!text) {
          continue;
        }
        const match = visible.includes(text);
        attemptedChecks.push({
          text,
          preview: visible.split("\n").slice(0, 8),
          matched: Boolean(match)
        });
        if (match) {
          matchedCheck = {
            text,
            match: { text, source: "visibleText" }
          };
          break;
        }
      }
      details.regionTextAnyVisible = Boolean(matchedCheck);
      details.regionTextAnyChecks = attemptedChecks;
      if (!matchedCheck) {
        return { ok: false, details };
      }
      details.regionTextAnyMatch = matchedCheck;
    }

    const visualCheck = (check.visualCheck ?? null) as
      | { type?: string; targetThread?: string; replyPreview?: string }
      | null;
    const visualAppName = (() => {
      const type = String(visualCheck?.type ?? "").trim().toLowerCase();
      if (type.startsWith("wechat_")) {
        return "WeChat";
      }
      if (type.startsWith("slack_")) {
        return "Slack";
      }
      if (type.startsWith("outlook_")) {
        return "Microsoft Outlook";
      }
      return "";
    })();
    const captureTargetAppName =
      visualAppName
      || String(check.frontmostApp ?? "").trim();
    if (visualCheck?.type && this.visualModelClient?.supportsImageJson?.()) {
      if (!capture && captureTargetAppName) {
        const observedState = await this.observe({
          task,
          workspace,
          traceId,
          label: "verify-vision",
          targetAppName: captureTargetAppName
        });
        const observedCapture = (observedState as Record<string, unknown> | null)?.capture as { path?: string } | null;
        if (typeof observedCapture?.path === "string" && observedCapture.path.trim()) {
          capture = { path: observedCapture.path };
        }
      }
      capture ??= await this.capture({
        task,
        workspace,
        traceId,
        label: "verify-vision",
        ...(captureTargetAppName ? { targetAppName: captureTargetAppName } : {})
      });
      const targetThread = String(visualCheck.targetThread ?? "").trim();
      const replyPreview = String(visualCheck.replyPreview ?? "").trim();
      const result = await this.visualModelClient.analyzeImageJson<{
        openThread: string | null;
        targetThreadOpen?: boolean | null;
        prefillVisible?: boolean | null;
      }>({
        schemaName: `agentos_${String(visualCheck.type)}_verify`,
        schema: {
          type: "object",
          properties: {
            openThread: { type: ["string", "null"] },
            targetThreadOpen: { type: ["boolean", "null"] },
            prefillVisible: { type: ["boolean", "null"] }
          },
          required: ["openThread"],
          additionalProperties: false
        },
        systemPrompt:
          `You are a strict desktop UI verifier for AgentOS. Inspect the ${visualAppName || "desktop"} screenshot and return JSON only.`,
        userPrompt:
          /_prefill$/u.test(visualCheck.type)
            ? [
                `Verify whether the current ${visualAppName || "desktop"} thread matches the target thread and whether the reply preview is visible in the active composer or draft area.`,
                `Target thread: ${targetThread}`,
                `Reply preview: ${replyPreview}`
              ].join("\n")
            : [
                `Verify whether the current ${visualAppName || "desktop"} screenshot is showing the target thread as the active open conversation.`,
                `Target thread: ${targetThread}`
              ].join("\n"),
        imagePath: capture.path,
        temperature: 0
      });
      details.visualCheck = result;
      if (/_thread$/u.test(visualCheck.type) && result.targetThreadOpen !== true) {
        return { ok: false, details };
      }
      if (/_prefill$/u.test(visualCheck.type)) {
        if (result.targetThreadOpen !== true || result.prefillVisible !== true) {
          return { ok: false, details };
        }
      }
    }

    const targetText = check.textVisible ?? check.targetVisible?.text;
    if (targetText) {
      const observation = await this.observe({ task, workspace, traceId, label: "verify-text" });
      const interactionCandidates = Array.isArray(observation?.interactionCandidates)
        ? observation.interactionCandidates as Array<Record<string, unknown>>
        : [];
      const foundCandidate = findBestInteractionCandidateForQuery(interactionCandidates, String(targetText));
      const found = Boolean(foundCandidate) || String(observation?.visibleText ?? "").includes(String(targetText));
      details.textVisible = found;
      if (!found) {
        return { ok: false, details };
      }
      details.textMatch = foundCandidate ?? { text: targetText, source: "visibleText" };
    }

    return { ok: true, details };
  }

  async shutdown() {
    if (typeof this.bridge?.shutdown === "function") {
      await this.bridge.shutdown();
    }
  }
}
