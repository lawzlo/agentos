import fs from "node:fs/promises";

import { nowIso } from "./id.js";
import { materializeWatchActionTemplate } from "./watch-profile.js";
import { inferReplyLanguage } from "./reply-language.js";
import { clearExpiredReplyApprovalGrant, deriveReplyThreadKey, hasActiveReplyApprovalGrant } from "./reply-policy.js";
import { ModelBudgetExceededError, type ModelUsageBudget } from "./model-client.js";
import {
  deriveConversationThreadKey,
  findConversationThreadByTaskId,
  isConversationThreadCooldownActive,
  isConversationThreadEscalated,
  normalizeConversationThreadKey,
  recordConversationFailure,
  recordConversationObservation,
  recordConversationTaskCompletion,
  recordConversationTaskDispatch
} from "./conversation-thread-state.js";
import type { ControlPlane } from "./control-plane.js";
import type { EventBus } from "./event-bus.js";
import {
  analyzeDesktopConversationPackWithVision,
  runnerTypeForPack,
  type LivePack,
  type LivePackDraftResponse,
  type LivePackRegistry
} from "./live-pack-registry.js";
import type { DecoratedDraftRecord } from "./watch-presenters.js";
import type { ControlPlaneStore } from "./store.js";
import type {
  DraftRecord,
  ArtifactUsage,
  RiskGateDecision,
  RunBudgetStatus,
  RuntimeStep,
  StorageGuardStatus,
  SurfaceHealthState,
  TaskRecord,
  TaskSpec,
  TeachTemplateInput,
  UsageSummary,
  WatchDetection,
  WatchGovernance,
  WatchRule,
  WorldState,
  WorkspaceProfile
} from "../types/runtime-schema.js";

interface TaskLike {
  id?: string;
  status: string;
  error?: string | null;
  updatedAt?: string;
}

class UnresolvedTaskTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnresolvedTaskTemplateError";
  }
}

function isActiveTask(task?: TaskLike | null): boolean {
  if (!task) {
    return false;
  }

  return !["completed", "failed", "blocked", "interrupted"].includes(task.status);
}

function clearWatchFailureState(dedupeState: Record<string, unknown> = {}) {
  return {
    ...clearExpiredReplyApprovalGrant(dedupeState),
    failureCount: 0,
    retryAfter: null,
    backoffMs: 0,
    attentionKind: null,
    attentionDetail: null,
    attentionAction: null,
    lastNoTriggerReason: null,
    lastNoTriggerStage: null,
    lastNoTriggerAt: null,
    lastNoTriggerUnreadCandidate: null,
    lastNoTriggerComposeCandidate: null,
    lastNoTriggerTopUnread: [],
    lastNoTriggerRunnerType: null,
    lastNoTriggerScene: null,
    lastNoTriggerSelectedTarget: null,
    lastNoTriggerSkipReasons: [],
    lastNoTriggerRecoveryAction: null,
    repeatedNoTriggerCount: 0,
    storageGuard: null
  };
}

const WATCH_MODEL_MAX_REQUESTS = 8;
const DESKTOP_VLM_MODEL_MAX_REQUESTS = 6;
const DESKTOP_SURFACE_COOLDOWN_MS = 5 * 60_000;
const REPEATED_NO_TRIGGER_COOLDOWN_THRESHOLD = 2;
const STORAGE_GUARD_BACKOFF_MS = 30 * 60_000;
const DEFAULT_STORAGE_GUARD_MAX_USED_PERCENT = 90;

function storageGuardMaximumUsedPercent(): number {
  const override = Number(process.env.AGENTOS_STORAGE_GUARD_MAX_USED_PERCENT ?? "");
  if (Number.isFinite(override) && override > 0) {
    return Math.min(100, Math.max(1, override));
  }
  return DEFAULT_STORAGE_GUARD_MAX_USED_PERCENT;
}

function usageSummaryFromBudget(
  budget: {
    usage?: UsageSummary;
    status?: RunBudgetStatus;
  } | null | undefined
): UsageSummary {
  return {
    requestCount: Number(budget?.usage?.requestCount ?? 0),
    inputTokens: Number(budget?.usage?.inputTokens ?? 0),
    outputTokens: Number(budget?.usage?.outputTokens ?? 0),
    totalTokens: Number(budget?.usage?.totalTokens ?? 0),
    estimatedCostUsd:
      Number.isFinite(Number(budget?.usage?.estimatedCostUsd))
        ? Number(budget?.usage?.estimatedCostUsd)
        : null
  };
}

function budgetStatusFromBudget(
  budget: {
    status?: RunBudgetStatus;
  } | null | undefined
): RunBudgetStatus {
  return budget?.status ?? "ok";
}

function recordUsageMetadata(
  dedupeState: Record<string, unknown>,
  budget: {
    usage?: UsageSummary;
    status?: RunBudgetStatus;
  } | null | undefined,
  artifactUsage: ArtifactUsage | null
): Record<string, unknown> {
  return {
    ...dedupeState,
    budgetStatus: budgetStatusFromBudget(budget),
    usageSummary: usageSummaryFromBudget(budget),
    artifactUsage: artifactUsage
      ? {
          ...artifactUsage
        }
      : dedupeState.artifactUsage ?? null
  };
}

async function collectStorageGuardStatus(workspace: WorkspaceProfile): Promise<StorageGuardStatus | null> {
  try {
    const stats = await fs.statfs(workspace.rootPath);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const totalBlocks = Number(stats.blocks);
    const availableBlocks = Number(stats.bavail);
    const usedBlocks = totalBlocks - availableBlocks;
    const usedPercent =
      Number.isFinite(totalBlocks) && totalBlocks > 0 && Number.isFinite(usedBlocks) && usedBlocks >= 0
        ? (usedBlocks / totalBlocks) * 100
        : null;
    return {
      active:
        Number.isFinite(Number(usedPercent)) &&
        Number(usedPercent) > storageGuardMaximumUsedPercent(),
      freeBytes: Number.isFinite(freeBytes) ? freeBytes : null,
      usedPercent: Number.isFinite(Number(usedPercent)) ? Number(usedPercent) : null,
      maximumUsedPercent: storageGuardMaximumUsedPercent()
    };
  } catch {
    return null;
  }
}

function isDesktopSurfaceRule(rule: WatchRule): boolean {
  return runnerTypeForPack(rule.livePack, rule.preferredSurface) !== "browser_native";
}

function desktopCooldownEligible(rule: WatchRule): boolean {
  return rule.livePack === "slack-desktop" || rule.livePack === "outlook-desktop";
}

function clearExpiredSurfaceHealthState(dedupeState: Record<string, unknown> = {}): Record<string, unknown> {
  const cooldownUntil = Number(dedupeState.surfaceHealthCooldownUntil ?? 0);
  if (cooldownUntil && cooldownUntil > Date.now()) {
    return dedupeState;
  }

  return {
    ...dedupeState,
    surfaceHealth: cooldownUntil ? "healthy" : dedupeState.surfaceHealth ?? "healthy",
    surfaceHealthCooldownUntil: null
  };
}

