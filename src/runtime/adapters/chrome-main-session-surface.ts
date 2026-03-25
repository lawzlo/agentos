import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { SurfaceAdapter } from "./surface-adapter.js";
import { RecoverableError } from "../errors.js";
import { MacOSHostBridge } from "../host-bridges/macos-bridge.js";
import { createInteractionCandidate, createWorldState, normalizeOcrBlocks, summarizeRecentActions } from "../world-state.js";
import type { ArtifactStore } from "../artifact-store.js";
import type { WorkspaceRecord } from "../../types/runtime-schema.js";

const execFileAsync = promisify(execFile);

interface ChromeTabInfo {
  id: string;
  title: string;
  url: string;
  index: number;
  windowId?: string;
  windowIndex?: number;
}

interface ChromeWindowState {
  windowId: string;
  windowIndex?: number;
  activeTabIndex: number;
  tabs: ChromeTabInfo[];
}

interface ChromeWindowInfo {
  windowNumber: number | null;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
}

interface BrowserOcrCandidate {
  text: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
    centerX: number;
    centerY: number;
  };
  confidence: number;
  role: string | null;
  sourceHints: Record<string, unknown>;
}

interface BrowserTargetWithBounds {
  text?: unknown;
  role?: unknown;
  kind?: unknown;
  bounds?: {
    x?: unknown;
    y?: unknown;
    width?: unknown;
    height?: unknown;
    centerX?: unknown;
    centerY?: unknown;
  } | null;
  sourceHints?: Record<string, unknown> | null;
}

interface CaptureImageSize {
  width: number;
  height: number;
}

interface SupplementalOcrConfig {
  source: string;
  region: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  scale: number;
}

function workspaceKey(workspace: WorkspaceRecord): string {
  return workspace.profilePath || workspace.id;
}

function normalizeSearchText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function normalizeCompactText(value: unknown): string {
  return String(value ?? "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim()
    .toLowerCase();
}

function matchesQuery(text: unknown, query: string): boolean {
  const normalizedText = normalizeSearchText(text);
  const normalizedQuery = normalizeSearchText(query);
  const compactText = normalizeCompactText(text);
  const compactQuery = normalizeCompactText(query);
  if ((!normalizedText && !compactText) || (!normalizedQuery && !compactQuery)) {
    return false;
  }

  return (
    (normalizedText && normalizedText.includes(normalizedQuery))
    || (compactText && compactText.includes(compactQuery))
    || (normalizedQuery && normalizedQuery.includes(normalizedText) && normalizedText.length >= 2)
    || (compactQuery && compactQuery.includes(compactText) && compactText.length >= 2)
  );
}

export function browserWorldStateHasVisibleText(
  state: { visibleText?: unknown; interactionCandidates?: Array<{ text?: unknown }> | null } | null | undefined,
  query: string
): boolean {
  const normalizedQuery = String(query ?? "").trim();
  if (!normalizedQuery) {
    return false;
  }

  if (matchesQuery(state?.visibleText, normalizedQuery)) {
    return true;
  }

  const candidateTexts = Array.isArray(state?.interactionCandidates)
    ? state.interactionCandidates.map((candidate) => String(candidate?.text ?? "").trim()).filter(Boolean)
    : [];
  if (candidateTexts.some((text) => matchesQuery(text, normalizedQuery))) {
    return true;
  }

  if (candidateTexts.length > 0 && matchesQuery(candidateTexts.join("\n"), normalizedQuery)) {
    return true;
  }

  return false;
}

export function browserSelectedTextLooksLikeFocusedInput(selectedText: unknown, query: string): boolean {
  const normalizedSelected = String(selectedText ?? "").trim();
  const normalizedQuery = String(query ?? "").trim();
  if (!normalizedSelected || !normalizedQuery || !matchesQuery(normalizedSelected, normalizedQuery)) {
    return false;
  }

  const queryCompactLength = normalizeCompactText(normalizedQuery).length;
  const selectedCompactLength = normalizeCompactText(normalizedSelected).length;
  if (!queryCompactLength || !selectedCompactLength) {
    return false;
  }

  if (selectedCompactLength > Math.max(queryCompactLength * 4, queryCompactLength + 80)) {
    return false;
  }

  const nonEmptyLines = normalizedSelected
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean);
  if (nonEmptyLines.length > 6) {
    return false;
  }

  return true;
}

function normalizeDraftPreviewThreadLabel(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/^[●•]\s*/u, "")
    .replace(/\s+/gu, "")
    .toLowerCase();
}

function draftPreviewThreadMatches(line: string, threadName: string): boolean {
  const normalizedLine = normalizeDraftPreviewThreadLabel(line);
  const normalizedThread = normalizeDraftPreviewThreadLabel(threadName);
  if (!normalizedLine || !normalizedThread) {
    return false;
  }
  return normalizedLine === normalizedThread
    || normalizedLine.includes(normalizedThread)
    || normalizedThread.includes(normalizedLine);
}

export function browserSelectedTextShowsDraftPreview(
  selectedText: unknown,
  query: string,
  threadName?: string | null
): boolean {
  const normalizedSelected = String(selectedText ?? "").trim();
  const normalizedQuery = String(query ?? "").trim();
  if (!normalizedSelected || !normalizedQuery || !matchesQuery(normalizedSelected, normalizedQuery)) {
    return false;
  }

  const lines = normalizedSelected
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/(草稿|draft)/iu.test(line) || !matchesQuery(line, normalizedQuery)) {
      continue;
    }
    if (!threadName) {
      return true;
    }
    for (let lookback = index - 1; lookback >= 0 && lookback >= index - 2; lookback -= 1) {
      if (draftPreviewThreadMatches(lines[lookback] ?? "", threadName)) {
        return true;
      }
    }
  }
  return false;
}

