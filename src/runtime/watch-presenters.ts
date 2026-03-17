import type { DraftRecord, TaskSnapshot, WatchHealth, WatchRule } from "../types/runtime-schema.js";

type LooseWatchRule = WatchRule | Record<string, any>;
type LooseDraftRecord = DraftRecord | Record<string, any>;

export function buildWatchHealth(rule: LooseWatchRule | null): WatchHealth | null {
  if (!rule) {
    return null;
  }

  const retryAfter = Number(rule.dedupeState?.retryAfter ?? 0);
  const activeTaskId = String(rule.dedupeState?.activeTaskId ?? "").trim() || null;
  const activeDraftId = String(rule.dedupeState?.activeDraftId ?? "").trim() || null;
  const failureCount = Number(rule.dedupeState?.failureCount ?? 0);
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
    summary:
      rule.lastError ??
      (String(rule.dedupeState?.lastSummary ?? "").trim() || null) ??
      null
  };
}

export function decorateWatchRule(rule: LooseWatchRule | null): WatchRule | LooseWatchRule | null {
  if (!rule) {
    return null;
  }

  return {
    ...rule,
    health: buildWatchHealth(rule)
  };
}

export function decorateDraft(
  draft: LooseDraftRecord | null,
  {
    getWatchRule,
    getTask
  }: {
    getWatchRule: (watchRuleId: string) => WatchRule | null;
    getTask: (taskId: string) => TaskSnapshot | null;
  }
) {
  if (!draft) {
    return null;
  }

  return {
    ...draft,
    watch: draft.watchRuleId ? getWatchRule(draft.watchRuleId) : null,
    task: draft.taskId ? getTask(draft.taskId) : null
  };
}