function surfaceHealthCooldownActive(dedupeState: Record<string, unknown> = {}): boolean {
  const cooldownUntil = Number(dedupeState.surfaceHealthCooldownUntil ?? 0);
  return cooldownUntil > Date.now();
}

function recordSurfaceHealth(
  dedupeState: Record<string, unknown>,
  {
    state,
    cooldownUntil
  }: {
    state: SurfaceHealthState;
    cooldownUntil?: number | null;
  }
): Record<string, unknown> {
  return {
    ...dedupeState,
    surfaceHealth: state,
    surfaceHealthCooldownUntil: cooldownUntil && cooldownUntil > 0 ? cooldownUntil : null
  };
}

function nextRepeatedNoTriggerCount(
  dedupeState: Record<string, unknown>,
  {
    reason,
    scene,
    selectedTarget
  }: {
    reason: string;
    scene: string | null;
    selectedTarget: string | null;
  }
): number {
  const previousReason = String(dedupeState.lastNoTriggerReason ?? "").trim();
  const previousScene = String(dedupeState.lastNoTriggerScene ?? "").trim() || null;
  const previousSelectedTarget = String(dedupeState.lastNoTriggerSelectedTarget ?? "").trim() || null;
  const previousCount = Math.max(0, Number(dedupeState.repeatedNoTriggerCount ?? 0));
  if (previousReason === reason && previousScene === scene && previousSelectedTarget === selectedTarget) {
    return previousCount + 1;
  }
  return 1;
}

function modelRequestBudgetForRule(rule: WatchRule): number {
  if (rule.livePack === "outlook-desktop") {
    return WATCH_MODEL_MAX_REQUESTS;
  }
  return runnerTypeForPack(rule.livePack, rule.preferredSurface) === "desktop_vlm"
    ? DESKTOP_VLM_MODEL_MAX_REQUESTS
    : WATCH_MODEL_MAX_REQUESTS;
}

function hasExplicitConversationThread(detection: WatchDetection | null | undefined): boolean {
  const metadata = (detection?.metadata ?? {}) as Record<string, unknown>;
  const inputs = (detection?.inputs ?? {}) as Record<string, unknown>;
  return [metadata.threadKey, metadata.replyThreadKey, inputs.threadKey, inputs.replyThreadKey].some(
    (value) => typeof value === "string" && value.trim().length > 0
  );
}

function managedConversationThreadKey(detection: WatchDetection | null | undefined): string | null {
  if (!hasExplicitConversationThread(detection)) {
    return null;
  }

  return deriveConversationThreadKey(detection);
}

function localDayKey(date = new Date()): string {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
}

function watchGovernance(rule: WatchRule): WatchGovernance {
  return (rule.watchProfile?.governance ?? {}) as WatchGovernance;
}

function isWithinQuietHours(governance: WatchGovernance, now = new Date()): boolean {
  const quietHours = governance.quietHours;
  if (!quietHours) {
    return false;
  }

  const startHour = Number(quietHours.startHour);
  const endHour = Number(quietHours.endHour);
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour) || startHour === endHour) {
    return false;
  }

  const currentHour = now.getHours();
  if (startHour < endHour) {
    return currentHour >= startHour && currentHour < endHour;
  }

  return currentHour >= startHour || currentHour < endHour;
}

function withinCooldown(rule: WatchRule, governance: WatchGovernance, now = Date.now()): boolean {
  const cooldownMs = Number(governance.cooldownMs ?? 0);
  const lastTriggeredAt = rule.lastTriggeredAt ? new Date(rule.lastTriggeredAt).getTime() : 0;
  return cooldownMs > 0 && Number.isFinite(lastTriggeredAt) && lastTriggeredAt > 0 && now - lastTriggeredAt < cooldownMs;
}

function autoActionCount(rule: WatchRule, dayKey = localDayKey()): number {
  const storedDay = String(rule.dedupeState?.autoActionDay ?? "");
  if (storedDay !== dayKey) {
    return 0;
  }

  return Math.max(0, Number(rule.dedupeState?.autoActionCount ?? 0));
}

function recordAutoAction(dedupeState: Record<string, unknown> = {}, dayKey = localDayKey()) {
  const storedDay = String(dedupeState.autoActionDay ?? "");
  const currentCount = storedDay === dayKey ? Math.max(0, Number(dedupeState.autoActionCount ?? 0)) : 0;
  return {
    ...dedupeState,
    autoActionDay: dayKey,
    autoActionCount: currentCount + 1
  };
}

function downgradeToDraft(
  decision: RiskGateDecision,
  reason: string,
  policy: RiskGateDecision["policy"] = "draft_only"
): RiskGateDecision {
  return {
    ...decision,
    policy,
    action: "draft",
    reasons: [...decision.reasons, reason]
  };
}

interface WatchExecutionServiceOptions {
  controlPlane: Pick<
    ControlPlane,
    | "modelClient"
    | "artifactStore"
    | "createTask"
    | "workspaceManager"
    | "watchService"
    | "draftService"
    | "surfaceCoordinator"
    | "surfaceRegistry"
    | "policyEngine"
    | "listReplyStylePreferences"
  >;
  store: Pick<ControlPlaneStore, "getWatchRule" | "putWatchRule" | "getTask" | "getDraft">;
  eventBus: EventBus;
  livePackRegistry: LivePackRegistry;
  scanStageTimeoutMs?: Partial<Record<WatchScanStage, number>>;
}

type WatchScanStage =
  | "prepare_workspace"
  | "activate_pack"
  | "observe_inbox"
  | "detect_items"
  | "extract_context"
  | "draft_reply"
  | "create_task";

const DEFAULT_SCAN_STAGE_TIMEOUT_MS: Record<WatchScanStage, number> = {
  prepare_workspace: 5000,
  activate_pack: 5000,
  observe_inbox: 8000,
  detect_items: 12000,
  extract_context: 12000,
  draft_reply: 8000,
  create_task: 5000
};

const WECHAT_SCAN_STAGE_TIMEOUT_MS: Partial<Record<WatchScanStage, number>> = {
  detect_items: 75000,
  extract_context: 20000,
  draft_reply: 20000
};

const SLACK_SCAN_STAGE_TIMEOUT_MS: Partial<Record<WatchScanStage, number>> = {
  detect_items: 60000,
  extract_context: 20000,
  draft_reply: 20000
};

const OUTLOOK_SCAN_STAGE_TIMEOUT_MS: Partial<Record<WatchScanStage, number>> = {
  observe_inbox: 12000,
  detect_items: 90000,
  extract_context: 20000,
  draft_reply: 20000
};

const BOSS_BROWSER_SCAN_STAGE_TIMEOUT_MS: Partial<Record<WatchScanStage, number>> = {
  activate_pack: 20000,
  observe_inbox: 12000,
  detect_items: 20000,
  extract_context: 40000,
  draft_reply: 20000
};

function clearScanStageState(dedupeState: Record<string, unknown> = {}) {
  return {
    ...dedupeState,
    scanStage: null,
    scanStageStatus: null,
    scanStageStartedAt: null,
    scanStageTimeoutMs: null
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      timer = null;
      reject(new Error(errorMessage));
    }, timeoutMs);
    void promise.then(
      (value) => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        resolve(value);
      },
      (error) => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        reject(error);
      }
    );
  });
}