function scoreQueryMatch(text: unknown, query: string): number | null {
  const normalizedText = normalizeSearchText(text);
  const normalizedQuery = normalizeSearchText(query);
  const compactText = normalizeCompactText(text);
  const compactQuery = normalizeCompactText(query);
  if ((!normalizedText && !compactText) || (!normalizedQuery && !compactQuery)) {
    return null;
  }

  if (normalizedText && normalizedText === normalizedQuery) {
    return 120;
  }
  if (compactText && compactText === compactQuery) {
    return 116;
  }
  if (normalizedText && normalizedText.includes(normalizedQuery)) {
    return 108;
  }
  if (compactText && compactText.includes(compactQuery)) {
    return 104;
  }
  if (normalizedQuery && normalizedQuery.includes(normalizedText) && normalizedText.length >= 2) {
    return 92;
  }
  if (compactQuery && compactQuery.includes(compactText) && compactText.length >= 2) {
    return 88;
  }
  return null;
}

function inferRoleFromOcr(text: string): string {
  if (/^(send|发送|submit|回复|沟通)$/iu.test(text.trim())) {
    return "button";
  }
  if (/(message|发送消息|在线沟通|reply|chat|contact|输入)/iu.test(text)) {
    return "textbox";
  }
  return "text";
}

function inferDomainPrefix(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "";
  }
}

function normalizeChromeUrl(url: string): URL | null {
  try {
    return new URL(String(url ?? "").trim());
  } catch {
    return null;
  }
}

function targetUrlUsesReusableRule(targetUrl: string): boolean {
  const parsed = normalizeChromeUrl(targetUrl);
  if (!parsed) {
    return false;
  }
  const targetPath = normalizePathname(parsed.pathname);
  return REUSABLE_CHROME_SESSION_RULES.some((rule) =>
    rule.hostPattern.test(parsed.hostname)
    && rule.pathPatterns.some((pattern) => pattern.test(targetPath))
  );
}

function sameChromeOrigin(currentUrl: string, targetUrl: string): boolean {
  const current = normalizeChromeUrl(currentUrl);
  const target = normalizeChromeUrl(targetUrl);
  return Boolean(current && target && current.origin === target.origin);
}

function inferWorkspaceProfileName(workspace: WorkspaceRecord): string {
  const profilePath = String(workspace.profilePath ?? "").trim();
  if (profilePath) {
    return path.basename(path.dirname(profilePath));
  }
  const rootPath = String(workspace.rootPath ?? "").trim();
  if (rootPath) {
    return path.basename(rootPath);
  }
  return String(workspace.id ?? "").trim();
}

function inferWorkspacePreferredUrl(workspace: WorkspaceRecord): string | null {
  const profileName = inferWorkspaceProfileName(workspace).toLowerCase();
  if (profileName.includes("boss-browser")) {
    return "https://www.zhipin.com/web/geek/chat";
  }
  if (profileName.includes("slack-browser")) {
    return "https://app.slack.com/client";
  }
  if (profileName.includes("outlook-browser") || profileName.includes("mail-browser")) {
    return "https://outlook.office.com/mail";
  }
  return null;
}

function normalizedRegionForScreenBounds(
  targetBounds: BrowserTargetWithBounds["bounds"] | null | undefined,
  windowBounds: ChromeWindowInfo["bounds"],
  paddingPoints = 18
): { x: number; y: number; width: number; height: number } | null {
  if (!targetBounds || !windowBounds) {
    return null;
  }
  const x = Number(targetBounds.x ?? NaN);
  const y = Number(targetBounds.y ?? NaN);
  const width = Number(targetBounds.width ?? NaN);
  const height = Number(targetBounds.height ?? NaN);
  if (![x, y, width, height].every((value) => Number.isFinite(value)) || width <= 0 || height <= 0) {
    return null;
  }

  const paddedX = Math.max(Number(windowBounds.x ?? 0), x - paddingPoints);
  const paddedY = Math.max(Number(windowBounds.y ?? 0), y - paddingPoints);
  const paddedRight = Math.min(
    Number(windowBounds.x ?? 0) + Number(windowBounds.width ?? 0),
    x + width + paddingPoints
  );
  const paddedBottom = Math.min(
    Number(windowBounds.y ?? 0) + Number(windowBounds.height ?? 0),
    y + height + paddingPoints
  );
  const normalizedX = (paddedX - Number(windowBounds.x ?? 0)) / Number(windowBounds.width ?? 1);
  const normalizedY = (paddedY - Number(windowBounds.y ?? 0)) / Number(windowBounds.height ?? 1);
  const normalizedWidth = (paddedRight - paddedX) / Number(windowBounds.width ?? 1);
  const normalizedHeight = (paddedBottom - paddedY) / Number(windowBounds.height ?? 1);
  if (![normalizedX, normalizedY, normalizedWidth, normalizedHeight].every((value) => Number.isFinite(value))) {
    return null;
  }

  return {
    x: Math.max(0, Math.min(1, normalizedX)),
    y: Math.max(0, Math.min(1, normalizedY)),
    width: Math.max(0, Math.min(1 - normalizedX, normalizedWidth)),
    height: Math.max(0, Math.min(1 - normalizedY, normalizedHeight))
  };
}

