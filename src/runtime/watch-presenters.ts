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
    threadKey: threadState?.threadKey ?? null,
    threadFailureCount: threadState?.failureCount ?? 0,
    threadCooldownUntil: threadState?.cooldownUntil ? new Date(threadState.cooldownUntil).toISOString() : null,
    replyLeaseExpiresAt: threadState?.replyLeaseExpiresAt ? new Date(threadState.replyLeaseExpiresAt).toISOString() : null,
    threadEscalatedAt: threadState?.escalatedAt ?? null,
    lastInboundMessageId: threadState?.lastInboundMessageId ?? null,
    lastInboundReceivedAt: threadState?.lastInboundReceivedAt ?? null,
    lastAgentActionAt: threadState?.lastAgentActionAt ?? null,
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
