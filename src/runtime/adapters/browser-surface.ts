import fs from "node:fs/promises";
import path from "node:path";

import { SurfaceAdapter } from "./surface-adapter.js";
import { DesktopSurfaceAdapter } from "./desktop-surface.js";
import { RecoverableError } from "../errors.js";
import { createWorldState, summarizeRecentActions } from "../world-state.js";
import type { ArtifactStore } from "../artifact-store.js";
import type { OpenAICompatibleModelClient } from "../model-client.js";
import type { AgentModelConfig } from "../../config.js";
import type {
  BrowserBlocker,
  BrowserExecutionInput,
  BrowserExecutionResult,
  InteractionCandidate,
  TaskRecord,
  WorkspaceRecord,
  WorldState
} from "../../types/runtime-schema.js";

interface BrowserDesktopObservation {
  version: number;
  surface: string;
  workspaceId: string;
  appContext: Record<string, unknown> | null;
  capture: unknown;
  screenTextBlocks: unknown[];
  interactionCandidates: unknown[];
  visibleText: string;
  recentActions: unknown[];
  summary: string | null;
  timestamp: string;
}

interface BrowserDesktopSurface {
  observe(args: {
    task: TaskRecord;
    workspace: WorkspaceRecord;
    traceId: string | null;
    label?: string;
    recentActions?: unknown[];
    targetAppName?: string;
  }): Promise<BrowserDesktopObservation>;
  capture(args: {
    task: TaskRecord;
    workspace: WorkspaceRecord;
    traceId: string | null;
    label?: string;
    targetAppName?: string;
  }): Promise<{ path?: string; metadata?: Record<string, unknown> }>;
  focus(args?: {
    task?: TaskRecord;
    workspace?: WorkspaceRecord;
    traceId?: string | null;
    step?: { action?: string; params?: Record<string, unknown>; label?: string };
  }): Promise<Record<string, unknown>>;
  act(args: {
    task: TaskRecord;
    workspace: WorkspaceRecord;
    traceId: string | null;
    step: { action: string; params?: Record<string, unknown>; label?: string };
  }): Promise<unknown>;
  shutdown(): Promise<void>;
}

interface BrowserVisionDecision {
  status?: "continue" | "completed" | "blocked";
  rationale?: string | null;
  blocker?: string | null;
  action?: {
    type?: "click_target" | "click_point" | "type_into_target" | "type_into_point" | "press_key" | "scroll" | "wait";
    targetId?: string | null;
    point?: { x?: number; y?: number } | null;
    text?: string | null;
    clear?: boolean | null;
    key?: string | null;
    modifiers?: string[];
    dx?: number | null;
    dy?: number | null;
    ms?: number | null;
  } | null;
}

interface BrowserSurfaceAdapterOptions {
  artifactStore: ArtifactStore;
  dataDir?: string;
  browserExecutable?: string | null;
  modelConfig: AgentModelConfig;
  visualModelClient?: Pick<OpenAICompatibleModelClient, "supportsImageJson" | "analyzeImageJson"> | null;
  desktopSurface?: BrowserDesktopSurface;
}

const BROWSER_EXECUTION_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["continue", "completed", "blocked"] },
    rationale: { type: ["string", "null"] },
    blocker: { type: ["string", "null"] },
    action: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        type: {
          type: "string",
          enum: ["click_target", "click_point", "type_into_target", "type_into_point", "press_key", "scroll", "wait"]
        },
        targetId: { type: ["string", "null"] },
        point: {
          type: ["object", "null"],
          additionalProperties: false,
          properties: {
            x: { type: "number" },
            y: { type: "number" }
          },
          required: ["x", "y"]
        },
        text: { type: ["string", "null"] },
        clear: { type: ["boolean", "null"] },
        key: { type: ["string", "null"] },
        modifiers: {
          type: "array",
          items: { type: "string" }
        },
        dx: { type: ["number", "null"] },
        dy: { type: ["number", "null"] },
        ms: { type: ["number", "null"] }
      },
      required: ["type"]
    }
  },
  required: ["status", "rationale"],
  if: {
    properties: {
      status: { const: "continue" }
    }
  },
  then: {
    required: ["action"]
  }
} as const;

const BROWSER_TEXT_VISIBILITY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    visible: { type: "boolean" },
    rationale: { type: ["string", "null"] }
  },
  required: ["visible"]
} as const;