export function preferredBoundsClickPoint(target: BrowserTargetWithBounds | null | undefined): { x: number; y: number } | null {
  const bounds = target?.bounds ?? null;
  const x = Number(bounds?.x ?? NaN);
  const y = Number(bounds?.y ?? NaN);
  const width = Number(bounds?.width ?? NaN);
  const height = Number(bounds?.height ?? NaN);
  const centerX = Number(bounds?.centerX ?? NaN);
  const centerY = Number(bounds?.centerY ?? NaN);
  if (![x, y, width, height, centerX, centerY].every((value) => Number.isFinite(value))) {
    return null;
  }

  const source = String((target?.sourceHints ?? {})?.source ?? "").trim().toLowerCase();
  const role = String(target?.role ?? "").trim().toLowerCase();
  const kind = String(target?.kind ?? "").trim().toLowerCase();
  const hintText = [
    String((target as { text?: unknown } | null)?.text ?? "").trim(),
    String((target?.sourceHints ?? {})?.placeholder ?? "").trim(),
    String((target?.sourceHints ?? {})?.ariaLabel ?? "").trim()
  ]
    .filter(Boolean)
    .join(" ");
  if (source.startsWith("boss-compose") || /(reply input|message|chat|发送消息|在线沟通|消息输入|reply)/iu.test(hintText)) {
    const clickX = x + Math.min(Math.max(width * 0.1, 48), Math.max(12, width - 20));
    const clickY = y + Math.min(Math.max(height * 0.72, 54), Math.max(12, height - 20));
    return { x: clickX, y: clickY };
  }
  if (role === "textbox" || kind === "textbox" || kind === "textarea" || kind === "input") {
    const clickX = x + Math.min(Math.max(width * 0.12, 36), Math.max(8, width - 12));
    const clickY = y + Math.min(Math.max(height * 0.35, 24), Math.max(8, height - 10));
    return { x: clickX, y: clickY };
  }
  if (source === "vision" && (role === "text" || kind === "text")) {
    return {
      x: x + Math.min(width * 0.22, 92),
      y: y + Math.min(height * 0.36, Math.max(18, height / 2))
    };
  }

  return { x: centerX, y: centerY };
}

function isBossChatUrl(url: string): boolean {
  return /zhipin\.com\/web\/chat/iu.test(String(url ?? ""));
}

function normalizePathname(pathname: string): string {
  const normalized = String(pathname ?? "").trim();
  if (!normalized) {
    return "/";
  }
  const withoutTrailingSlash = normalized.replace(/\/+$/u, "");
  return withoutTrailingSlash || "/";
}

const REUSABLE_CHROME_SESSION_RULES: Array<{
  hostPattern: RegExp;
  pathPatterns: RegExp[];
}> = [
  {
    hostPattern: /(?:^|\.)zhipin\.com$/iu,
    pathPatterns: [
      /^\/web\/geek\/chat\/?$/iu,
      /^\/web\/chat(?:\/index)?\/?$/iu
    ]
  },
  {
    hostPattern: /(?:^|\.)app\.slack\.com$/iu,
    pathPatterns: [
      /^\/client(?:\/.*)?$/iu
    ]
  },
  {
    hostPattern: /(?:^|\.)outlook\.office\.com$/iu,
    pathPatterns: [
      /^\/mail(?:\/.*)?$/iu,
      /^\/owa(?:\/.*)?$/iu
    ]
  }
];

export function shouldReuseChromeTabUrl(currentUrl: string, targetUrl: string): boolean {
  const currentRaw = String(currentUrl ?? "").trim();
  const targetRaw = String(targetUrl ?? "").trim();
  if (!currentRaw || !targetRaw) {
    return false;
  }
  if (currentRaw === targetRaw) {
    return true;
  }

  try {
    const current = new URL(currentRaw);
    const target = new URL(targetRaw);
    if (current.origin !== target.origin) {
      return false;
    }

    const currentPath = normalizePathname(current.pathname);
    const targetPath = normalizePathname(target.pathname);
    if (currentPath === targetPath && current.search === target.search) {
      return true;
    }

    return REUSABLE_CHROME_SESSION_RULES.some((rule) =>
      rule.hostPattern.test(target.hostname)
      && rule.pathPatterns.some((pattern) => pattern.test(targetPath))
      && rule.pathPatterns.some((pattern) => pattern.test(currentPath))
    );
  } catch {
    return false;
  }
}

export function selectChromeWorkspaceTab(
  state: Pick<ChromeWindowState, "activeTabIndex" | "tabs">,
  targetUrl: string
): ChromeTabInfo | null {
  const normalizedTarget = String(targetUrl ?? "").trim();
  if (!normalizedTarget) {
    return null;
  }

  const activeTab = state.tabs.find((tab) => tab.index === state.activeTabIndex) ?? null;
  const orderedTabs = activeTab
    ? [activeTab, ...state.tabs.filter((tab) => tab.id !== activeTab.id)]
    : [...state.tabs];
  const domainPrefix = inferDomainPrefix(normalizedTarget);
  const allowDomainFallback = !targetUrlUsesReusableRule(normalizedTarget);

  return (
    orderedTabs.find((tab) => tab.url === normalizedTarget)
    ?? orderedTabs.find((tab) => shouldReuseChromeTabUrl(tab.url, normalizedTarget))
    ?? (allowDomainFallback ? orderedTabs.find((tab) => domainPrefix && tab.url.startsWith(domainPrefix)) : null)
    ?? null
  );
}

export function selectChromeWorkspaceTabFromWindows(
  windows: Array<Pick<ChromeWindowState, "activeTabIndex" | "tabs">>,
  targetUrl: string
): ChromeTabInfo | null {
  const normalizedTarget = String(targetUrl ?? "").trim();
  if (!normalizedTarget || !Array.isArray(windows) || windows.length === 0) {
    return null;
  }

  const domainPrefix = inferDomainPrefix(normalizedTarget);
  const allowDomainFallback = !targetUrlUsesReusableRule(normalizedTarget);
  const scored = windows
    .flatMap((windowState) =>
      (Array.isArray(windowState.tabs) ? windowState.tabs : []).map((tab) => {
        let score = -1;
        if (tab.url === normalizedTarget) {
          score = 300;
        } else if (shouldReuseChromeTabUrl(tab.url, normalizedTarget)) {
          score = 220;
        } else if (allowDomainFallback && domainPrefix && String(tab.url ?? "").startsWith(domainPrefix)) {
          score = 140;
        }
        if (score >= 0 && tab.index === windowState.activeTabIndex) {
          score += 25;
        }
        return { tab, score };
      })
    )
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score);

  return scored[0]?.tab ?? null;
}