function shouldDraftReply(rule: WatchRule, detection: WatchDetection = {}) {
  if (typeof detection.replyText === "string" && detection.replyText.trim()) {
    return true;
  }

  const inputs = detection.inputs ?? {};
  if (inputs.sendTarget || inputs.typeTarget) {
    return true;
  }

  const liveHints = (rule.watchProfile?.liveHints ?? {}) as Record<string, unknown>;
  if (liveHints.sendTargetQuery || liveHints.composeTargetQuery) {
    return true;
  }

  const explicitSteps = Array.isArray(detection.taskSpec?.steps) ? detection.taskSpec.steps : [];
  if (
    explicitSteps.some((step) => {
      const stepText = String(step?.params?.text ?? "").trim();
      return step?.action === "typeText" || stepText.includes("{{typeText}}");
    })
  ) {
    return true;
  }

  const actionTemplate = Array.isArray(rule.watchProfile?.actionTemplate) ? rule.watchProfile.actionTemplate : [];
  return actionTemplate.some((step) => {
    const target = (step?.params?.target ?? null) as { text?: string } | null;
    const text = String(step?.params?.targetQuery ?? target?.text ?? step?.label ?? "").toLowerCase();
    return /(send|reply|submit|发送|回复|提交)/iu.test(text) || step?.action === "typeIntoTarget";
  });
}

const SEND_STEP_PATTERN = /(send|submit|发送|提交)/iu;

function isSendLikeStep(step: RuntimeStep | null | undefined): boolean {
  if (!step || !["clickTarget", "click", "press"].includes(String(step.action ?? ""))) {
    return false;
  }

  const target = (step.params?.target ?? null) as { text?: string } | null;
  const signal = [
    String(step.label ?? "").trim(),
    String(step.params?.targetQuery ?? "").trim(),
    String(target?.text ?? "").trim(),
    String(step.params?.text ?? "").trim(),
    String(step.params?.key ?? "").trim()
  ]
    .filter(Boolean)
    .join(" ");

  return SEND_STEP_PATTERN.test(signal);
}

function stripSendLikeSteps(steps: RuntimeStep[] | null | undefined, autoSend: unknown): RuntimeStep[] | undefined {
  if (!Array.isArray(steps)) {
    return undefined;
  }

  if (autoSend === true) {
    return steps;
  }

  return steps.filter((step) => !isSendLikeStep(step));
}

function buildReplyPreview(value: unknown, maxLength = 48): string | null {
  const normalized = String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, maxLength);
}

function buildReplyMidPreview(value: unknown, maxLength = 48): string | null {
  const normalized = String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  const start = Math.max(0, Math.floor((normalized.length - maxLength) / 2));
  return normalized.slice(start, start + maxLength).trim() || null;
}

function buildReplyTailPreview(value: unknown, maxLength = 48): string | null {
  const normalized = String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.slice(-maxLength).trim() || null;
}

function buildReplySuffixPreview(value: unknown, maxLength = 14): string | null {
  const normalized = String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.slice(-maxLength).trim() || null;
}

function collectUnresolvedTemplateTokens(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/gu)) {
      const token = String(match[1] ?? "").trim();
      if (token) {
        found.add(token);
      }
    }
    return found;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectUnresolvedTemplateTokens(entry, found);
    }
    return found;
  }

  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      collectUnresolvedTemplateTokens(entry, found);
    }
  }

  return found;
}

function assertTaskSpecTemplatesResolved(taskSpec: TaskSpec): void {
  const unresolved = collectUnresolvedTemplateTokens(taskSpec.steps ?? []);
  if (!unresolved.size) {
    return;
  }

  throw new UnresolvedTaskTemplateError(
    `Task spec still contains unresolved template inputs: ${Array.from(unresolved).sort().join(", ")}`
  );
}

export class WatchExecutionService {
  controlPlane: WatchExecutionServiceOptions["controlPlane"];
  store: WatchExecutionServiceOptions["store"];
  eventBus: WatchExecutionServiceOptions["eventBus"];
  livePackRegistry: WatchExecutionServiceOptions["livePackRegistry"];
  scanStageTimeoutMs: Record<WatchScanStage, number>;

  constructor({
    controlPlane,
    store,
    eventBus,
    livePackRegistry,
    scanStageTimeoutMs = {}
  }: WatchExecutionServiceOptions) {
    this.controlPlane = controlPlane;
    this.store = store;
    this.eventBus = eventBus;
    this.livePackRegistry = livePackRegistry;
    this.scanStageTimeoutMs = {
      ...DEFAULT_SCAN_STAGE_TIMEOUT_MS,
      ...scanStageTimeoutMs
    };
  }

  createModelBudget(rule: WatchRule) {
    if (typeof this.controlPlane.modelClient.createUsageBudget === "function") {
      return this.controlPlane.modelClient.createUsageBudget({
        id: `watch:${rule.id}:${Date.now()}`,
        maxRequests: modelRequestBudgetForRule(rule)
      });
    }

    return {
      id: `watch:${rule.id}:${Date.now()}`,
      maxRequests: modelRequestBudgetForRule(rule),
      status: "ok" as RunBudgetStatus,
      usage: usageSummaryFromBudget(null)
    };
  }

  async runWithModelBudget<TResult>(
    budget: ModelUsageBudget,
    work: () => Promise<TResult>
  ): Promise<TResult> {
    if (typeof this.controlPlane.modelClient.runWithUsageBudget === "function") {
      return this.controlPlane.modelClient.runWithUsageBudget(budget, work);
    }

    return work();
  }

  scanStageTimeoutForRule(rule: WatchRule, stage: WatchScanStage): number {
    const modelTimeoutMs = Number(this.controlPlane.modelClient?.config?.timeoutMs ?? 0);
    const draftReplyFloorMs =
      stage === "draft_reply" && modelTimeoutMs > 0 ? modelTimeoutMs + 5000 : 0;

    if (rule.livePack === "wechat-desktop") {
      return Math.max(WECHAT_SCAN_STAGE_TIMEOUT_MS[stage] ?? this.scanStageTimeoutMs[stage], draftReplyFloorMs);
    }
    if (rule.livePack === "slack-desktop") {
      return Math.max(SLACK_SCAN_STAGE_TIMEOUT_MS[stage] ?? this.scanStageTimeoutMs[stage], draftReplyFloorMs);
    }
    if (rule.livePack === "outlook-desktop") {
      return Math.max(OUTLOOK_SCAN_STAGE_TIMEOUT_MS[stage] ?? this.scanStageTimeoutMs[stage], draftReplyFloorMs);
    }
    if (rule.livePack === "boss-browser") {
      return Math.max(BOSS_BROWSER_SCAN_STAGE_TIMEOUT_MS[stage] ?? this.scanStageTimeoutMs[stage], draftReplyFloorMs);
    }
    return Math.max(this.scanStageTimeoutMs[stage], draftReplyFloorMs);
  }

