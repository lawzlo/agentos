import type { ReplyPolicyMode, TaskSpec, WatchDetection, WatchGovernance, WatchRule } from "../types/runtime-schema.js";
import {
  clearExpiredConversationState,
  deriveConversationThreadKey,
  hasActiveConversationLease,
  normalizeConversationThreadKey,
  recordConversationApproval
} from "./conversation-thread-state.js";

export const DEFAULT_REPLY_APPROVAL_WINDOW_MS = 12 * 60 * 60 * 1000;
const MAX_REPLY_APPROVAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function normalizePolicyValue(value: unknown): Exclude<ReplyPolicyMode, "pack_default"> | null {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized === "pack_default") {
    return null;
  }

  if (["auto_send", "draft_first", "prefill_first", "approve_once_then_auto", "blocked"].includes(normalized)) {
    return normalized as Exclude<ReplyPolicyMode, "pack_default">;
  }

  return null;
}

export function packDefaultReplyPolicy(livePack: string): Exclude<ReplyPolicyMode, "pack_default"> {
  if (["slack-desktop", "slack-browser", "wechat-desktop"].includes(String(livePack))) {
    return "auto_send";
  }

  if (["generic-mail-desktop", "generic-mail-browser", "outlook-desktop", "boss-browser"].includes(String(livePack))) {
    return "draft_first";
  }

  return "blocked";
}

export function resolveReplyPolicy({
  watchRule = null,
  taskSpec = null,
  livePack = ""
}: {
  watchRule?: WatchRule | null;
  taskSpec?: TaskSpec | null;
  livePack?: string;
}): Exclude<ReplyPolicyMode, "pack_default"> {
  const inputs = (taskSpec?.inputs ?? {}) as Record<string, unknown>;
  const explicit =
    normalizePolicyValue(watchRule?.watchProfile?.governance?.replyPolicy) ??
    normalizePolicyValue(watchRule?.taskInputs?.replyPolicy) ??
    normalizePolicyValue(watchRule?.watchProfile?.metadata?.replyPolicy) ??
    normalizePolicyValue(inputs.replyPolicy);

  return explicit ?? packDefaultReplyPolicy(String(livePack ?? watchRule?.livePack ?? ""));
}

export function replyApprovalWindowMs(governance: WatchGovernance | null | undefined): number {
  const raw = Number(governance?.replyApprovalWindowMs ?? DEFAULT_REPLY_APPROVAL_WINDOW_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_REPLY_APPROVAL_WINDOW_MS;
  }

  return Math.max(1, Math.min(Math.round(raw), MAX_REPLY_APPROVAL_WINDOW_MS));
}

export function deriveReplyThreadKey(detection: WatchDetection | Record<string, unknown> | null | undefined): string | null {
  return deriveConversationThreadKey(detection);
}

export function hasActiveReplyApprovalGrant(
  watchRule: WatchRule | null | undefined,
  detection: WatchDetection | null | undefined,
  now = Date.now()
): boolean {
  if (hasActiveConversationLease(watchRule?.dedupeState ?? {}, detection, now)) {
    return true;
  }

  const threadKey = deriveReplyThreadKey(detection);
  if (!threadKey) {
    return false;
  }

  const storedThreadKey = normalizeConversationThreadKey(watchRule?.dedupeState?.replyApprovalThreadKey);
  const expiresAt = Number(watchRule?.dedupeState?.replyApprovalExpiresAt ?? 0);
  return Boolean(storedThreadKey && storedThreadKey === threadKey && Number.isFinite(expiresAt) && expiresAt > now);
}

export function recordReplyApprovalGrant(
  dedupeState: Record<string, unknown> = {},
  threadKey: string,
  expiresAt: number
): Record<string, unknown> {
  return recordConversationApproval(dedupeState, {
    threadKey,
    expiresAt: Math.max(0, Math.round(expiresAt))
  });
}

export function clearExpiredReplyApprovalGrant(
  dedupeState: Record<string, unknown> = {},
  now = Date.now()
): Record<string, unknown> {
  const cleanedState = clearExpiredConversationState(dedupeState, now);
  const hasGrantFields = cleanedState.replyApprovalThreadKey != null || cleanedState.replyApprovalExpiresAt != null;
  if (!hasGrantFields) {
    return cleanedState;
  }

  const expiresAt = Number(cleanedState.replyApprovalExpiresAt ?? 0);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return {
      ...cleanedState,
      replyApprovalThreadKey: null,
      replyApprovalExpiresAt: null
    };
  }

  return cleanedState;
}