function selectChromeSameOriginTabFromWindows(
  windows: Array<Pick<ChromeWindowState, "activeTabIndex" | "tabs">>,
  targetUrl: string
): ChromeTabInfo | null {
  const normalizedTarget = String(targetUrl ?? "").trim();
  if (!normalizedTarget || !Array.isArray(windows) || windows.length === 0) {
    return null;
  }
  const domainPrefix = inferDomainPrefix(normalizedTarget);
  const scored = windows
    .flatMap((windowState) =>
      (Array.isArray(windowState.tabs) ? windowState.tabs : []).map((tab) => {
        const sameOrigin = domainPrefix && String(tab.url ?? "").startsWith(domainPrefix);
        if (!sameOrigin) {
          return { tab, score: -1 };
        }
        return {
          tab,
          score: (tab.index === windowState.activeTabIndex ? 60 : 40)
        };
      })
    )
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score);
  return scored[0]?.tab ?? null;
}

function pickPrimaryChromeWindowInfo(windows: Array<Record<string, unknown>>): ChromeWindowInfo {
  const chromeWindow = windows.find((entry) => /google chrome/iu.test(String(entry.ownerName ?? ""))) ?? null;
  const windowNumber = Number((chromeWindow ?? {}).windowNumber ?? NaN);
  const rawBounds = (chromeWindow?.bounds ?? null) as Record<string, unknown> | null;
  const x = Number(rawBounds?.x ?? NaN);
  const y = Number(rawBounds?.y ?? NaN);
  const width = Number(rawBounds?.width ?? NaN);
  const height = Number(rawBounds?.height ?? NaN);
  return {
    windowNumber: Number.isFinite(windowNumber) && windowNumber > 0 ? windowNumber : null,
    bounds:
      [x, y, width, height].every((value) => Number.isFinite(value)) && width > 0 && height > 0
        ? { x, y, width, height }
        : null
  };
}

export function parseChromeJxaResult(stdout: string, stderr: string): unknown {
  const primary = String(stdout ?? "").trim();
  const fallback = String(stderr ?? "").trim();
  const output = primary || fallback;
  if (!output) {
    return null;
  }
  return JSON.parse(output);
}

async function readPngDimensions(filePath: string): Promise<CaptureImageSize | null> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const header = Buffer.alloc(24);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (bytesRead < 24) {
        return null;
      }
      if (header.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
        return null;
      }
      return {
        width: header.readUInt32BE(16),
        height: header.readUInt32BE(20)
      };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export function translateOcrBoundsToScreen(
  bounds: Record<string, unknown> | null | undefined,
  windowBounds: ChromeWindowInfo["bounds"],
  captureImageSize: CaptureImageSize | null = null
) {
  const x = Number(bounds?.x ?? NaN);
  const y = Number(bounds?.y ?? NaN);
  const width = Number(bounds?.width ?? NaN);
  const height = Number(bounds?.height ?? NaN);
  const centerX = Number(bounds?.centerX ?? NaN);
  const centerY = Number(bounds?.centerY ?? NaN);
  if (![x, y, width, height, centerX, centerY].every((value) => Number.isFinite(value))) {
    return bounds;
  }
  if (!windowBounds) {
    return bounds;
  }
  const scaleX =
    captureImageSize && captureImageSize.width > 0 && Number(windowBounds.width) > 0
      ? captureImageSize.width / Number(windowBounds.width)
      : 1;
  const scaleY =
    captureImageSize && captureImageSize.height > 0 && Number(windowBounds.height) > 0
      ? captureImageSize.height / Number(windowBounds.height)
      : 1;
  return {
    x: x / scaleX + windowBounds.x,
    y: y / scaleY + windowBounds.y,
    width: width / scaleX,
    height: height / scaleY,
    centerX: centerX / scaleX + windowBounds.x,
    centerY: centerY / scaleY + windowBounds.y
  };
}

function mergeOcrBlocks(
  blocks: Array<{ text?: string; confidence?: number; bounds?: Record<string, unknown>; box?: Record<string, unknown>; source?: string }>
) {
  const seen = new Set<string>();
  const merged: Array<{ text?: string; confidence?: number; bounds?: Record<string, unknown>; source?: string }> = [];
  for (const block of blocks) {
    const text = String(block?.text ?? "").trim();
    if (!text) {
      continue;
    }
    const bounds = block?.bounds ?? block?.box ?? {};
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
      text,
      confidence: block?.confidence,
      bounds,
      source: block?.source
    });
  }
  return merged;
}

export function supplementalOcrConfigsForUrl(url: string): SupplementalOcrConfig[] {
  if (isBossChatUrl(url)) {
    return [
      {
        source: "ocr-boss-modal",
        region: { x: 0.32, y: 0.02, width: 0.36, height: 0.18 },
        scale: 2.2
      },
      {
        source: "ocr-boss-list-names",
        region: { x: 0.22, y: 0.17, width: 0.12, height: 0.78 },
        scale: 3.0
      },
      {
        source: "ocr-boss-list",
        region: { x: 0.2, y: 0.15, width: 0.24, height: 0.8 },
        scale: 2.2
      },
      {
        source: "ocr-boss-thread",
        region: { x: 0.42, y: 0.15, width: 0.48, height: 0.8 },
        scale: 2.0
      },
      {
        source: "ocr-boss-compose",
        region: { x: 0.42, y: 0.72, width: 0.48, height: 0.18 },
        scale: 2.2
      }
    ];
  }
  return [];
}

export class ChromeMainSessionSurfaceAdapter extends SurfaceAdapter {
  artifactStore: ArtifactStore;
  bridge: MacOSHostBridge;
  workspaceTabs: Map<string, string>;

  constructor({
    artifactStore,
    dataDir
  }: {
    artifactStore: ArtifactStore;
    dataDir: string;
  }) {
    super("browser");
    this.artifactStore = artifactStore;
    this.bridge = new MacOSHostBridge({ dataDir });
    this.workspaceTabs = new Map();
  }