function cleanText(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function normalizeAppKey(value: unknown): string {
  return cleanText(value).toLowerCase();
}

function truncate(value: unknown, maxLength = 140): string {
  const text = cleanText(value);
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = cleanText(value);
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

function browserShortcutModifier(): string {
  return process.platform === "darwin" ? "cmd" : "ctrl";
}

function inferBrowserAppCandidates(browserExecutable: string | null | undefined): string[] {
  const normalized = normalizeAppKey(browserExecutable);
  if (normalized.includes("microsoft edge") || normalized.includes("msedge")) {
    return ["Microsoft Edge", "Google Chrome", "Chromium"];
  }
  if (normalized.includes("chromium")) {
    return ["Chromium", "Google Chrome"];
  }
  return ["Google Chrome", "Chromium", "Microsoft Edge"];
}

function browserWindowTitle(appContext: Record<string, unknown> | null | undefined): string {
  const windows = Array.isArray(appContext?.windows) ? (appContext?.windows as Array<Record<string, unknown>>) : [];
  const captureWindowNumber = Number(appContext?.captureWindowNumber ?? NaN);
  if (Number.isFinite(captureWindowNumber) && captureWindowNumber > 0) {
    const matched = windows.find((entry) => Number(entry.windowNumber ?? NaN) === captureWindowNumber);
    const title = cleanText(matched?.windowName);
    if (title) {
      return title;
    }
  }

  for (const entry of windows) {
    const title = cleanText(entry.windowName);
    if (title) {
      return title;
    }
  }

  return cleanText(appContext?.appName);
}

function browserWindowBounds(appContext: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const windows = Array.isArray(appContext?.windows) ? (appContext?.windows as Array<Record<string, unknown>>) : [];
  const captureWindowNumber = Number(appContext?.captureWindowNumber ?? NaN);
  if (Number.isFinite(captureWindowNumber) && captureWindowNumber > 0) {
    const matched = windows.find((entry) => Number(entry.windowNumber ?? NaN) === captureWindowNumber);
    if (matched?.bounds && typeof matched.bounds === "object") {
      return matched.bounds as Record<string, unknown>;
    }
  }
  const firstBounds = windows.find((entry) => entry?.bounds && typeof entry.bounds === "object");
  return firstBounds?.bounds ? (firstBounds.bounds as Record<string, unknown>) : null;
}

function browserObservedUrl(appContext: Record<string, unknown> | null | undefined): string | null {
  return cleanText(appContext?.url) || null;
}

function detectBrowserBlockers({
  visibleText,
  title,
  lastKnownUrl,
  candidateCount
}: {
  visibleText: string;
  title: string;
  lastKnownUrl: string | null;
  candidateCount: number;
}): BrowserBlocker[] {
  const haystack = [title, visibleText].filter(Boolean).join("\n");
  const normalizedUrl = cleanText(lastKnownUrl).toLowerCase();

  if (
    /verify|captcha|slider|security|challenge/iu.test(normalizedUrl)
    || /(滑块|验证|captcha|security check|verification required|human verification|请完成验证|安全验证)/iu.test(haystack)
  ) {
    return [
      {
        kind: "verification_required",
        detail: "The current browser page requires verification before automation can continue.",
        suggestedAction: "Complete the verification in the visible browser window, then retry."
      }
    ];
  }

  if (
    /(sign in|log in|login|登录|扫码登录|账号登录|欢迎回来|重新登录|登录后继续|请先登录)/iu.test(haystack)
    && !/(logout|sign out|退出登录)/iu.test(haystack)
  ) {
    return [
      {
        kind: /session expired|会话已过期|登录状态已失效|当前登录状态已失效/iu.test(haystack)
          ? "session_expired"
          : "signin_required",
        detail: "The current browser page appears to require sign-in before automation can continue.",
        suggestedAction: "Complete sign-in in the visible browser window, then retry."
      }
    ];
  }

  if (!cleanText(haystack) && candidateCount === 0) {
    return [
      {
        kind: "page_unavailable",
        detail: "The current browser window does not expose visible page content yet.",
        suggestedAction: "Wait for the page to load or bring the intended browser tab to the foreground."
      }
    ];
  }

  return [];
}

function summarizeCandidate(candidate: Record<string, unknown>): string {
  const bounds = (candidate.bounds ?? {}) as Record<string, unknown>;
  const x = Number(bounds.centerX ?? 0);
  const y = Number(bounds.centerY ?? 0);
  return [
    `id=${String(candidate.id ?? "").trim() || "unknown"}`,
    `role=${cleanText(candidate.role) || "element"}`,
    `interactive=${candidate.isInteractive === false ? "false" : "true"}`,
    `text=${JSON.stringify(truncate(candidate.text, 160) || "")}`,
    `center=(${Math.round(x)},${Math.round(y)})`
  ].join(" ");
}

function browserInteractionCandidates(worldState: Pick<WorldState, "interactionCandidates">): Array<Record<string, unknown>> {
  return Array.isArray(worldState.interactionCandidates)
    ? (worldState.interactionCandidates as unknown as Array<Record<string, unknown>>)
    : [];
}

function renderCandidateInventory(candidates: Array<Record<string, unknown>>, limit = 80): string {
  const inventory = candidates
    .slice(0, limit)
    .map((candidate) => `- ${summarizeCandidate(candidate)}`)
    .join("\n");
  return inventory || "- none";
}

function browserVisibleTextPreview(worldState: WorldState): string {
  const lines = uniqueStrings(String(worldState.visibleText ?? "").split(/\n+/u)).slice(0, 24);
  return lines.length ? lines.map((line) => `- ${truncate(line, 180)}`).join("\n") : "- none";
}

function normalizeBrowserExecutionInput(
  params: Record<string, unknown>,
  defaultTimeoutMs: number
): BrowserExecutionInput {
  return {
    instruction: cleanText(params.instruction),
    ...(typeof params.startUrl === "string" && cleanText(params.startUrl) ? { startUrl: cleanText(params.startUrl) } : {}),
    ...(Array.isArray(params.actions)
      ? { actions: params.actions.map((entry) => cleanText(entry)).filter(Boolean) }
      : {}),
    ...(typeof params.successCriteria === "string" && cleanText(params.successCriteria)
      ? { successCriteria: cleanText(params.successCriteria) }
      : {}),
    ...(params.verificationSchema && typeof params.verificationSchema === "object"
      ? { verificationSchema: params.verificationSchema as Record<string, unknown> }
      : {}),
    maxSteps: Math.max(1, Number(params.maxSteps ?? 4)),
    timeoutMs: Math.max(1000, Number(params.timeoutMs ?? defaultTimeoutMs)),
    ...(params.variables && typeof params.variables === "object"
      ? { variables: params.variables as Record<string, unknown> }
      : {}),
    navigationPolicy: {
      allowSameTabNavigation: params.allowSameTabNavigation !== false,
      allowNewTabs: params.allowNewTabs === true,
      allowCrossOriginNavigation: params.allowCrossOriginNavigation === true
    }
  };
}

function decisionPrompt({
  instruction,
  successCriteria,
  state,
  recentActions,
  maxSteps,
  stepNumber
}: {
  instruction: string;
  successCriteria?: string;
  state: WorldState;
  recentActions: string[];
  maxSteps: number;
  stepNumber: number;
}): string {
  const title = browserWindowTitle((state.appContext ?? null) as Record<string, unknown> | null);
  const lastKnownUrl = cleanText(((state.appContext ?? {}) as Record<string, unknown>).url);
  const candidates = browserInteractionCandidates(state);

  return [
    "You are AgentOS controlling the currently visible browser window as a desktop app.",
    "Use the screenshot as the source of truth. Use the accessibility candidates only as grounding hints.",
    "Return exactly one next action that advances the instruction.",
    "Do not open a new window, popup, or browser profile.",
    "Stay in the current visible tab unless the instruction explicitly requires same-tab navigation.",
    "Do not click any send, submit, or confirm action unless the instruction explicitly says to do so.",
    "Prefer candidate ids when possible. If the visible target is not present in the candidate list, use a normalized screenshot point via click_point or type_into_point.",
    `Instruction:\n${instruction}`,
    successCriteria ? `Success criteria:\n${successCriteria}` : null,
    `Step ${stepNumber} of at most ${maxSteps}.`,
    title ? `Current window title: ${title}` : null,
    lastKnownUrl ? `Last known URL hint: ${lastKnownUrl}` : null,
    recentActions.length ? `Recent actions:\n${recentActions.map((entry) => `- ${entry}`).join("\n")}` : "Recent actions:\n- none",
    `Visible accessibility text preview:\n${browserVisibleTextPreview(state)}`,
    `Accessibility candidates:\n${renderCandidateInventory(candidates)}`
  ]
    .filter(Boolean)
    .join("\n\n");
}

function extractionPrompt({
  instruction,
  state
}: {
  instruction: string;
  state: WorldState;
}): string {
  const title = browserWindowTitle((state.appContext ?? null) as Record<string, unknown> | null);
  const lastKnownUrl = cleanText(((state.appContext ?? {}) as Record<string, unknown>).url);
  const candidates = browserInteractionCandidates(state);

  return [
    instruction,
    title ? `Current window title: ${title}` : null,
    lastKnownUrl ? `Last known URL hint: ${lastKnownUrl}` : null,
    `Visible accessibility text preview:\n${browserVisibleTextPreview(state)}`,
    `Accessibility candidates:\n${renderCandidateInventory(candidates)}`
  ]
    .filter(Boolean)
    .join("\n\n");
}

function visibilityPrompt({
  text,
  state
}: {
  text: string;
  state: WorldState;
}): string {
  return [
    "Verify whether the exact target text is visibly present in the current browser page or active reply composer.",
    "Return visible=true only when the text is actually visible on the screenshot now.",
    `Target text: ${text}`,
    `Visible accessibility text preview:\n${browserVisibleTextPreview(state)}`,
    `Accessibility candidates:\n${renderCandidateInventory(
      browserInteractionCandidates(state),
      60
    )}`
  ].join("\n\n");
}

function asBrowserBlocker(kind: BrowserBlocker["kind"], detail: string): BrowserExecutionResult {
  return {
    status: "blocked",
    finalUrl: "",
    blockers: [
      {
        kind,
        detail
      }
    ],
    verification: null
  };
}

function candidateById(worldState: WorldState, id: string | null | undefined): Record<string, unknown> | null {
  const normalized = cleanText(id);
  if (!normalized || !Array.isArray(worldState.interactionCandidates)) {
    return null;
  }

  return (
    browserInteractionCandidates(worldState).find(
      (candidate) => cleanText(candidate.id) === normalized
    ) ?? null
  );
}

function candidateMatchesText(worldState: WorldState, query: string): boolean {
  const needle = cleanText(query).toLowerCase();
  if (!needle) {
    return false;
  }

  if (cleanText(worldState.visibleText).toLowerCase().includes(needle)) {
    return true;
  }

  if (!Array.isArray(worldState.interactionCandidates)) {
    return false;
  }

  return browserInteractionCandidates(worldState).some((candidate) =>
    cleanText(candidate.text).toLowerCase().includes(needle)
  );
}

function normalizedPointToScreen(
  worldState: WorldState,
  point: { x?: number; y?: number } | null | undefined
): { x: number; y: number } | null {
  const x = Number(point?.x ?? NaN);
  const y = Number(point?.y ?? NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  const bounds = browserWindowBounds((worldState.appContext ?? null) as Record<string, unknown> | null);
  if (!bounds) {
    return null;
  }

  const left = Number(bounds.x ?? NaN);
  const top = Number(bounds.y ?? NaN);
  const width = Number(bounds.width ?? NaN);
  const height = Number(bounds.height ?? NaN);
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null;
  }

  const normalizedX = x > 1 ? x : Math.max(0, Math.min(1, x)) * width;
  const normalizedY = y > 1 ? y : Math.max(0, Math.min(1, y)) * height;
  return {
    x: Math.round(left + normalizedX),
    y: Math.round(top + normalizedY)
  };
}

function actionSummary(action: BrowserVisionDecision["action"]): string {
  if (!action?.type) {
    return "no-op";
  }
  if (action.type === "type_into_target" || action.type === "type_into_point") {
    return `${action.type}:${truncate(action.text, 80)}`;
  }
  if (action.type === "press_key") {
    return `press_key:${cleanText(action.key)}`;
  }
  if (action.type === "scroll") {
    return `scroll:${Number(action.dy ?? 0)}`;
  }
  return action.type;
}

export class BrowserSurfaceAdapter extends SurfaceAdapter {
  desktopSurface: BrowserDesktopSurface;
  ownsDesktopSurface: boolean;
  visualModelClient: Pick<OpenAICompatibleModelClient, "supportsImageJson" | "analyzeImageJson"> | null;
  modelConfig: AgentModelConfig;
  browserExecutable: string | null;
  browserAppCandidates: string[];
  sessionHints: Map<string, { lastKnownUrl: string | null }>;

  constructor({
    artifactStore,
    dataDir,
    browserExecutable,
    modelConfig,
    visualModelClient = null,
    desktopSurface
  }: BrowserSurfaceAdapterOptions) {
    super("browser");
    this.desktopSurface =
      desktopSurface
      ?? new DesktopSurfaceAdapter({
        artifactStore,
        dataDir,
        visualModelClient: visualModelClient ?? undefined
      });
    this.ownsDesktopSurface = !desktopSurface;
    this.visualModelClient = visualModelClient;
    this.modelConfig = modelConfig;
    this.browserExecutable = cleanText(browserExecutable) || null;
    this.browserAppCandidates = inferBrowserAppCandidates(browserExecutable);
    this.sessionHints = new Map();
  }

  usesSharedSession(): boolean {
    return true;
  }

  #contextKey(workspace: WorkspaceRecord): string {
    return workspace.rootPath || workspace.profilePath || workspace.id;
  }

  #lastKnownUrl(workspace: WorkspaceRecord): string | null {
    return this.sessionHints.get(this.#contextKey(workspace))?.lastKnownUrl ?? null;
  }

  #setLastKnownUrl(workspace: WorkspaceRecord, url: unknown): void {
    const normalized = cleanText(url);
    const contextKey = this.#contextKey(workspace);
    this.sessionHints.set(contextKey, {
      lastKnownUrl: normalized || null
    });
  }

  async #focusBrowser(task: TaskRecord, workspace: WorkspaceRecord, traceId: string | null): Promise<string> {
    for (const appName of this.browserAppCandidates) {
      const result = await this.desktopSurface.focus({
        task,
        workspace,
        traceId,
        step: {
          action: "focusApp",
          params: { appName }
        }
      }).catch(() => ({ focused: false }));
      if (result && typeof result === "object" && result.focused === true) {
        return appName;
      }
    }

    throw new Error(`Browser app unavailable: could not focus ${this.browserAppCandidates.join(", ")}.`);
  }

  async #browserWorldState({
    task,
    workspace,
    traceId,
    label = "browser-observe",
    recentActions = []
  }: {
    task: TaskRecord;
    workspace: WorkspaceRecord;
    traceId: string | null;
    label?: string;
    recentActions?: unknown[];
  }): Promise<WorldState> {
    const desktopState = await this.desktopSurface.observe({
      task,
      workspace,
      traceId,
      label,
      recentActions,
      targetAppName: this.browserAppCandidates[0]
    });
    const appContext = ((desktopState.appContext ?? null) as Record<string, unknown> | null) ?? {};
    const title = browserWindowTitle(appContext);
    const observedUrl = browserObservedUrl(appContext) ?? this.#lastKnownUrl(workspace);
    if (observedUrl) {
      this.#setLastKnownUrl(workspace, observedUrl);
    }
    const blockers = detectBrowserBlockers({
      visibleText: cleanText(desktopState.visibleText),
      title,
      lastKnownUrl: observedUrl,
      candidateCount: Array.isArray(desktopState.interactionCandidates) ? desktopState.interactionCandidates.length : 0
    });

    return createWorldState({
      surface: "browser",
      workspaceId: workspace.id,
      appContext: {
        ...appContext,
        title: title || null,
        url: observedUrl,
        blockers,
        runtime: "desktop_browser",
        browserAppName: this.browserAppCandidates[0]
      },
      capture: desktopState.capture,
      interactionCandidates: Array.isArray(desktopState.interactionCandidates) ? desktopState.interactionCandidates : [],
      screenTextBlocks: Array.isArray(desktopState.screenTextBlocks) ? desktopState.screenTextBlocks : [],
      visibleText: cleanText(desktopState.visibleText).slice(0, 4000),
      recentActions: summarizeRecentActions(recentActions as Array<Record<string, unknown>>),
      summary: `${title || this.browserAppCandidates[0]} @ ${observedUrl || "current tab"}`
    }) as WorldState;
  }

  async #captureBrowser({
    task,
    workspace,
    traceId,
    label = "browser-capture"
  }: {
    task: TaskRecord;
    workspace: WorkspaceRecord;
    traceId: string | null;
    label?: string;
  }) {
    return await this.desktopSurface.capture({
      task,
      workspace,
      traceId,
      label,
      targetAppName: this.browserAppCandidates[0]
    });
  }

  #assertVisualModelAvailable(): asserts this is this & {
    visualModelClient: Pick<OpenAICompatibleModelClient, "supportsImageJson" | "analyzeImageJson">;
  } {
    if (!this.visualModelClient?.supportsImageJson?.()) {
      throw new Error("Browser visual model is unavailable. Configure an image-capable model before running browser tasks.");
    }
  }

  async #analyzeBrowserImage<TResponse>({
    task,
    workspace,
    traceId,
    label,
    schemaName,
    schema,
    systemPrompt,
    userPrompt,
    state
  }: {
    task: TaskRecord;
    workspace: WorkspaceRecord;
    traceId: string | null;
    label: string;
    schemaName: string;
    schema: Record<string, unknown>;
    systemPrompt: string;
    userPrompt: string;
    state?: WorldState | null;
  }): Promise<TResponse> {
    this.#assertVisualModelAvailable();
    const effectiveState = state ?? await this.#browserWorldState({ task, workspace, traceId, label });
    const imagePath = cleanText((effectiveState.capture as { path?: unknown } | null)?.path);
    if (!imagePath) {
      throw new Error("Browser screenshot is unavailable for visual analysis.");
    }

    return await this.visualModelClient.analyzeImageJson<TResponse>({
      schemaName,
      schema,
      systemPrompt,
      userPrompt,
      imagePath,
      temperature: 0
    });
  }

  async #navigateCurrentTab({
    task,
    workspace,
    traceId,
    url
  }: {
    task: TaskRecord;
    workspace: WorkspaceRecord;
    traceId: string | null;
    url: string;
  }): Promise<void> {
    const targetUrl = cleanText(url);
    if (!targetUrl) {
      return;
    }

    const appName = await this.#focusBrowser(task, workspace, traceId);
    await this.desktopSurface.act({
      task,
      workspace,
      traceId,
      step: {
        action: "pressKey",
        params: { key: "l", modifiers: [browserShortcutModifier()], appName },
        label: "Focus browser address bar"
      }
    });
    await this.desktopSurface.act({
      task,
      workspace,
      traceId,
      step: {
        action: "typeText",
        params: { text: targetUrl, appName },
        label: "Type browser URL"
      }
    });
    await this.desktopSurface.act({
      task,
      workspace,
      traceId,
      step: {
        action: "pressKey",
        params: { key: "enter", modifiers: [], appName },
        label: "Open browser URL"
      }
    });
    await this.desktopSurface.act({
      task,
      workspace,
      traceId,
      step: {
        action: "wait",
        params: { ms: 1500 },
        label: "Wait for browser navigation"
      }
    });
    this.#setLastKnownUrl(workspace, targetUrl);
  }

  async #performDecisionAction({
    task,
    workspace,
    traceId,
    worldState,
    action
  }: {
    task: TaskRecord;
    workspace: WorkspaceRecord;
    traceId: string | null;
    worldState: WorldState;
    action: NonNullable<BrowserVisionDecision["action"]>;
  }): Promise<void> {
    const appName = await this.#focusBrowser(task, workspace, traceId);
    const candidate = candidateById(worldState, action.targetId);
    const point = normalizedPointToScreen(worldState, action.point);

    switch (action.type) {
      case "click_target": {
        if (!candidate) {
          throw new Error(`Browser action could not resolve candidate ${cleanText(action.targetId) || "unknown"}.`);
        }
        await this.desktopSurface.act({
          task,
          workspace,
          traceId,
          step: {
            action: "clickTarget",
            params: { target: candidate, appName },
            label: "Click browser target"
          }
        });
        return;
      }
      case "click_point": {
        if (!point) {
          throw new Error("Browser action could not resolve a visible click point.");
        }
        await this.desktopSurface.act({
          task,
          workspace,
          traceId,
          step: {
            action: "clickAt",
            params: { x: point.x, y: point.y, appName },
            label: "Click browser point"
          }
        });
        return;
      }
      case "type_into_target": {
        if (!candidate) {
          throw new Error(`Browser action could not resolve target ${cleanText(action.targetId) || "unknown"} for typing.`);
        }
        await this.desktopSurface.act({
          task,
          workspace,
          traceId,
          step: {
            action: "typeIntoTarget",
            params: {
              target: candidate,
              text: action.text ?? "",
              clear: action.clear !== false,
              appName
            },
            label: "Type into browser target"
          }
        });
        return;
      }
      case "type_into_point": {
        if (!point) {
          throw new Error("Browser action could not resolve a visible typing point.");
        }
        await this.desktopSurface.act({
          task,
          workspace,
          traceId,
          step: {
            action: "clickAt",
            params: { x: point.x, y: point.y, appName },
            label: "Focus browser typing point"
          }
        });
        if (action.clear !== false) {
          await this.desktopSurface.act({
            task,
            workspace,
            traceId,
            step: {
              action: "pressKey",
              params: { key: "a", modifiers: [browserShortcutModifier()], appName },
              label: "Select existing browser draft text"
            }
          });
          await this.desktopSurface.act({
            task,
            workspace,
            traceId,
            step: {
              action: "pressKey",
              params: { key: "delete", modifiers: [], appName },
              label: "Clear existing browser draft text"
            }
          });
        }
        await this.desktopSurface.act({
          task,
          workspace,
          traceId,
          step: {
            action: "typeText",
            params: { text: action.text ?? "", appName },
            label: "Type browser text"
          }
        });
        return;
      }
      case "press_key": {
        await this.desktopSurface.act({
          task,
          workspace,
          traceId,
          step: {
            action: "pressKey",
            params: {
              key: cleanText(action.key),
              modifiers: Array.isArray(action.modifiers) ? action.modifiers : [],
              appName
            },
            label: "Press browser key"
          }
        });
        return;
      }
      case "scroll": {
        await this.desktopSurface.act({
          task,
          workspace,
          traceId,
          step: {
            action: "scrollSurface",
            params: {
              dx: Number(action.dx ?? 0),
              dy: Number(action.dy ?? 800),
              appName
            },
            label: "Scroll browser surface"
          }
        });
        return;
      }
      case "wait": {
        await this.desktopSurface.act({
          task,
          workspace,
          traceId,
          step: {
            action: "wait",
            params: { ms: Math.max(200, Number(action.ms ?? 800)) },
            label: "Wait for browser UI"
          }
        });
        return;
      }
      default:
        throw new Error(`Unsupported browser model action ${String(action.type ?? "unknown")}.`);
    }
  }

  async #runBrowserExecution(
    task: TaskRecord,
    workspace: WorkspaceRecord,
    traceId: string | null,
    params: Record<string, unknown>
  ): Promise<BrowserExecutionResult> {
    const input = normalizeBrowserExecutionInput(params, this.modelConfig.timeoutMs);
    const instructions = input.actions?.length ? input.actions : [input.instruction];
    const recentActions: string[] = [];
    let extractedResult: unknown = null;

    for (let instructionIndex = 0; instructionIndex < instructions.length; instructionIndex += 1) {
      const instruction = cleanText(instructions[instructionIndex]);
      if (!instruction) {
        continue;
      }
      const remainingSteps = Math.max(1, input.maxSteps - recentActions.length);
      for (let stepNumber = 1; stepNumber <= remainingSteps; stepNumber += 1) {
        const worldState = await this.#browserWorldState({
          task,
          workspace,
          traceId,
          label: "browser-execute",
          recentActions
        });
        const blockers = (((worldState.appContext ?? {}) as Record<string, unknown>).blockers ?? []) as BrowserBlocker[];
        if (Array.isArray(blockers) && blockers.length > 0) {
          return {
            status: "blocked",
            finalUrl: this.#lastKnownUrl(workspace) ?? "",
            blockers,
            verification: null
          };
        }

        const decision = await this.#analyzeBrowserImage<BrowserVisionDecision>({
          task,
          workspace,
          traceId,
          label: "browser-decision",
          schemaName: "agentos_browser_execute_decision",
          schema: BROWSER_EXECUTION_DECISION_SCHEMA as unknown as Record<string, unknown>,
          systemPrompt:
            "You are a strict browser operator for AgentOS. Control only the visible browser window. Return JSON only.",
          userPrompt: decisionPrompt({
            instruction,
            successCriteria: input.successCriteria,
            state: worldState,
            recentActions,
            maxSteps: input.maxSteps,
            stepNumber
          }),
          state: worldState
        });

        if (decision.status === "completed") {
          if (instructionIndex === instructions.length - 1 && input.successCriteria && input.verificationSchema) {
            extractedResult = await this.#analyzeBrowserImage({
              task,
              workspace,
              traceId,
              label: "browser-success-extract",
              schemaName: "agentos_browser_success_extract",
              schema: input.verificationSchema,
              systemPrompt:
                "You are a strict browser verifier for AgentOS. Extract only what is visible in the current browser window and return JSON only.",
              userPrompt: extractionPrompt({
                instruction: input.successCriteria,
                state: worldState
              }),
              state: worldState
            });
          }
          break;
        }

        if (decision.status === "blocked") {
          return {
            status: "blocked",
            finalUrl: this.#lastKnownUrl(workspace) ?? "",
            blockers: [
              {
                kind: "manual_intervention",
                detail: cleanText(decision.blocker) || cleanText(decision.rationale) || "Browser execution is blocked."
              }
            ],
            verification: null
          };
        }

        if (!decision.action?.type) {
          return {
            status: "failed",
            finalUrl: this.#lastKnownUrl(workspace) ?? "",
            blockers: [],
            verification: {
              reason: "browser_model_returned_no_action",
              decision
            }
          };
        }

        await this.#performDecisionAction({
          task,
          workspace,
          traceId,
          worldState,
          action: decision.action
        });
        recentActions.push(`${actionSummary(decision.action)} :: ${cleanText(decision.rationale) || "continue"}`);
      }

      if (recentActions.length >= input.maxSteps) {
        return {
          status: "failed",
          finalUrl: this.#lastKnownUrl(workspace) ?? "",
          blockers: [],
          verification: {
            reason: "browser_max_steps_exhausted",
            recentActions
          }
        };
      }
    }

    return {
      status: "completed",
      finalUrl: this.#lastKnownUrl(workspace) ?? "",
      blockers: [],
      ...(extractedResult != null ? { extractedResult } : {}),
      verification: null
    };
  }

  async discover({ task, workspace, traceId, label = "browser-discover" }) {
    const worldState = await this.#browserWorldState({ task, workspace, traceId, label });
    const appContext = ((worldState.appContext ?? null) as Record<string, unknown> | null) ?? {};
    return {
      appName: cleanText(appContext.browserAppName ?? appContext.appName) || this.browserAppCandidates[0],
      title: browserWindowTitle(appContext) || null,
      url: this.#lastKnownUrl(workspace),
      blockers: appContext.blockers ?? []
    };
  }

  async observe({ task, workspace, traceId, label = "browser-observe", recentActions = [] }) {
    return await this.#browserWorldState({ task, workspace, traceId, label, recentActions });
  }

  async focus({ task, workspace, traceId }) {
    const appName = await this.#focusBrowser(task, workspace, traceId);
    return {
      focused: true,
      appName,
      url: this.#lastKnownUrl(workspace)
    };
  }

  async capture({ task, workspace, traceId, label = "browser-capture" }) {
    return await this.#captureBrowser({ task, workspace, traceId, label });
  }

  async act({ task, step, workspace, traceId }) {
    const params = step.params ?? {};

    try {
      switch (step.action) {
        case "goto":
        case "navigate":
        case "open_url":
        case "openUrl": {
          const url = cleanText(params.url);
          if (!url) {
            throw new Error("Browser navigation requires a URL.");
          }
          await this.#navigateCurrentTab({ task, workspace, traceId, url });
          return {
            url,
            title: null
          };
        }
        case "browserExtract": {
          const instruction = cleanText(params.instruction);
          const schema =
            params.schema && typeof params.schema === "object"
              ? (params.schema as Record<string, unknown>)
              : params.verificationSchema && typeof params.verificationSchema === "object"
                ? (params.verificationSchema as Record<string, unknown>)
                : null;
          if (!instruction || !schema) {
            throw new Error("browserExtract requires an instruction and JSON schema.");
          }
          const state = await this.#browserWorldState({ task, workspace, traceId, label: "browser-extract" });
          return {
            extracted: await this.#analyzeBrowserImage({
              task,
              workspace,
              traceId,
              label: "browser-extract",
              schemaName: cleanText(params.schemaName) || "agentos_browser_extract",
              schema,
              systemPrompt:
                "You are a strict browser analyst for AgentOS. Use only what is visible in the current browser window and return JSON only.",
              userPrompt: extractionPrompt({ instruction, state }),
              state
            })
          };
        }
        case "browserExecute":
        case "browserAgent":
          return await this.#runBrowserExecution(task, workspace, traceId, params);
        case "browserObserve": {
          const state = await this.#browserWorldState({ task, workspace, traceId, label: "browser-observe" });
          return {
            observation: {
              title: browserWindowTitle((state.appContext ?? null) as Record<string, unknown> | null) || null,
              url: this.#lastKnownUrl(workspace),
              visibleText: browserVisibleTextPreview(state),
              candidates: renderCandidateInventory(
                browserInteractionCandidates(state),
                40
              )
            }
          };
        }
        case "click":
          return await this.desktopSurface.act({
            task,
            workspace,
            traceId,
            step: {
              action: "clickTarget",
              params: {
                targetQuery: params.text ?? params.targetQuery ?? "",
                appName: this.browserAppCandidates[0]
              },
              label: step.label
            }
          });
        case "type":
          return await this.desktopSurface.act({
            task,
            workspace,
            traceId,
            step: {
              action: "typeIntoTarget",
              params: {
                targetQuery: params.textTarget ?? params.targetQuery ?? "",
                text: params.text ?? "",
                clear: params.clear !== false,
                appName: this.browserAppCandidates[0]
              },
              label: step.label
            }
          });
        case "press":
          return await this.desktopSurface.act({
            task,
            workspace,
            traceId,
            step: {
              action: "pressKey",
              params: {
                key: params.key,
                modifiers: params.modifiers ?? [],
                appName: this.browserAppCandidates[0]
              },
              label: step.label
            }
          });
        case "wait":
        case "scrollSurface":
        case "clickAt":
        case "clickTarget":
        case "focusTarget":
        case "typeIntoTarget":
        case "waitForTarget":
        case "extractFromTarget":
        case "capture": {
          return await this.desktopSurface.act({
            task,
            workspace,
            traceId,
            step: {
              ...step,
              params: {
                ...params,
                appName: this.browserAppCandidates[0]
              }
            }
          });
        }
        case "screenshot":
          return await this.#captureBrowser({
            task,
            workspace,
            traceId,
            label: cleanText(params.label) || step.label || "browser-capture"
          });
        default:
          throw new Error(`Unsupported browser action: ${step.action}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RecoverableError(message, { step, originalName: error instanceof Error ? error.name : "Error" });
    }
  }

  async verify({
    task,
    workspace,
    traceId,
    expectation = {}
  }: {
    task: TaskRecord;
    workspace: WorkspaceRecord;
    traceId: string | null;
    expectation?: Record<string, unknown>;
  }) {
    const details: Record<string, unknown> = {};
    const state = await this.#browserWorldState({ task, workspace, traceId, label: "browser-verify" });
    const appContext = ((state.appContext ?? null) as Record<string, unknown> | null) ?? {};

    if (typeof expectation.frontmostApp === "string" && cleanText(expectation.frontmostApp)) {
      details.frontmostApp = cleanText(appContext.appName);
      if (!normalizeAppKey(appContext.appName).includes(normalizeAppKey(expectation.frontmostApp))) {
        return { ok: false, details };
      }
    }

    if (typeof expectation.urlIncludes === "string" && cleanText(expectation.urlIncludes)) {
      const lastKnownUrl = this.#lastKnownUrl(workspace) ?? "";
      details.url = lastKnownUrl;
      if (!lastKnownUrl.includes(cleanText(expectation.urlIncludes))) {
        return { ok: false, details };
      }
    }

    const targetText =
      cleanText(expectation.textVisible)
      || cleanText(((expectation.targetVisible ?? null) as { text?: unknown } | null)?.text);
    if (targetText) {
      const directMatch = candidateMatchesText(state, targetText);
      details.textVisible = directMatch;
      if (!directMatch) {
        try {
          const visual = await this.#analyzeBrowserImage<{ visible: boolean; rationale?: string | null }>({
            task,
            workspace,
            traceId,
            label: "browser-verify-text",
            schemaName: "agentos_browser_text_verify",
            schema: BROWSER_TEXT_VISIBILITY_SCHEMA as unknown as Record<string, unknown>,
            systemPrompt:
              "You are a strict browser UI verifier for AgentOS. Inspect the screenshot and return JSON only.",
            userPrompt: visibilityPrompt({ text: targetText, state }),
            state
          });
          details.visualTextVisible = visual.visible;
          details.visualTextRationale = visual.rationale ?? null;
          if (!visual.visible) {
            return { ok: false, details };
          }
        } catch (error) {
          details.visualVerifyError = error instanceof Error ? error.message : String(error);
          return { ok: false, details };
        }
      }
    }

    if (typeof expectation.fileExists === "string" && cleanText(expectation.fileExists)) {
      const filePath = path.isAbsolute(expectation.fileExists)
        ? expectation.fileExists
        : path.resolve(workspace.rootPath, expectation.fileExists);
      try {
        await fs.access(filePath);
        details.fileExists = true;
      } catch {
        return { ok: false, details: { ...details, fileExists: false, filePath } };
      }
    }

    return { ok: true, details };
  }

  async shutdown() {
    this.sessionHints.clear();
    if (this.ownsDesktopSurface) {
      await this.desktopSurface.shutdown().catch(() => null);
    }
  }
}