  beginScanStage(rule: WatchRule, stage: WatchScanStage): WatchRule {
    const timeoutMs = this.scanStageTimeoutForRule(rule, stage);
    const updated = this.store.putWatchRule({
      ...rule,
      dedupeState: {
        ...(rule.dedupeState ?? {}),
        scanStage: stage,
        scanStageStatus: "running",
        scanStageStartedAt: nowIso(),
        scanStageTimeoutMs: timeoutMs
      }
    });
    this.eventBus.broadcast("watch.updated", this.controlPlane.watchService.decorate(updated));
    return updated;
  }

  finishScanState(rule: WatchRule, dedupeState: Record<string, unknown>) {
    return clearScanStageState({
      ...(rule.dedupeState ?? {}),
      ...dedupeState
    });
  }

  async runScanStage<T>(rule: WatchRule, stage: WatchScanStage, action: () => Promise<T>): Promise<[WatchRule, T]> {
    const stagedRule = this.beginScanStage(rule, stage);
    const timeoutMs = this.scanStageTimeoutForRule(rule, stage);
    const result = await withTimeout(action(), timeoutMs, `Watch scan stage ${stage} timed out after ${timeoutMs}ms`);
    return [stagedRule, result];
  }

  buildTaskSpecFromWatchRule(
    watchRule: WatchRule,
    detection: WatchDetection = {},
    overrides: Record<string, unknown> = {}
  ): TaskSpec {
    const detected = detection;
    const overrideInputs = Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key !== "replyText")
    );
    const runtimeInputs: Record<string, unknown> = {
      ...(watchRule.taskInputs ?? {}),
      ...(detected.inputs ?? {}),
      ...overrideInputs,
      watchRuleId: watchRule.id,
      watchSummary: detected.summary ?? null,
      ...(watchRule.preferredSurface === "desktop" && watchRule.appTarget ? { desktopApp: watchRule.appTarget } : {}),
      ...(overrides.replyText && !detected.inputs?.typeText ? { typeText: overrides.replyText } : {}),
      ...(overrides.autoSend != null ? { autoSend: overrides.autoSend } : {})
    };
    const replyPreview = buildReplyPreview(runtimeInputs.typeText);
    if (replyPreview && runtimeInputs.typeTextPreview == null) {
      runtimeInputs.typeTextPreview = replyPreview;
    }
    const replyMidPreview = buildReplyMidPreview(runtimeInputs.typeText);
    if (replyMidPreview && runtimeInputs.typeTextMiddlePreview == null) {
      runtimeInputs.typeTextMiddlePreview = replyMidPreview;
    }
    const replyTailPreview = buildReplyTailPreview(runtimeInputs.typeText);
    if (replyTailPreview && runtimeInputs.typeTextTailPreview == null) {
      runtimeInputs.typeTextTailPreview = replyTailPreview;
    }
    const replySuffixPreview = buildReplySuffixPreview(runtimeInputs.typeText);
    if (replySuffixPreview && runtimeInputs.typeTextSuffixPreview == null) {
      runtimeInputs.typeTextSuffixPreview = replySuffixPreview;
    }
    const actionTemplate =
      !watchRule.skillName && watchRule.watchProfile?.actionTemplate?.length
        ? materializeWatchActionTemplate(
            watchRule.watchProfile.actionTemplate,
            runtimeInputs,
            ((watchRule.watchProfile?.metadata as { templateInputs?: TeachTemplateInput[] } | undefined)?.templateInputs ?? [])
          )
        : null;
    const filteredActionTemplate = stripSendLikeSteps(actionTemplate, runtimeInputs.autoSend);
    const baseTaskSpec = {
      goal: detected.goal ?? `${watchRule.goal}${detected.summary ? `\n\nTrigger context: ${detected.summary}` : ""}`,
      preferredSurface: watchRule.preferredSurface ?? "desktop",
      workspaceName: watchRule.workspaceName ?? `${watchRule.livePack}-live`,
      skillName: watchRule.skillName ?? null,
      triggerSource: `watch:${watchRule.id}`,
      inputs: runtimeInputs,
      ...(filteredActionTemplate?.length ? { steps: filteredActionTemplate } : {}),
      executionMode:
        filteredActionTemplate?.length
          ? "planned"
          : (watchRule.watchProfile?.executionMode as TaskSpec["executionMode"] | undefined) ??
            (watchRule.skillName ? "planned" : this.controlPlane.modelClient.isConfigured() ? "autonomous" : "planned")
    } satisfies TaskSpec;
    const explicitTaskSpec = detected.taskSpec ?? null;
    if (!explicitTaskSpec) {
      assertTaskSpecTemplatesResolved(baseTaskSpec);
      return baseTaskSpec;
    }

    const templateInputs =
      ((watchRule.watchProfile?.metadata as { templateInputs?: TeachTemplateInput[] } | undefined)?.templateInputs ?? []);
    const explicitSteps = Array.isArray(explicitTaskSpec.steps)
      ? materializeWatchActionTemplate(explicitTaskSpec.steps, runtimeInputs, templateInputs)
      : baseTaskSpec.steps;
    const filteredExplicitSteps = stripSendLikeSteps(explicitSteps, runtimeInputs.autoSend);
    const resolvedExecutionMode =
      explicitTaskSpec.executionMode ??
      (filteredExplicitSteps?.length ? "planned" : baseTaskSpec.executionMode);

    const resolvedTaskSpec = {
      ...baseTaskSpec,
      ...explicitTaskSpec,
      inputs: {
        ...runtimeInputs,
        ...(explicitTaskSpec.inputs ?? {})
      },
      steps: filteredExplicitSteps,
      executionMode: resolvedExecutionMode
    };
    assertTaskSpecTemplatesResolved(resolvedTaskSpec);
    return resolvedTaskSpec;
  }

  async draftReply({
    watchRule,
    detection,
    pack
  }: {
    watchRule: WatchRule;
    detection: WatchDetection;
    pack: LivePack;
  }): Promise<LivePackDraftResponse> {
    if (detection?.replyText) {
      return {
        replyText: String(detection.replyText),
        metadata: {
          source: "detection"
        }
      };
    }

    if (typeof pack?.draftReply === "function") {
      return pack.draftReply({
        rule: watchRule,
        detection,
        controlPlane: this.controlPlane
      });
    }

    const summary = String(detection?.summary ?? "").trim();
    const context = Array.isArray(detection?.context) ? detection.context : [];
    const replyLanguageHint = inferReplyLanguage({ summary, context });
    const chinese =
      replyLanguageHint === "zh"
      || (replyLanguageHint === null && /[\u4e00-\u9fff]/u.test(`${watchRule.goal} ${summary} ${context.join(" ")}`));
    return {
      replyText: chinese ? "收到，我会尽快处理。" : "Got it. I will follow up shortly.",
      metadata: {
        source: "fallback"
      }
    };
  }

  async createTaskFromWatchRule(
    watchRule: WatchRule,
    detection: WatchDetection = {},
    options: Record<string, unknown> = {}
  ): Promise<TaskRecord> {
    const taskSpec = this.buildTaskSpecFromWatchRule(watchRule, detection, options);
    return this.controlPlane.createTask(taskSpec);
  }

  async buildNoTriggerDebug(
    watchRule: WatchRule,
    worldState: WorldState | null,
    reason: string,
    stage: WatchScanStage | null
  ): Promise<Record<string, unknown>> {
    const baseDebug = {
      lastNoTriggerReason: reason,
      lastNoTriggerStage: stage,
      lastNoTriggerAt: nowIso(),
      lastNoTriggerRunnerType: runnerTypeForPack(watchRule.livePack, watchRule.preferredSurface),
      lastNoTriggerScene: null,
      lastNoTriggerSelectedTarget: null,
      lastNoTriggerSkipReasons: [reason],
      lastNoTriggerRecoveryAction: null
    };
    if (watchRule.livePack !== "wechat-desktop" || !worldState) {
      return baseDebug;
    }

    const analysis = await analyzeDesktopConversationPackWithVision({
      packName: watchRule.livePack,
      worldState,
      modelClient: this.controlPlane.modelClient
    }).catch(() => null);

    return {
      ...baseDebug,
      lastNoTriggerUnreadCandidate: String(analysis?.unreadCandidate?.text ?? "").trim() || null,
      lastNoTriggerComposeCandidate: String(analysis?.composeCandidate?.text ?? "").trim() || null,
      lastNoTriggerScene: analysis?.scene ?? null,
      lastNoTriggerSelectedTarget: String(analysis?.selectedTarget ?? analysis?.unreadCandidate?.text ?? "").trim() || null,
      lastNoTriggerSkipReasons:
        Array.isArray(analysis?.skipReasons) && analysis.skipReasons.length
          ? analysis.skipReasons.map((entry) => String(entry).trim()).filter(Boolean).slice(0, 6)
          : [reason],
      lastNoTriggerRecoveryAction: analysis?.recoveryAction ?? null,
      lastNoTriggerTopUnread: Array.isArray(analysis?.topUnreadCandidates)
        ? analysis.topUnreadCandidates.map((candidate) => String(candidate.text ?? "").trim()).filter(Boolean).slice(0, 5)
        : []
    };
  }

  async scan(ruleId: string): Promise<void> {
    const rule = this.store.getWatchRule(ruleId);
    if (!rule || !rule.enabled) {
      return;
    }

    const cleanedDedupeState = clearExpiredSurfaceHealthState(clearExpiredReplyApprovalGrant(rule.dedupeState ?? {}));
    const grantStateChanged = JSON.stringify(cleanedDedupeState) !== JSON.stringify(rule.dedupeState ?? {});
    const hydratedRule = grantStateChanged
      ? this.store.putWatchRule({
          ...rule,
          dedupeState: cleanedDedupeState
        })
      : rule;
    let activeRule = hydratedRule ?? rule;
    let scanConversationThreadKey: string | null = null;
    let currentScanStage: WatchScanStage | null = null;
    let noTriggerReason: string | null = null;

    const retryAfter = Number(activeRule.dedupeState?.retryAfter ?? 0);
    if (retryAfter && retryAfter > Date.now()) {
      return;
    }

    if (surfaceHealthCooldownActive(activeRule.dedupeState ?? {})) {
      return;
    }

    const pack = this.livePackRegistry.get(activeRule.livePack);
    if (!pack) {
      const degraded = this.store.putWatchRule({
        ...activeRule,
        status: "degraded",
        lastError: `Unknown live pack: ${activeRule.livePack}`
      });
      this.eventBus.broadcast("watch.updated", this.controlPlane.watchService.decorate(degraded));
      return;
    }

    const modelBudget = this.createModelBudget(activeRule);
    let workspace: WorkspaceProfile | null = null;
    const collectArtifactUsage = async (): Promise<ArtifactUsage | null> =>
      workspace && this.controlPlane.artifactStore && typeof this.controlPlane.artifactStore.getUsage === "function"
        ? this.controlPlane.artifactStore.getUsage(workspace)
        : null;

    try {
      const activeTaskId = String(activeRule.dedupeState?.activeTaskId ?? "") || null;
      const activeTask = activeTaskId ? this.store.getTask(activeTaskId) : null;
      const activeDraftId = String(activeRule.dedupeState?.activeDraftId ?? "") || null;
      const activeDraft = activeDraftId ? this.store.getDraft(activeDraftId) : null;
      if (isActiveTask(activeTask)) {
        const updated = this.store.putWatchRule({
          ...activeRule,
          lastObservedAt: nowIso(),
          lastError: null,
          status: "watching",
          dedupeState: this.finishScanState(activeRule, clearWatchFailureState({
            ...(activeRule.dedupeState ?? {}),
            activeTaskId
          }))
        });
        this.eventBus.broadcast("watch.updated", this.controlPlane.watchService.decorate(updated));
        return;
      }

      if (activeDraft?.status === "pending") {
        const updated = this.store.putWatchRule({
          ...activeRule,
          lastObservedAt: nowIso(),
          lastError: null,
          status: "awaiting_approval",
          dedupeState: this.finishScanState(activeRule, clearWatchFailureState({
            ...(activeRule.dedupeState ?? {}),
            activeDraftId
          }))
        });
        this.eventBus.broadcast("watch.updated", this.controlPlane.watchService.decorate(updated));
        return;
      }

      if (activeDraftId && activeDraft && ["approved", "rejected", "expired"].includes(activeDraft.status)) {
        activeRule = this.store.putWatchRule({
          ...activeRule,
          dedupeState: this.finishScanState(activeRule, {
            ...(activeRule.dedupeState ?? {}),
            activeDraftId: null
          })
        });
        this.eventBus.broadcast("watch.updated", this.controlPlane.watchService.decorate(activeRule));
      }

      if (activeTaskId && activeTask?.status === "completed" && activeRule.dedupeState?.lastHandledTaskId !== activeTaskId) {
        await pack.markHandled?.({
          rule: activeRule,
          task: activeTask,
          controlPlane: this.controlPlane
        });

        let dedupeState: Record<string, unknown> = {
          ...(activeRule.dedupeState ?? {}),
          lastHandledTaskId: activeTaskId,
          activeTaskId: null
        };
        const completionThread = findConversationThreadByTaskId(activeRule.dedupeState ?? {}, activeTaskId);
        if (completionThread?.threadKey) {
          dedupeState = recordConversationTaskCompletion(dedupeState, {
            threadKey: completionThread.threadKey,
            completedAt: activeTask.updatedAt ?? nowIso()
          });
        }

        activeRule = this.store.putWatchRule({
          ...activeRule,
          dedupeState: this.finishScanState(activeRule, dedupeState)
        });
        this.eventBus.broadcast("watch.updated", this.controlPlane.watchService.decorate(activeRule));
      }

      if (activeTaskId && activeTask && ["failed", "blocked", "interrupted"].includes(activeTask.status)) {
        const failureCount = Number(activeRule.dedupeState?.failureCount ?? 0) + 1;
        const maxConsecutiveFailures = Math.max(
          1,
          Number((activeRule.watchProfile?.governance as WatchGovernance | undefined)?.maxConsecutiveFailures ?? 3)
        );
        const backoffMs = Math.min(
          Math.max(activeRule.pollIntervalMs * 2 ** Math.max(failureCount - 1, 0), activeRule.pollIntervalMs),
          300000
        );
        const retryAt = Date.now() + backoffMs;
        const failedAt = activeTask.updatedAt ?? nowIso();
        const failureThreadKey =
          findConversationThreadByTaskId(activeRule.dedupeState ?? {}, activeTaskId)?.threadKey ??
          normalizeConversationThreadKey(activeRule.dedupeState?.activeConversationThreadKey);
        let dedupeState: Record<string, unknown> = {
          ...(activeRule.dedupeState ?? {}),
          activeTaskId: null,
          failureCount,
          backoffMs,
          retryAfter: retryAt
        };
        if (failureThreadKey) {
          dedupeState = recordConversationFailure(dedupeState, {
            threadKey: failureThreadKey,
            failedAt,
            cooldownUntil: retryAt
          });
        }
        const failureMessage = activeTask.error ?? `watch task ${activeTask.status}`;
        activeRule = this.store.putWatchRule({
          ...activeRule,
          lastObservedAt: nowIso(),
          lastError: failureMessage,
          status: failureCount >= maxConsecutiveFailures ? "degraded" : "backoff",
          dedupeState
        });
        this.eventBus.broadcast("watch.updated", this.controlPlane.watchService.decorate(activeRule));
        this.eventBus.broadcast("watch.backoff", {
          rule: activeRule,
          backoffMs
        });
        this.eventBus.broadcast("watch.error", {
          rule: activeRule,
          error: failureMessage
        });
        return;
      }

      const workspaceName = activeRule.workspaceName ?? `${activeRule.livePack}-live`;
      currentScanStage = "prepare_workspace";
      [activeRule, workspace] = await this.runScanStage(activeRule, currentScanStage, async () =>
        this.controlPlane.workspaceManager.prepareProfile(workspaceName, {
          purpose: "live-watch",
          livePack: activeRule.livePack,
          appTarget: activeRule.appTarget ?? null
        })
      );

      const storageGuard = await collectStorageGuardStatus(workspace);
      if (storageGuard?.active) {
        const retryAt = Date.now() + STORAGE_GUARD_BACKOFF_MS;
        const artifactUsage = await collectArtifactUsage();
        const dedupeState = recordUsageMetadata(
          {
            ...(activeRule.dedupeState ?? {}),
            retryAfter: retryAt,
            backoffMs: STORAGE_GUARD_BACKOFF_MS,
            storageGuard
          },
          {
            status: "paused",
            usage: this.controlPlane.modelClient.usageSummary(modelBudget)
          },
          artifactUsage
        );
        activeRule = this.store.putWatchRule({
          ...activeRule,
          lastObservedAt: nowIso(),
          lastError: `storage_guard_triggered: disk used ${storageGuard.usedPercent ?? "unknown"}% above maximum ${storageGuard.maximumUsedPercent}%`,
          status: "backoff",
          dedupeState
        });
        this.eventBus.broadcast("watch.updated", this.controlPlane.watchService.decorate(activeRule));
        this.eventBus.broadcast("watch.backoff", {
          rule: activeRule,
          backoffMs: STORAGE_GUARD_BACKOFF_MS
        });
        this.eventBus.broadcast("watch.error", {
          rule: activeRule,
          error: activeRule.lastError
        });
        return;
      }

      const scanSession = await this.controlPlane.surfaceCoordinator.withWatchScanSession(
        {
          surface: activeRule.preferredSurface,
          workspaceKey: workspace.name,
          holderId: `watch:${activeRule.id}:scan`,
          watchId: activeRule.id,
          reason: `${activeRule.livePack} scan`
        },
        async ({ surfaceRegistry }) => {
          activeRule = {
            ...activeRule,
            dedupeState: recordSurfaceHealth(activeRule.dedupeState ?? {}, {
              state: "healthy"
            })
          };

          currentScanStage = "activate_pack";
          [activeRule] = await this.runScanStage(activeRule, currentScanStage, async () => {
            await pack.activate?.({
              rule: activeRule,
              workspace,
              surfaceRegistry,
              controlPlane: this.controlPlane
            });
            return true;
          });

          let worldState: WorldState | null = null;
          if (pack.observeInbox) {
            currentScanStage = "observe_inbox";
            [activeRule, worldState] = await this.runScanStage(activeRule, currentScanStage, async () =>
              pack.observeInbox?.({
                rule: activeRule,
                workspace,
                surfaceRegistry,
                controlPlane: this.controlPlane
              }) ?? null
            );
          }

          currentScanStage = "detect_items";
          let detection: WatchDetection | null;
          [activeRule, detection] = await this.runScanStage(activeRule, currentScanStage, async () =>
            this.runWithModelBudget(modelBudget, async () =>
              pack.detectNewItems?.({
                rule: activeRule,
                worldState,
                dedupeState: activeRule.dedupeState ?? {},
                workspace,
                surfaceRegistry,
                controlPlane: this.controlPlane
              }) ?? null
            )
          );
          if (!detection) {
            noTriggerReason = "no_detection";
          }

          if (detection && pack.extractContext) {
            currentScanStage = "extract_context";
            let context: Awaited<ReturnType<NonNullable<typeof pack.extractContext>>>;
            [activeRule, context] = await this.runScanStage(activeRule, currentScanStage, async () =>
              this.runWithModelBudget(modelBudget, async () =>
                pack.extractContext?.({
                  rule: activeRule,
                  detection,
                  worldState,
                  workspace,
                  controlPlane: this.controlPlane,
                  surfaceRegistry
                }) ?? null
              )
            );
            if (!context) {
              noTriggerReason = "extract_context_empty";
              detection = null;
            } else {
              const mergedTaskSpec =
                detection.taskSpec || context?.taskSpec
                  ? {
                      ...(detection.taskSpec ?? {}),
                      ...(context?.taskSpec ?? {})
                    }
                  : undefined;
              detection = {
                ...detection,
                ...context,
                inputs: {
                  ...(detection.inputs ?? {}),
                  ...(context?.inputs ?? {})
                },
                metadata: {
                  ...(detection.metadata ?? {}),
                  ...(context?.metadata ?? {})
                },
                ...(mergedTaskSpec ? { taskSpec: mergedTaskSpec } : {})
              };
            }
          }

          return {
            worldState,
            detection
          };
        }
      );

      if (!scanSession) {
        const artifactUsage = await collectArtifactUsage();
        const updated = this.store.putWatchRule({
          ...activeRule,
          lastObservedAt: nowIso(),
          lastError: null,
          status: "watching",
          dedupeState: this.finishScanState(
            activeRule,
            recordUsageMetadata(
              recordSurfaceHealth(
                {
                  ...(activeRule.dedupeState ?? {})
                },
                {
                  state: "busy"
                }
              ),
              modelBudget,
              artifactUsage
            )
          )
        });
        this.eventBus.broadcast("watch.updated", this.controlPlane.watchService.decorate(updated));
        return;
      }

      let { worldState, detection } = scanSession;

      if (!detection) {
        const noTriggerDebug = await this.runWithModelBudget(modelBudget, async () =>
          this.buildNoTriggerDebug(
            activeRule,
            worldState,
            noTriggerReason ?? "no_detection",
            currentScanStage
          )
        );
        const resetDedupeState = clearWatchFailureState({
          ...(activeRule.dedupeState ?? {}),
          failureCount: 0,
          activeTaskId: null
        });
        const repeatedNoTriggerCount = nextRepeatedNoTriggerCount(activeRule.dedupeState ?? {}, {
          reason: String(noTriggerDebug.lastNoTriggerReason ?? noTriggerReason ?? "no_detection"),
          scene: String(noTriggerDebug.lastNoTriggerScene ?? "").trim() || null,
          selectedTarget: String(noTriggerDebug.lastNoTriggerSelectedTarget ?? "").trim() || null
        });
        const artifactUsage = await collectArtifactUsage();
        let dedupeState = recordUsageMetadata({
          ...resetDedupeState,
          ...noTriggerDebug,
          repeatedNoTriggerCount
        }, modelBudget, artifactUsage);
        if (desktopCooldownEligible(activeRule) && repeatedNoTriggerCount >= REPEATED_NO_TRIGGER_COOLDOWN_THRESHOLD) {
          const cooldownUntil = Date.now() + DESKTOP_SURFACE_COOLDOWN_MS;
          dedupeState = recordSurfaceHealth(dedupeState, {
            state: "cooldown",
            cooldownUntil
          });
          dedupeState.retryAfter = cooldownUntil;
          dedupeState.backoffMs = DESKTOP_SURFACE_COOLDOWN_MS;
        } else if (isDesktopSurfaceRule(activeRule)) {
          dedupeState = recordSurfaceHealth(dedupeState, {
            state: "healthy"
          });
        }
        const updated = this.store.putWatchRule({
          ...activeRule,
          lastObservedAt: nowIso(),
          lastError: null,
          status: "watching",
          dedupeState: this.finishScanState(activeRule, dedupeState)
        });
        this.eventBus.broadcast("watch.updated", this.controlPlane.watchService.decorate(updated));
        return;
      }

      const manualInterventionKind = detection.metadata?.manualInterventionKind ?? null;
      const manualInterventionDetail = String(detection.metadata?.manualInterventionDetail ?? "").trim();
      const manualInterventionAction = String(detection.metadata?.manualInterventionAction ?? "").trim();
      if (detection.metadata?.requiresManualIntervention) {
        const artifactUsage = await collectArtifactUsage();
        const updated = this.store.putWatchRule({
          ...activeRule,
          lastObservedAt: nowIso(),
          lastError: manualInterventionDetail || detection.summary || "manual intervention required",
          status: "degraded",
          dedupeState: this.finishScanState(activeRule, recordUsageMetadata({
            ...clearWatchFailureState({
              ...(activeRule.dedupeState ?? {}),
              lastFingerprint: detection.fingerprint ?? detection.summary ?? null,
              lastSummary: detection.summary ?? null,
              lastContext: detection.context ?? [],
              activeTaskId: null,
              activeDraftId: null
            }),
            attentionKind: manualInterventionKind,
            attentionDetail: manualInterventionDetail || null,
            attentionAction: manualInterventionAction || null
          }, modelBudget, artifactUsage))
        });
        this.eventBus.broadcast("watch.updated", this.controlPlane.watchService.decorate(updated));
        this.eventBus.broadcast("watch.blocked", {
          rule: updated,
          automation: {
            action: "block",
            policy: "blocked",
            reasons: [manualInterventionDetail || detection.summary || "manual intervention required"]
          },
          detection
        });
        return;
      }

      const observedAt = nowIso();
      scanConversationThreadKey = managedConversationThreadKey(detection);
      const observedDedupeState = scanConversationThreadKey
        ? recordConversationObservation(activeRule.dedupeState ?? {}, detection, {
            updatedAt: observedAt
          })
        : (activeRule.dedupeState ?? {});
      let replyDraft: LivePackDraftResponse | null = null;
      if (shouldDraftReply(activeRule, detection)) {
        currentScanStage = "draft_reply";
        [activeRule, replyDraft] = await this.runScanStage(activeRule, currentScanStage, async () =>
          this.runWithModelBudget(modelBudget, async () =>
            this.draftReply({
              watchRule: activeRule,
              detection,
              pack
            })
          )
        );
      }
      const sendTaskSpec = this.buildTaskSpecFromWatchRule(activeRule, detection, {
        replyText: replyDraft?.replyText ?? null,
        autoSend: true
      });
      const replyApprovalActive = hasActiveReplyApprovalGrant(
        observedDedupeState === (activeRule.dedupeState ?? {})
          ? activeRule
          : {
              ...activeRule,
              dedupeState: observedDedupeState
            },
        detection
      );
      const automation = this.controlPlane.policyEngine.evaluateAutomation({
        taskSpec: sendTaskSpec,
        watchRule: activeRule,
        detection,
        replyText: replyDraft?.replyText ?? "",
        replyApprovalActive
      }) as RiskGateDecision;
      const governance = watchGovernance(activeRule);

      if (automation.action !== "block" && withinCooldown(activeRule, governance)) {
        const artifactUsage = await collectArtifactUsage();
        const updated = this.store.putWatchRule({
          ...activeRule,
          lastObservedAt: observedAt,
          lastError: null,
          status: "watching",
          dedupeState: this.finishScanState(activeRule, recordUsageMetadata(observedDedupeState, modelBudget, artifactUsage))
        });
        this.eventBus.broadcast("watch.skipped", {
          rule: updated,
          reason: "cooldown_active",
          cooldownMs: governance.cooldownMs ?? 0
        });
        this.eventBus.broadcast("watch.updated", this.controlPlane.watchService.decorate(updated));
        return;
      }

      const autoActionsToday = autoActionCount(activeRule);
      const maxAutoActionsPerDay = Math.max(0, Number(governance.maxAutoActionsPerDay ?? 0));
      const threadEscalated = scanConversationThreadKey
        ? isConversationThreadEscalated(observedDedupeState, scanConversationThreadKey)
        : false;
      const threadCooldownActive = scanConversationThreadKey
        ? isConversationThreadCooldownActive(observedDedupeState, scanConversationThreadKey)
        : false;
      let governedAutomation = automation;
      if (automation.action === "send" && maxAutoActionsPerDay > 0 && autoActionsToday >= maxAutoActionsPerDay) {
        governedAutomation = downgradeToDraft(automation, "watch governance max auto actions per day reached");
      } else if (automation.action === "send" && threadCooldownActive) {
        governedAutomation = downgradeToDraft(automation, "conversation thread cooldown active");
      } else if (automation.action === "send" && threadEscalated) {
        governedAutomation = downgradeToDraft(automation, "conversation thread requires re-approval after a failed auto-send");
      } else if (automation.action === "send" && replyDraft && isWithinQuietHours(governance)) {
        governedAutomation = downgradeToDraft(automation, "watch governance quiet hours active");
      }

      if (governedAutomation.action === "block") {
        const artifactUsage = await collectArtifactUsage();
        const updated = this.store.putWatchRule({
          ...activeRule,
          lastObservedAt: observedAt,
          lastError: governedAutomation.reasons.join("; ") || "automation blocked",
          status: "degraded",
          dedupeState: this.finishScanState(activeRule, recordUsageMetadata(clearWatchFailureState({
            ...observedDedupeState,
            lastFingerprint: detection.fingerprint ?? detection.summary ?? null,
            lastSummary: detection.summary ?? null,
            lastContext: detection.context ?? [],
            activeTaskId: null,
            activeDraftId: null
          }), modelBudget, artifactUsage))
        });
        this.eventBus.broadcast("watch.updated", this.controlPlane.watchService.decorate(updated));
        this.eventBus.broadcast("watch.blocked", {
          rule: updated,
          automation: governedAutomation,
          detection
        });
        return;
      }

      if (governedAutomation.action === "draft") {
        const draft = this.controlPlane.draftService.create({
          watchRule: activeRule,
          taskSpec: sendTaskSpec,
          detection: detection as Record<string, unknown>,
          riskDecision: governedAutomation,
          replyText: replyDraft?.replyText ?? null,
          summary: detection.summary ?? null,
          metadata: {
            replyThreadKey: deriveReplyThreadKey(detection),
            threadKey: String(detection.metadata?.threadKey ?? "").trim() || null,
            messageId: String(detection.metadata?.messageId ?? "").trim() || null,
            sender: String(detection.metadata?.sender ?? "").trim() || null,
            direction: String(detection.metadata?.direction ?? "").trim() || null,
            receivedAt: String(detection.metadata?.receivedAt ?? "").trim() || null,
            requiresAttention:
              typeof detection.metadata?.requiresAttention === "boolean"
                ? detection.metadata.requiresAttention
                : null,
            reply: replyDraft?.metadata ?? {},
            context: detection.context ?? []
          }
        });
        let dedupeState: Record<string, unknown> = clearWatchFailureState({
          ...observedDedupeState,
          lastFingerprint: detection.fingerprint ?? detection.summary ?? draft.id,
          lastSummary: detection.summary ?? null,
          lastContext: detection.context ?? [],
          activeTaskId: null,
          activeDraftId: draft.id,
          failureCount: 0
        });
        if (scanConversationThreadKey) {
          dedupeState = recordConversationObservation(dedupeState, detection, {
            activate: true,
            updatedAt: observedAt
          });
        }
        const artifactUsage = await collectArtifactUsage();
        const updated = this.store.putWatchRule({
          ...activeRule,
          lastObservedAt: observedAt,
          lastTriggeredAt: observedAt,
          lastError: null,
          status: "awaiting_approval",
          dedupeState: this.finishScanState(activeRule, recordUsageMetadata(dedupeState, modelBudget, artifactUsage))
        });
        this.eventBus.broadcast("watch.drafted", {
          rule: updated,
          draft,
          detection
        });
        this.eventBus.broadcast("watch.updated", this.controlPlane.watchService.decorate(updated));
        return;
      }

      const taskSpec =
        governedAutomation.action === "prefill"
          ? this.buildTaskSpecFromWatchRule(activeRule, detection, {
              replyText: replyDraft?.replyText ?? null,
              autoSend: false
            })
          : sendTaskSpec;
      currentScanStage = "create_task";
      let task: TaskRecord;
      [activeRule, task] = await this.runScanStage(activeRule, currentScanStage, async () =>
        this.controlPlane.createTask(taskSpec)
      );
      let dedupeState: Record<string, unknown> = clearWatchFailureState({
        ...recordAutoAction(observedDedupeState),
        lastFingerprint: detection.fingerprint ?? detection.summary ?? task.id,
        lastSummary: detection.summary ?? null,
        lastContext: detection.context ?? [],
        activeTaskId: task.id,
        failureCount: 0
      });
      if (scanConversationThreadKey) {
        dedupeState = recordConversationTaskDispatch(dedupeState, detection, {
          taskId: task.id,
          dispatchedAt: observedAt
        });
      }
      const artifactUsage = await collectArtifactUsage();
      const updated = this.store.putWatchRule({
        ...activeRule,
        lastObservedAt: observedAt,
        lastTriggeredAt: observedAt,
        lastError: null,
        status: "watching",
        dedupeState: this.finishScanState(activeRule, recordUsageMetadata(dedupeState, modelBudget, artifactUsage))
      });
      this.eventBus.broadcast("watch.triggered", {
        rule: updated,
        task,
        detection
      });
      this.eventBus.broadcast("watch.updated", this.controlPlane.watchService.decorate(updated));
    } catch (error) {
      const current = this.store.getWatchRule(ruleId);
      const failureCount = Number(current?.dedupeState?.failureCount ?? 0) + 1;
      const maxConsecutiveFailures = Math.max(
        1,
        Number((current?.watchProfile?.governance as WatchGovernance | undefined)?.maxConsecutiveFailures ?? 3)
      );
      const backoffMs = Math.min(
        Math.max((current ?? rule).pollIntervalMs * 2 ** Math.max(failureCount - 1, 0), (current ?? rule).pollIntervalMs),
        300000
      );
      const retryAt = Date.now() + backoffMs;
      let dedupeState: Record<string, unknown> = {
        ...((current ?? rule).dedupeState ?? {}),
        failureCount,
        backoffMs,
        retryAfter: retryAt,
        scanStage: currentScanStage,
        scanStageStatus: currentScanStage ? "failed" : null,
        scanStageStartedAt:
          String((current ?? rule).dedupeState?.scanStageStartedAt ?? "").trim() ||
          (currentScanStage ? nowIso() : null),
        scanStageTimeoutMs:
          currentScanStage != null ? this.scanStageTimeoutForRule(current ?? rule, currentScanStage) : null
      };
      if (scanConversationThreadKey) {
        dedupeState = recordConversationFailure(dedupeState, {
          threadKey: scanConversationThreadKey,
          failedAt: nowIso(),
          cooldownUntil: retryAt
        });
      }
      const artifactUsage = await collectArtifactUsage();
      dedupeState = recordUsageMetadata(dedupeState, modelBudget, artifactUsage);
      if (desktopCooldownEligible(current ?? rule) && failureCount >= REPEATED_NO_TRIGGER_COOLDOWN_THRESHOLD) {
        const cooldownUntil = Date.now() + DESKTOP_SURFACE_COOLDOWN_MS;
        dedupeState = recordSurfaceHealth(dedupeState, {
          state: "cooldown",
          cooldownUntil
        });
        dedupeState.retryAfter = cooldownUntil;
        dedupeState.backoffMs = DESKTOP_SURFACE_COOLDOWN_MS;
      } else if (isDesktopSurfaceRule(current ?? rule)) {
        dedupeState = recordSurfaceHealth(dedupeState, {
          state: "healthy"
        });
      }
      const updated = this.store.putWatchRule({
        ...(current ?? rule),
        lastObservedAt: nowIso(),
        lastError:
          error instanceof ModelBudgetExceededError
            ? `Model request budget exceeded after ${error.budget.usage.requestCount} request(s)`
            : error instanceof Error
              ? error.message
              : String(error),
        status: failureCount >= maxConsecutiveFailures ? "degraded" : "backoff",
        dedupeState
      });
      this.eventBus.broadcast("watch.updated", this.controlPlane.watchService.decorate(updated));
      this.eventBus.broadcast("watch.backoff", {
        rule: updated,
        backoffMs
      });
      this.eventBus.broadcast("watch.error", {
        rule: updated,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