  async #runChromeJxa<T = unknown>(source: string, payload: Record<string, unknown> = {}): Promise<T | null> {
    const script = `
      ObjC.import('stdlib');
      const chrome = Application('Google Chrome');
      chrome.includeStandardAdditions = true;
      const payload = JSON.parse($.getenv('AGENTOS_CHROME_PAYLOAD') || '{}');
      ${source}
    `;
    const { stdout, stderr } = await execFileAsync(
      "osascript",
      ["-l", "JavaScript", "-e", script],
      {
        env: {
          ...process.env,
          AGENTOS_CHROME_PAYLOAD: JSON.stringify(payload)
        },
        maxBuffer: 1024 * 1024 * 4
      }
    );
    return parseChromeJxaResult(String(stdout ?? ""), String(stderr ?? "")) as T | null;
  }

  async #listWindows(): Promise<ChromeWindowState[]> {
    const state = await this.#runChromeJxa<{ windows?: ChromeWindowState[] }>(`
      if (!chrome.windows.length) {
        console.log(JSON.stringify({ windows: [] }));
      } else {
        const payload = {
          windows: chrome.windows().map((win, windowIndex) => {
            const activeTabIndex = Number(win.activeTabIndex());
            return {
              windowId: String(win.id()),
              windowIndex: windowIndex + 1,
              activeTabIndex,
              tabs: win.tabs().map((tab, index) => ({
                id: String(tab.id()),
                title: String(tab.title() || ""),
                url: String(tab.url() || ""),
                index: index + 1,
                windowId: String(win.id()),
                windowIndex: windowIndex + 1
              }))
            };
          })
        };
        console.log(JSON.stringify(payload));
      }
    `);
    return Array.isArray(state?.windows) ? state.windows : [];
  }

  async #activateChrome() {
    await execFileAsync("open", ["-a", "Google Chrome"]);
    await this.#runChromeJxa(`
      if (!chrome.windows.length) {
        console.log("null");
      } else {
        chrome.activate();
        console.log(JSON.stringify({ activated: true }));
      }
    `);
  }

  async #ensureChromeReady() {
    await this.#activateChrome();
    const windows = await this.#listWindows();
    if (!windows.length) {
      throw new Error("Google Chrome is not open.");
    }
    return windows;
  }

  async #activateTabById(tabId: string): Promise<ChromeTabInfo | null> {
    const payload = await this.#runChromeJxa<ChromeTabInfo>(
      `
        if (!chrome.windows.length) {
          console.log("null");
        } else {
          const windows = chrome.windows();
          let matched = null;
          for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
            const win = windows[windowIndex];
            const tabs = win.tabs();
            const targetIndex = tabs.findIndex((tab) => String(tab.id()) === String(payload.tabId));
            if (targetIndex !== -1) {
              matched = { win, tabs, targetIndex, windowIndex };
              break;
            }
          }
          if (!matched) {
            console.log("null");
          } else {
            chrome.activate();
            const { win, tabs, targetIndex, windowIndex } = matched;
            win.activeTabIndex = targetIndex + 1;
            win.index = 1;
            const tab = tabs[targetIndex];
            console.log(JSON.stringify({
              id: String(tab.id()),
              title: String(tab.title() || ""),
              url: String(tab.url() || ""),
              index: targetIndex + 1,
              windowId: String(win.id()),
              windowIndex: windowIndex + 1
            }));
          }
        }
      `,
      { tabId }
    );
    return payload as ChromeTabInfo | null;
  }

  async #createTab(initialUrl: string): Promise<ChromeTabInfo> {
    const created = await this.#runChromeJxa<ChromeTabInfo>(
      `
        if (!chrome.windows.length) {
          chrome.activate();
        }
        const win = chrome.windows[0];
        const newTab = chrome.Tab({ url: String(payload.url || "about:blank") });
        win.tabs.push(newTab);
        const tabs = win.tabs();
        const targetIndex = tabs.length - 1;
        win.activeTabIndex = targetIndex + 1;
        const tab = tabs[targetIndex];
        console.log(JSON.stringify({
          id: String(tab.id()),
          title: String(tab.title() || ""),
          url: String(tab.url() || ""),
          index: targetIndex + 1,
          windowId: String(win.id()),
          windowIndex: 1
        }));
      `,
      { url: initialUrl || "about:blank" }
    );
    return created as ChromeTabInfo;
  }

  async #setTabUrl(tabId: string, url: string): Promise<ChromeTabInfo | null> {
    const result = await this.#runChromeJxa<ChromeTabInfo>(
      `
        if (!chrome.windows.length) {
          console.log("null");
        } else {
          const windows = chrome.windows();
          let matched = null;
          for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
            const win = windows[windowIndex];
            const tabs = win.tabs();
            const targetIndex = tabs.findIndex((tab) => String(tab.id()) === String(payload.tabId));
            if (targetIndex !== -1) {
              matched = { win, tabs, targetIndex, windowIndex };
              break;
            }
          }
          if (!matched) {
            console.log("null");
          } else {
            chrome.activate();
            const { win, tabs, targetIndex, windowIndex } = matched;
            win.activeTabIndex = targetIndex + 1;
            win.index = 1;
            const tab = tabs[targetIndex];
            tab.url = String(payload.url || "about:blank");
            delay(0.4);
            console.log(JSON.stringify({
              id: String(tab.id()),
              title: String(tab.title() || ""),
              url: String(tab.url() || ""),
              index: targetIndex + 1,
              windowId: String(win.id()),
              windowIndex: windowIndex + 1
            }));
          }
        }
      `,
      { tabId, url }
    );
    return result as ChromeTabInfo | null;
  }

  async #ensureWorkspaceTab(workspace: WorkspaceRecord, preferredUrl?: string | null): Promise<ChromeTabInfo> {
    const windows = await this.#ensureChromeReady();
    const key = workspaceKey(workspace);
    const existingTabId = this.workspaceTabs.get(key);

    if (existingTabId) {
      const active = await this.#activateTabById(existingTabId);
      if (active) {
        if (preferredUrl && !sameChromeOrigin(active.url, preferredUrl) && !shouldReuseChromeTabUrl(active.url, preferredUrl)) {
          const updated = await this.#setTabUrl(existingTabId, preferredUrl);
          return updated ?? active;
        }
        return active;
      }
    }

    const targetUrl = String(preferredUrl ?? "").trim();
    if (targetUrl) {
      const matching = selectChromeWorkspaceTabFromWindows(windows, targetUrl);
      if (matching) {
        this.workspaceTabs.set(key, matching.id);
        const active = await this.#activateTabById(matching.id);
        if (active && !shouldReuseChromeTabUrl(active.url, targetUrl)) {
          const updated = await this.#setTabUrl(active.id, targetUrl);
          return updated ?? active;
        }
        return active ?? matching;
      }
    }

    const created = await this.#createTab(targetUrl || "about:blank");
    this.workspaceTabs.set(key, created.id);
    return created;
  }

  async #activeTabInfo(workspace: WorkspaceRecord): Promise<ChromeTabInfo> {
    const windows = await this.#ensureChromeReady();
    const key = workspaceKey(workspace);
    const existingTabId = this.workspaceTabs.get(key);
    if (existingTabId) {
      const active = await this.#activateTabById(existingTabId);
      if (active) {
        return active;
      }
    }
    const preferredUrl = inferWorkspacePreferredUrl(workspace);
    if (preferredUrl) {
      const matching = selectChromeWorkspaceTabFromWindows(windows, preferredUrl);
      if (matching) {
        this.workspaceTabs.set(key, matching.id);
        const active = await this.#activateTabById(matching.id);
        if (active) {
          return active;
        }
        return matching;
      }
      const sameOriginFallback = selectChromeSameOriginTabFromWindows(windows, preferredUrl);
      if (sameOriginFallback) {
        this.workspaceTabs.set(key, sameOriginFallback.id);
        const active = await this.#activateTabById(sameOriginFallback.id);
        if (active) {
          return active;
        }
        return sameOriginFallback;
      }
    }
    const frontWindow = windows[0] ?? null;
    const activeTab = frontWindow?.tabs.find((tab) => tab.index === frontWindow.activeTabIndex) ?? frontWindow?.tabs[0];
    if (!activeTab) {
      throw new Error("Google Chrome has no open tabs.");
    }
    this.workspaceTabs.set(key, activeTab.id);
    return activeTab;
  }

  async #captureChromeWindow({ task, workspace, traceId, label = "browser-capture" }: {
    task: { id: string };
    workspace: WorkspaceRecord;
    traceId: string | null;
    label?: string;
  }) {
    await this.#activateChrome();
    const windows = await this.bridge.listWindows().catch(() => ({ windows: [] }));
    const windowInfo = pickPrimaryChromeWindowInfo(Array.isArray(windows?.windows) ? windows.windows : []);
    const filePath = path.join(workspace.artifactsPath, `${Date.now()}-${label.replaceAll(/\s+/g, "-")}.png`);
    await fs.mkdir(workspace.artifactsPath, { recursive: true });
    await this.bridge.captureScreen(filePath, windowInfo.windowNumber);
    const imageSize = await readPngDimensions(filePath);
    return this.artifactStore.registerExistingFile({
      workspace,
      taskId: task.id,
      traceId,
      kind: "screenshot",
      label,
      filePath,
      metadata: {
        surface: "browser",
        appName: "Google Chrome",
        ...(windowInfo.windowNumber ? { windowNumber: windowInfo.windowNumber } : {}),
        ...(windowInfo.bounds ? { windowBounds: windowInfo.bounds } : {}),
        ...(imageSize ? { captureImageSize: imageSize } : {})
      }
    });
  }

  async #observeOcr({ task, workspace, traceId, label = "browser-observe", recentActions = [] }: {
    task: { id: string };
    workspace: WorkspaceRecord;
    traceId: string | null;
    label?: string;
    recentActions?: unknown[];
  }) {
    const tab = await this.#activeTabInfo(workspace);
    const capture = await this.#captureChromeWindow({ task, workspace, traceId, label });
    const windowBounds = ((capture.metadata ?? {}) as { windowBounds?: ChromeWindowInfo["bounds"] }).windowBounds ?? null;
    const captureImageSize =
      ((capture.metadata ?? {}) as { captureImageSize?: CaptureImageSize | null }).captureImageSize ?? null;
    const includeFullOcr = !isBossChatUrl(tab.url);
    const fullOcr = includeFullOcr
      ? await this.bridge.ocrImage(capture.path).catch(() => ({ observations: [] }))
      : { observations: [] };
    const supplementalConfigs = supplementalOcrConfigsForUrl(tab.url);
    const supplementalResults = await Promise.all(
      supplementalConfigs.map(async (config) => ({
        source: config.source,
        observations:
          (await this.bridge.ocrImage(capture.path, {
            region: config.region,
            scale: config.scale
          }).catch(() => ({ observations: [] }))).observations ?? []
      }))
    );
    const rawBlocks = mergeOcrBlocks([
      ...((Array.isArray(fullOcr?.observations) ? fullOcr.observations : []).map((entry) => ({
        ...entry,
        source: "ocr"
      })) as Array<{ text?: string; confidence?: number; bounds?: Record<string, unknown>; source?: string }>),
      ...supplementalResults.flatMap((entry) =>
        (Array.isArray(entry.observations) ? entry.observations : []).map((observation) => ({
          ...observation,
          source: entry.source
        }))
      )
    ]).map((entry) => ({
      ...entry,
      bounds: translateOcrBoundsToScreen(
        ((entry as { box?: Record<string, unknown>; bounds?: Record<string, unknown> }).box ?? entry.bounds ?? null),
        windowBounds,
        captureImageSize
      )
    }));
    const ocrBlocks = normalizeOcrBlocks(rawBlocks, "browser");
    const interactionCandidates = ocrBlocks.map((block, index) =>
      createInteractionCandidate(
        {
          id: `browser-ocr-${index + 1}`,
          kind: "text",
          text: block.text,
          role: inferRoleFromOcr(block.text),
          bounds: block.bounds,
          confidence: block.confidence,
          sourceHints: { source: block.source ?? "ocr" },
          isInteractive: true
        },
        index,
        "browser"
      )
    );
    const prioritizedBlocks = [
      ...ocrBlocks.filter((block) => String(block.source ?? "").startsWith("ocr-boss-")),
      ...ocrBlocks.filter((block) => !String(block.source ?? "").startsWith("ocr-boss-"))
    ];
    const visibleText = prioritizedBlocks.map((block) => block.text).join("\n").slice(0, 4000);
    return createWorldState({
      surface: "browser",
      workspaceId: workspace.id,
      appContext: {
        title: tab.title,
        url: tab.url
      },
      capture,
      ocrBlocks,
      interactionCandidates,
      visibleText,
      recentActions: summarizeRecentActions(recentActions as never),
      summary: `${tab.title} @ ${tab.url}`
    });
  }

  async #resolveQueryTarget(workspace: WorkspaceRecord, query: string) {
    const state = await this.#observeOcr({
      task: { id: "browser-query" },
      workspace,
      traceId: null,
      label: "browser-query"
    });
    const candidates: BrowserOcrCandidate[] = Array.isArray(state.interactionCandidates)
      ? (state.interactionCandidates as BrowserOcrCandidate[])
      : [];
    const ranked = candidates
      .map((candidate) => ({
        candidate,
        score: scoreQueryMatch(candidate.text, query)
      }))
      .filter((entry): entry is { candidate: (typeof candidates)[number]; score: number } => Number.isFinite(entry.score))
      .sort((left, right) => right.score - left.score);
    return {
      worldState: state,
      candidate: ranked[0]?.candidate ?? null
    };
  }

  async discover({ workspace }) {
    const tab = await this.#activeTabInfo(workspace);
    return {
      url: tab.url,
      title: tab.title
    };
  }

  async observe({ task, workspace, traceId, label = "browser-observe", recentActions = [] }) {
    return this.#observeOcr({ task, workspace, traceId, label, recentActions });
  }

  async focus({ workspace }) {
    await this.#activateChrome();
    const tab = await this.#activeTabInfo(workspace);
    return { focused: true, url: tab.url, title: tab.title };
  }

  async capture({ task, workspace, traceId, label = "browser-capture" }) {
    return this.#captureChromeWindow({ task, workspace, traceId, label });
  }

  async act({ task, step, workspace, traceId }) {
    const params = step.params ?? {};
    try {
      switch (step.action) {
        case "goto":
        case "navigate":
        case "open_url":
        case "openUrl": {
          const tab = await this.#ensureWorkspaceTab(workspace, String(params.url ?? "").trim());
          await this.#activateChrome();
          await new Promise((resolve) => setTimeout(resolve, 800));
          return { url: tab.url, title: tab.title, mode: "main_chrome" };
        }
        case "wait":
          await new Promise((resolve) => setTimeout(resolve, Number(params.ms ?? 1000)));
          return { waitedMs: Number(params.ms ?? 1000) };
        case "press":
        case "keyPress": {
          await this.#activateChrome();
          const modifiers = Array.isArray(params.modifiers)
            ? params.modifiers.map((entry) => String(entry ?? "").trim().toLowerCase()).filter(Boolean)
            : [];
          await this.bridge.pressKey(String(params.key ?? "").trim().toLowerCase(), modifiers);
          return {
            pressed: String(params.key ?? "").trim(),
            modifiers
          };
        }
        case "clickAt": {
          await this.#activateChrome();
          await this.bridge.clickAt(Number(params.x ?? 0), Number(params.y ?? 0));
          return { clicked: true, x: Number(params.x ?? 0), y: Number(params.y ?? 0), resolutionMode: "point" };
        }
        case "waitFor":
        case "waitForTarget": {
          const query = String(params.text ?? params.targetQuery ?? params.target?.text ?? "").trim();
          const timeoutMs = Number(params.timeoutMs ?? 15000);
          const started = Date.now();
          while (Date.now() - started < timeoutMs) {
            const state = await this.#observeOcr({
              task: task ?? { id: "browser-wait" },
              workspace,
              traceId,
              label: "browser-wait"
            });
            const candidates: BrowserOcrCandidate[] = Array.isArray(state.interactionCandidates)
              ? (state.interactionCandidates as BrowserOcrCandidate[])
              : [];
            if (!query || matchesQuery(state.visibleText, query) || candidates.some((candidate) => matchesQuery(candidate.text, query))) {
              return { waitedFor: query || params };
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          throw new Error(`Timed out waiting for ${query || "browser state"}`);
        }
        case "clickTarget":
        case "focusTarget": {
          await this.#activateChrome();
          const query = String(params.targetQuery ?? params.target?.text ?? "").trim();
          const resolved = query ? await this.#resolveQueryTarget(workspace, query) : { candidate: null };
          const candidate =
            resolved.candidate?.bounds
              ? resolved.candidate
              : (params.target?.bounds ? params.target : null);
          const clickPoint = resolved.candidate?.bounds
            ? { x: Number(resolved.candidate.bounds.centerX), y: Number(resolved.candidate.bounds.centerY) }
            : preferredBoundsClickPoint(params.target as BrowserTargetWithBounds | null | undefined);
          if (!candidate?.bounds || !clickPoint) {
            throw new Error(`Could not resolve target ${query || params.target?.id || "unknown"}`);
          }
          await this.bridge.clickAt(clickPoint.x, clickPoint.y);
          return {
            clicked: true,
            resolvedTarget: candidate,
            resolutionMode: resolved.candidate?.bounds ? "query" : "bounds"
          };
        }
        case "typeIntoTarget": {
          await this.#activateChrome();
          const query = String(params.targetQuery ?? params.target?.text ?? "").trim();
          const resolved = query ? await this.#resolveQueryTarget(workspace, query) : { candidate: null };
          const candidate =
            resolved.candidate?.bounds
              ? resolved.candidate
              : (params.target?.bounds ? (params.target as BrowserTargetWithBounds) : null);
          if (!candidate?.bounds) {
            throw new Error(`Could not resolve target ${query || params.target?.id || "unknown"}`);
          }
          const clickPoint = preferredBoundsClickPoint(candidate) ?? {
            x: Number(candidate.bounds.centerX),
            y: Number(candidate.bounds.centerY)
          };
          await this.bridge.clickAt(clickPoint.x, clickPoint.y);
          await new Promise((resolve) => setTimeout(resolve, 80));
          if (params.clear !== false) {
            await this.bridge.pressKey("a", ["cmd"]);
            await this.bridge.pressKey("delete", []);
            await new Promise((resolve) => setTimeout(resolve, 60));
          }
          if (typeof this.bridge.pasteText === "function") {
            await this.bridge.pasteText(String(params.text ?? ""));
          } else {
            await this.bridge.typeText(String(params.text ?? ""));
          }
          return {
            typed: String(params.text ?? "").length,
            resolvedTarget: candidate,
            resolutionMode: resolved.candidate?.bounds ? "query" : "bounds"
          };
        }
        case "scrollSurface":
          await this.bridge.scroll(Number(params.dx ?? 0), Number(params.dy ?? 800));
          return { scrolled: true, dx: Number(params.dx ?? 0), dy: Number(params.dy ?? 800) };
        case "capture":
        case "screenshot":
          return this.capture({ task, workspace, traceId, label: params.label ?? step.label });
        default:
          throw new Error(`Unsupported browser action in main Chrome mode: ${step.action}`);
      }
    } catch (error) {
      throw new RecoverableError(error instanceof Error ? error.message : String(error), { step });
    }
  }

  async verify({ task, step, workspace, traceId, expectation = {} }) {
    const check = expectation as Record<string, unknown>;
    const details: Record<string, unknown> = {};
    const state = await this.#observeOcr({
      task: task ?? { id: "browser-verify" },
      workspace,
      traceId,
      label: "browser-verify"
    });

    if (typeof check.urlIncludes === "string" && check.urlIncludes) {
      const url = String(state.appContext?.url ?? "");
      details.url = url;
      if (!url.includes(check.urlIncludes)) {
        return { ok: false, details };
      }
    }

    if (typeof check.textVisible === "string" && check.textVisible) {
      let visible = browserWorldStateHasVisibleText(state, check.textVisible);
      details.textVisible = visible;
      if (!visible) {
        const targetBounds = ((step?.params?.target ?? null) as BrowserTargetWithBounds | null)?.bounds ?? null;
        const capture = (state.capture ?? null) as { path?: string; metadata?: { windowBounds?: ChromeWindowInfo["bounds"] } } | null;
        const windowBounds = (capture?.metadata?.windowBounds ?? null) as ChromeWindowInfo["bounds"] | null;
        const region = normalizedRegionForScreenBounds(targetBounds, windowBounds, 22);
        if (region) {
          const result = await this.bridge.ocrImage(String(capture?.path ?? ""), {
            region,
            scale: 2.4
          }).catch(() => ({ observations: [] }));
          const regionText = Array.isArray(result?.observations)
            ? result.observations.map((entry) => String(entry?.text ?? "").trim()).filter(Boolean).join("\n")
            : "";
          const regionVisible = browserWorldStateHasVisibleText(
            {
              visibleText: regionText,
              interactionCandidates: Array.isArray(result?.observations)
                ? result.observations.map((entry) => ({ text: String(entry?.text ?? "").trim() }))
                : []
            },
            check.textVisible
          );
          details.regionTextVisible = regionVisible;
          details.regionTextRegion = region;
          visible = regionVisible;
        }
        if (!visible && step?.action === "typeIntoTarget" && targetBounds) {
          const clickPoint =
            preferredBoundsClickPoint((step?.params?.target ?? null) as BrowserTargetWithBounds | null)
            ?? {
              x: Number(targetBounds.centerX ?? NaN),
              y: Number(targetBounds.centerY ?? NaN)
            };
          if (Number.isFinite(clickPoint.x) && Number.isFinite(clickPoint.y)) {
            await this.#activateChrome();
            await this.bridge.clickAt(clickPoint.x, clickPoint.y);
            await new Promise((resolve) => setTimeout(resolve, 60));
            await this.bridge.pressKey("a", ["cmd"]);
            await new Promise((resolve) => setTimeout(resolve, 60));
            const selectedText = await this.bridge.captureSelectedText().catch(() => null);
            const selectedVisible = browserSelectedTextLooksLikeFocusedInput(selectedText, check.textVisible);
            const selectedDraftVisible = browserSelectedTextShowsDraftPreview(
              selectedText,
              check.textVisible,
              typeof check.draftThreadVisible === "string" ? check.draftThreadVisible : null
            );
            details.selectedTextVisible = selectedVisible;
            details.selectedDraftVisible = selectedDraftVisible;
            if (selectedText) {
              details.selectedTextPreview = String(selectedText).slice(0, 240);
            }
            visible = selectedVisible || selectedDraftVisible;
            await this.bridge.clickAt(clickPoint.x, clickPoint.y);
          }
        }
      }
      if (!visible) {
        return { ok: false, details };
      }
    }

    const targetVisible = check.targetVisible as { text?: string } | undefined;
    if (typeof targetVisible?.text === "string" && targetVisible.text) {
      const visible = browserWorldStateHasVisibleText(state, targetVisible.text);
      details.targetVisible = visible;
      if (!visible) {
        return { ok: false, details };
      }
    }

    return { ok: true, details };
  }
}
