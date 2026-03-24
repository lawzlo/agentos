import type { DraftRecord, TaskSnapshot, WatchHealth, WatchRule } from "../types/runtime-schema.js";
import { currentConversationThreadState } from "./conversation-thread-state.js";

export interface DecoratedDraftRecord extends DraftRecord {
  watch: WatchRule | null;
  task: TaskSnapshot | null;
}

export function buildWatchHealth(rule: WatchRule | null): WatchHealth | null {
  if (!rule) {
    return null;
  }

  const retryAfter = Number(rule.dedupeState?.retryAfter ?? 0);
  const activeTaskId = String(rule.dedupeState?.activeTaskId ?? "").trim() || null;
  const activeDraftId = String(rule.dedupeState?.activeDraftId ?? "").trim() || null;
  const failureCount = Number(rule.dedupeState?.failureCount ?? 0);
  const threadState = currentConversationThreadState(rule.dedupeState ?? {});
  const usageSummaryState =
    rule.dedupeState?.usageSummary && typeof rule.dedupeState.usageSummary === "object"
      ? (rule.dedupeState.usageSummary as Record<string, unknown>)
      : null;
  const artifactUsageState =
    rule.dedupeState?.artifactUsage && typeof rule.dedupeState.artifactUsage === "object"
      ? (rule.dedupeState.artifactUsage as Record<string, unknown>)
      : null;
  const storageGuardState =
    rule.dedupeState?.storageGuard && typeof rule.dedupeState.storageGuard === "object"
      ? (rule.dedupeState.storageGuard as Record<string, unknown>)
      : null;
  const state = !rule.enabled || rule.status === "disabled"
    ? "disabled"
    : rule.status === "degraded"
      ? "degraded"
      : rule.status === "backoff"
        ? "warning"
        : "healthy";

  return {
    state,
    failureCount,
    retryAfter: retryAfter ? new Date(retryAfter).toISOString() : null,
    retryAfterMs: retryAfter && retryAfter > Date.now() ? retryAfter - Date.now() : null,
    activeTaskId,
    activeDraftId,
    lastHandledFingerprint: String(rule.dedupeState?.lastFingerprint ?? "").trim() || null,
    attentionKind: (String(rule.dedupeState?.attentionKind ?? "").trim() || null) as WatchHealth["attentionKind"],
    attentionDetail: String(rule.dedupeState?.attentionDetail ?? "").trim() || null,
    attentionAction: String(rule.dedupeState?.attentionAction ?? "").trim() || null,
    threadKey: threadState?.threadKey ?? null,
    threadFailureCount: threadState?.failureCount ?? 0,
    threadCooldownUntil: threadState?.cooldownUntil ? new Date(threadState.cooldownUntil).toISOString() : null,
    replyLeaseExpiresAt: threadState?.replyLeaseExpiresAt ? new Date(threadState.replyLeaseExpiresAt).toISOString() : null,
    threadEscalatedAt: threadState?.escalatedAt ?? null,
    lastInboundMessageId: threadState?.lastInboundMessageId ?? null,
    lastInboundReceivedAt: threadState?.lastInboundReceivedAt ?? null,
    lastAgentActionAt: threadState?.lastAgentActionAt ?? null,
    scanStage:
      (String(rule.dedupeState?.scanStage ?? "").trim() || null) as WatchHealth["scanStage"],
    scanStageStatus:
      (String(rule.dedupeState?.scanStageStatus ?? "").trim() || null) as WatchHealth["scanStageStatus"],
    scanStageStartedAt: String(rule.dedupeState?.scanStageStartedAt ?? "").trim() || null,
    scanStageTimeoutMs:
      Number.isFinite(Number(rule.dedupeState?.scanStageTimeoutMs))
        ? Number(rule.dedupeState?.scanStageTimeoutMs)
        : null,
    runnerType:
      (String(rule.dedupeState?.lastNoTriggerRunnerType ?? "").trim() || null) as WatchHealth["runnerType"],
    scene:
      (String(rule.dedupeState?.lastNoTriggerScene ?? "").trim() || null) as WatchHealth["scene"],
    selectedTarget: String(rule.dedupeState?.lastNoTriggerSelectedTarget ?? "").trim() || null,
    lastSkipReasons: Array.isArray(rule.dedupeState?.lastNoTriggerSkipReasons)
      ? rule.dedupeState.lastNoTriggerSkipReasons.map((entry) => String(entry).trim()).filter(Boolean)
      : [],
    lastRecoveryAction:
      (String(rule.dedupeState?.lastNoTriggerRecoveryAction ?? "").trim() || null) as WatchHealth["lastRecoveryAction"],
    surfaceHealth:
      (String(rule.dedupeState?.surfaceHealth ?? "").trim() || null) as WatchHealth["surfaceHealth"],
    surfaceHealthCooldownUntil: Number(rule.dedupeState?.surfaceHealthCooldownUntil ?? 0) > 0
      ? new Date(Number(rule.dedupeState?.surfaceHealthCooldownUntil ?? 0)).toISOString()
      : null,
    budgetStatus:
      (String(rule.dedupeState?.budgetStatus ?? "").trim() || null) as WatchHealth["budgetStatus"],
    usageSummary: usageSummaryState
      ? {
            requestCount: Number(usageSummaryState.requestCount ?? 0),
            inputTokens: Number(usageSummaryState.inputTokens ?? 0),
            outputTokens: Number(usageSummaryState.outputTokens ?? 0),
            totalTokens: Number(usageSummaryState.totalTokens ?? 0),
            estimatedCostUsd:
              Number.isFinite(Number(usageSummaryState.estimatedCostUsd))
                ? Number(usageSummaryState.estimatedCostUsd)
                : null
          }
      : null,
    artifactUsage: artifactUsageState
      ? {
            workspaceArtifactBytes: Number(artifactUsageState.workspaceArtifactBytes ?? 0),
            workspaceArtifactLimitBytes: Number(artifactUsageState.workspaceArtifactLimitBytes ?? 0),
            globalArtifactBytes:
              Number.isFinite(Number(artifactUsageState.globalArtifactBytes))
                ? Number(artifactUsageState.globalArtifactBytes)
                : null,
            globalArtifactLimitBytes:
              Number.isFinite(Number(artifactUsageState.globalArtifactLimitBytes))
                ? Number(artifactUsageState.globalArtifactLimitBytes)
                : null,
            prunedFiles: Number(artifactUsageState.prunedFiles ?? 0)
          }
      : null,
    storageGuard: storageGuardState
      ? {
            active: Boolean(storageGuardState.active),
            freeBytes:
              Number.isFinite(Number(storageGuardState.freeBytes))
                ? Number(storageGuardState.freeBytes)
                : null,
            usedPercent:
              Number.isFinite(Number(storageGuardState.usedPercent))
                ? Number(storageGuardState.usedPercent)
                : null,
            maximumUsedPercent: Number(storageGuardState.maximumUsedPercent ?? 0)
          }
      : null,
    summary:
      rule.lastError ??
      (String(rule.dedupeState?.lastSummary ?? "").trim() || null) ??
      null
  };
}

export function decorateWatchRule(rule: WatchRule | null): WatchRule | null {
  if (!rule) {
    return null;
  }

  return {
    ...rule,
    health: buildWatchHealth(rule)
  };
}

export function decorateDraft(
  draft: DraftRecord | null,
  {
    getWatchRule,
    getTask
  }: {
    getWatchRule: (watchRuleId: string) => WatchRule | null;
    getTask: (taskId: string) => TaskSnapshot | null;
  }
): DecoratedDraftRecord | null {
  if (!draft) {
    return null;
  }

  return {
    ...draft,
    watch: draft.watchRuleId ? getWatchRule(draft.watchRuleId) : null,
    task: draft.taskId ? getTask(draft.taskId) : null
  };
}
