import fs from "node:fs/promises";
import path from "node:path";

import { SurfaceAdapter } from "./surface-adapter.js";
import { MacOSHostBridge } from "../host-bridges/macos-bridge.js";
import { WindowsHostBridge } from "../host-bridges/windows-bridge.js";
import { createInteractionCandidate, createWorldState, normalizeBounds, normalizeOcrBlocks, summarizeRecentActions } from "../world-state.js";
import type { BoundsLike } from "../world-state.js";
import type { SidecarAccessibilityElementInfo, SidecarAccessibilitySnapshotResult } from "../../types/native-sidecar.js";
import type { AgentModelClient } from "../model-client.js";

export interface DesktopSurfaceTimeoutConfig {
  focusMs: number;
  frontmostMs: number;
  captureMs: number;
  ocrMs: number;
  windowsMs: number;
  permissionsMs: number;
  accessibilityMs: number;
}

const DEFAULT_DESKTOP_SURFACE_TIMEOUTS: DesktopSurfaceTimeoutConfig = {
  focusMs: 1800,
  frontmostMs: 1400,
  captureMs: 4500,
  ocrMs: 3500,
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
  if (!normalizedText || !normalizedQuery) {
    return false;
  }

  return normalizedText.includes(normalizedQuery) || normalizedQuery.includes(normalizedText);
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

function pointWithinBounds(x: number, y: number, bounds: { x: number; y: number; width: number; height: number }) {
  return x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height;
}

function filterOcrBlocksToFrontmostWindows({
  ocrBlocks,
  frontmostApp,
  windows,
  captureWindowNumber = null
}: {
  ocrBlocks: Array<{ text?: string; bounds?: { centerX?: number; centerY?: number } }>;
  frontmostApp: Record<string, unknown> | null;
  windows: Array<Record<string, unknown>>;
  captureWindowNumber?: number | null;
}) {
  const appKey = normalizeAppKey(frontmostApp?.appName);
  if (!appKey) {
    return ocrBlocks;
  }

  const matchingWindows = windows.filter((windowInfo) => {
    const ownerName = normalizeAppKey(windowInfo.ownerName);
    const windowName = normalizeAppKey(windowInfo.windowName);
    return ownerName.includes(appKey) || windowName.includes(appKey);
  });

  if (!matchingWindows.length) {
    return ocrBlocks;
  }

  const capturedWindow = Number.isFinite(Number(captureWindowNumber))
    ? matchingWindows.find((windowInfo) => Number(windowInfo.windowNumber ?? NaN) === Number(captureWindowNumber))
    : null;
  if (capturedWindow) {
    const bounds = capturedWindow.bounds as { width?: number; height?: number } | undefined;
    const width = Number(bounds?.width ?? 0);
    const height = Number(bounds?.height ?? 0);
    if (width > 0 && height > 0) {
      const locallyFiltered = ocrBlocks.filter((block) => {
        const centerX = Number(block?.bounds?.centerX);
        const centerY = Number(block?.bounds?.centerY);
        return (
          Number.isFinite(centerX) &&
          Number.isFinite(centerY) &&
          centerX >= 0 &&
          centerX <= width &&
          centerY >= 0 &&
          centerY <= height
        );
      });
      if (locallyFiltered.length) {
        return locallyFiltered;
      }
    }
  }

  const filtered = ocrBlocks.filter((block) => {
    const centerX = Number(block?.bounds?.centerX);
    const centerY = Number(block?.bounds?.centerY);
    if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) {
      return false;
    }

    return matchingWindows.some((windowInfo) => {
      const bounds = windowInfo.bounds as { x: number; y: number; width: number; height: number } | undefined;
      if (!bounds) {
        return false;
      }
      return pointWithinBounds(centerX, centerY, bounds);
    });
  });

  return filtered.length ? filtered : ocrBlocks;
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

function isWeChatDesktopApp(value: unknown) {
  return appMatchesTargetName(value, "WeChat");
}

const WECHAT_SUPPLEMENTAL_OCR_REGIONS = [
  {
    source: "ocr-wechat-list",
    region: { x: 0.1, y: 0.09, width: 0.34, height: 0.78 },
    scale: 2.4
  },
  {
    source: "ocr-wechat-compose",
    region: { x: 0.34, y: 0.78, width: 0.6, height: 0.18 },
    scale: 2.2
  }
] as const;

function mergeOcrBlocks(blocks: Array<{ id?: string; text?: string; confidence?: number; bounds?: BoundsLike; source?: string }>) {
  const seen = new Set<string>();
  const merged: Array<{ id?: string; text?: string; confidence?: number; bounds?: BoundsLike; source?: string }> = [];
  for (const block of blocks) {
    const text = String(block?.text ?? "").trim();
    if (!text) {
      continue;
    }
    const bounds = normalizeBounds(block?.bounds ?? {});
    const key = [
      text.toLowerCase(),
      Math.round(Number(bounds.centerX ?? 0)),
      Math.round(Number(bounds.centerY ?? 0)),
      String(block?.source ?? "ocr")
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push({
      ...block,
      text,
      bounds
    });
  }
  return merged;
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

  #createCandidates(ocrBlocks) {
    return ocrBlocks.map((block, index) =>
      createInteractionCandidate(
        {
          id: block.id ?? `desktop-candidate-${index + 1}`,
          kind: "text",
          text: block.text,
          role: "text",
          bounds: block.bounds,
          confidence: block.confidence ?? 0.65,
          sourceHints: { source: block.source ?? "ocr" },
          isInteractive: true
        },
        index,
        "desktop"
      )
    );
  }

  async #collectSupplementalOcr({
    bridge,
    capturePath,
    frontmostAppName,
    windowNumber
  }: {
    bridge: Record<string, unknown>;
    capturePath: string;
    frontmostAppName: unknown;
    windowNumber: number | null;
  }) {
    if (!capturePath || !windowNumber || !isWeChatDesktopApp(frontmostAppName) || typeof bridge.ocrImage !== "function") {
      return [];
    }
    const ocrImage = bridge.ocrImage as (
      filePath: string,
      options?: { region?: { x: number; y: number; width: number; height: number }; scale?: number }
    ) => Promise<{ observations?: unknown[] }>;

    const regionResults = await Promise.all(
      WECHAT_SUPPLEMENTAL_OCR_REGIONS.map(async (entry) => {
        const result = await this.#withTimeout(
          ocrImage(capturePath, {
            region: entry.region,
            scale: entry.scale
          })
            .then((value) => ({
              observations: Array.isArray(value?.observations) ? value.observations : []
            }))
            .catch(() => ({ observations: [] })),
          this.timeouts.ocrMs,
          () => ({ observations: [] })
        );
        return normalizeOcrBlocks(
          result.observations.map((observation, index) => ({
            ...observation,
            id: `${entry.source}-${index + 1}`,
            source: entry.source
          })),
          "desktop"
        );
      })
    );

    return mergeOcrBlocks(regionResults.flat());
  }

  #visibleText(accessibilityCandidates, ocrBlocks) {
    return uniqueStrings([
      ...accessibilityCandidates.map((candidate) => candidate.text),
      ...ocrBlocks.map((block) => block.text)
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
      visibleText: this.#visibleText(accessibilityCandidates, [])
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
    const ocrResult = capture?.path
      ? await this.#withTimeout(
          bridge
            .ocrImage(capture.path)
            .then((result) => ({
              observations: Array.isArray(result?.observations) ? result.observations : [],
              error: null
            }))
            .catch((error) => ({
              observations: [],
              error: errorMessage(error)
            })),
          this.timeouts.ocrMs,
          () => ({
            observations: [],
            error: `ocr_image timed out after ${this.timeouts.ocrMs}ms`
          })
        )
      : {
          observations: [],
          error: captureError ? `capture unavailable: ${captureError}` : "capture unavailable"
        };
    const accessibility =
      typeof bridge.getAccessibilitySnapshot === "function" && effectiveCaptureAppName
        ? await this.#withTimeout(
            bridge.getAccessibilitySnapshot(String(effectiveCaptureAppName)).catch(() => null),
            this.timeouts.accessibilityMs,
            () => null
          )
        : null;
    const ocrError = typeof ocrResult?.error === "string" && ocrResult.error.trim() ? ocrResult.error.trim() : null;
    const supplementalOcrBlocks = capture?.path
      ? await this.#collectSupplementalOcr({
          bridge,
          capturePath: capture.path,
          frontmostAppName: frontmostApp?.appName,
          windowNumber: Number.isFinite(actualCaptureWindowNumber) && actualCaptureWindowNumber > 0 ? actualCaptureWindowNumber : null
        })
      : [];
    const ocrBlocks = filterOcrBlocksToFrontmostWindows({
      ocrBlocks: mergeOcrBlocks([
        ...normalizeOcrBlocks(ocrResult.observations ?? [], "desktop"),
        ...supplementalOcrBlocks
      ]),
      frontmostApp: { ...(frontmostApp ?? {}), appName: effectiveCaptureAppName } as Record<string, unknown>,
      windows: windowsList,
      captureWindowNumber: Number.isFinite(actualCaptureWindowNumber) && actualCaptureWindowNumber > 0 ? actualCaptureWindowNumber : null
    });
    const accessibilityCandidates = createAccessibilityCandidates(accessibility, "desktop");
    const interactionCandidates = dedupeInteractionCandidates([
      ...accessibilityCandidates,
      ...this.#createCandidates(ocrBlocks)
    ]);
    const visibleText = this.#visibleText(accessibilityCandidates, ocrBlocks);

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
        captureError,
        supplementalOcrBlockCount: supplementalOcrBlocks.length,
        ocrAvailable: !ocrError,
        ocrError
      },
      capture,
      ocrBlocks,
      interactionCandidates,
      visibleText,
      recentActions: summarizeRecentActions(recentActions),
      summary: `${effectiveCaptureAppName || frontmostApp.appName} with ${accessibilityCandidates.length} accessibility candidates and ${ocrBlocks.length} OCR observations across ${(windows.windows ?? []).length} windows${ocrError ? ` (OCR unavailable: ${ocrError})` : ""}`
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
      return this.#withTimeout(bridge.focusApp(appName), this.timeouts.focusMs, () => ({ focused: false, timedOut: true }));
    }

    return { focused: false };
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
        return bridge.launchApp(appName);
      }
      case "focusApp": {
        const appName = resolveAppName(params);
        if (!appName) {
          throw new Error("focusApp requires a name or appName parameter.");
        }
        return bridge.focusApp(appName);
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
        const capture = await this.capture({ task, workspace, traceId, label: `ocr-${step.id}` });
        const result = await bridge.findText(capture.path, params.text);
        if (!result.found) {
          throw new Error(`Could not locate text "${params.text}" on screen.`);
        }
        const box = result.match.box;
        await bridge.clickAt(box.centerX, box.centerY);
        return result;
      }
      case "ocrScreen": {
        const capture = await this.capture({ task, workspace, traceId, label: `ocr-${step.id}` });
        return bridge.ocrImage(capture.path);
      }
      case "waitForText": {
        const timeoutMs = params.timeoutMs ?? 10000;
        const pollMs = params.pollMs ?? 500;
        const started = Date.now();

        while (Date.now() - started < timeoutMs) {
          const capture = await this.capture({ task, workspace, traceId, label: `wait-${step.id}` });
          const result = await bridge.findText(capture.path, params.text);
          if (result.found) {
            return result;
          }
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }

        throw new Error(`Timed out waiting for text "${params.text}" on screen.`);
      }
      case "clickTarget":
      case "focusTarget": {
        const target = params.target;
        if (!target?.bounds) {
          throw new Error(`Target ${target?.id ?? "unknown"} is missing bounds.`);
        }
        return bridge.clickAt(target.bounds.centerX, target.bounds.centerY);
      }
      case "typeIntoTarget": {
        const target = params.target;
        if (target?.bounds) {
          await bridge.clickAt(target.bounds.centerX, target.bounds.centerY);
        }
        return bridge.typeText(params.text ?? "");
      }
      case "waitForTarget": {
        const timeoutMs = params.timeoutMs ?? 10000;
        const pollMs = params.pollMs ?? 500;
        const targetText = params.target?.text ?? params.targetQuery;
        const started = Date.now();

        while (Date.now() - started < timeoutMs) {
          const capture = await this.capture({ task, workspace, traceId, label: `wait-target-${step.id}` });
          const result = await bridge.findText(capture.path, targetText);
          if (result.found) {
            return result;
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
      const frontmost = await bridge.getFrontmostApp();
      details.frontmostApp = frontmost.appName;
      if (!frontmost.appName.includes(check.frontmostApp)) {
        return { ok: false, details };
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
      capture ??= await this.capture({ task, workspace, traceId, label: "verify-region-text" });
      const region = regionTextVisible.region ?? null;
      const scale = Number(regionTextVisible.scale ?? 0);
      const result = await bridge.ocrImage(capture.path, {
        ...(region ? { region } : {}),
        ...(Number.isFinite(scale) && scale > 0 ? { scale } : {})
      });
      const observations = Array.isArray(result?.observations) ? result.observations : [];
      const match =
        observations.find((entry) => observationMatchesQuery(entry?.text, regionTextVisible.text)) ?? null;
      details.regionTextVisible = Boolean(match);
      details.regionTextQuery = regionTextVisible.text;
      if (region) {
        details.regionTextRegion = region;
      }
      if (!match) {
        details.regionTextPreview = uniqueStrings(observations.map((entry) => entry?.text)).slice(0, 8);
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
      capture ??= await this.capture({ task, workspace, traceId, label: "verify-region-text-any" });
      const attemptedChecks: Array<Record<string, unknown>> = [];
      let matchedCheck: Record<string, unknown> | null = null;
      for (const entry of regionTextAnyVisible) {
        const text = String(entry?.text ?? "").trim();
        if (!text) {
          continue;
        }
        const region = entry.region ?? null;
        const scale = Number(entry.scale ?? 0);
        const result = await bridge.ocrImage(capture.path, {
          ...(region ? { region } : {}),
          ...(Number.isFinite(scale) && scale > 0 ? { scale } : {})
        });
        const observations = Array.isArray(result?.observations) ? result.observations : [];
        const match = observations.find((observation) => observationMatchesQuery(observation?.text, text)) ?? null;
        attemptedChecks.push({
          text,
          ...(region ? { region } : {}),
          ...(Number.isFinite(scale) && scale > 0 ? { scale } : {}),
          preview: uniqueStrings(observations.map((observation) => observation?.text)).slice(0, 8),
          matched: Boolean(match)
        });
        if (match) {
          matchedCheck = {
            text,
            ...(region ? { region } : {}),
            ...(Number.isFinite(scale) && scale > 0 ? { scale } : {}),
            match
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
    const captureTargetAppName =
      String(check.frontmostApp ?? "").trim()
      || (visualCheck?.type?.startsWith("wechat_") ? "WeChat" : "");
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
          "You are a strict desktop UI verifier for AgentOS. Inspect the WeChat desktop screenshot and return JSON only.",
        userPrompt:
          visualCheck.type === "wechat_prefill"
            ? [
                "Verify whether the current WeChat thread matches the target thread and whether the reply preview is visible in the bottom composer.",
                `Target thread: ${targetThread}`,
                `Reply preview: ${replyPreview}`
              ].join("\n")
            : [
                "Verify whether the current WeChat screenshot is showing the target thread as the active open conversation.",
                `Target thread: ${targetThread}`
              ].join("\n"),
        imagePath: capture.path,
        temperature: 0
      });
      details.visualCheck = result;
      if (visualCheck.type === "wechat_thread" && result.targetThreadOpen === false) {
        return { ok: false, details };
      }
      if (visualCheck.type === "wechat_prefill") {
        if (result.targetThreadOpen === false || result.prefillVisible === false) {
          return { ok: false, details };
        }
      }
    }

    const targetText = check.textVisible ?? check.targetVisible?.text;
    if (targetText) {
      capture ??= await this.capture({ task, workspace, traceId, label: "verify-text" });
      const result = await bridge.findText(capture.path, targetText);
      details.textVisible = result.found;
      if (!result.found) {
        return { ok: false, details };
      }
      details.textMatch = result.match;
    }

    return { ok: true, details };
  }

  async shutdown() {
    if (typeof this.bridge?.shutdown === "function") {
      await this.bridge.shutdown();
    }
  }
}
