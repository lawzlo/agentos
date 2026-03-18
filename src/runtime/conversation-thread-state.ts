import type { ConversationThreadState, WatchDetection } from "../types/runtime-schema.js";

function stringValue(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : null;
}

function numericValue(value: unknown): number | null {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function directionValue(value: unknown): ConversationThreadState["lastDirection"] {
  if (value === "inbound" || value === "outbound") {
    return value;
  }
  return "unknown";
}

export function normalizeConversationThreadKey(value: unknown): string | null {
  const normalized = String(value ?? "").trim().replace(/\s+/gu, " ");
  return normalized ? normalized.toLowerCase() : null;
}

export function deriveConversationThreadKey(
  detection: WatchDetection | Record<string, unknown> | null | undefined
): string | null {
  if (!detection || typeof detection !== "object") {
    return null;
  }

  const typedDetection = detection as WatchDetection;
  const inputs = (typedDetection.inputs ?? {}) as Record<string, unknown>;
  const metadata = (typedDetection.metadata ?? {}) as Record<string, unknown>;
  return (
    normalizeConversationThreadKey(metadata.threadKey) ??
    normalizeConversationThreadKey(metadata.replyThreadKey) ??
    normalizeConversationThreadKey(inputs.threadKey) ??
    normalizeConversationThreadKey(inputs.replyThreadKey) ??
    normalizeConversationThreadKey(inputs.openTarget) ??
    normalizeConversationThreadKey(typedDetection.summary) ??
    normalizeConversationThreadKey(typedDetection.text)
  );
}

function sanitizeThreadState(value: unknown, threadKey: string): ConversationThreadState {
  const state = (value ?? {}) as Record<string, unknown>;
  return {
    threadKey,
    lastMessageId: stringValue(state.lastMessageId),
    lastInboundMessageId: stringValue(state.lastInboundMessageId),
    lastInboundReceivedAt: stringValue(state.lastInboundReceivedAt),
    lastSender: stringValue(state.lastSender),
    lastDirection: directionValue(state.lastDirection),
    lastAgentActionAt: stringValue(state.lastAgentActionAt),
    lastAgentTaskId: stringValue(state.lastAgentTaskId),
    replyLeaseExpiresAt: numericValue(state.replyLeaseExpiresAt),
    failureCount: Math.max(0, Number(state.failureCount ?? 0) || 0),
    cooldownUntil: numericValue(state.cooldownUntil),
    escalatedAt: stringValue(state.escalatedAt),
    updatedAt: stringValue(state.updatedAt)
  };
}

export function readConversationThreads(dedupeState: Record<string, unknown> = {}): Record<string, ConversationThreadState> {
  const raw = (dedupeState.conversationThreads ?? {}) as Record<string, unknown>;
  const entries = Object.entries(raw)
    .map(([key, value]) => {
      const normalizedKey = normalizeConversationThreadKey(key);
      return normalizedKey ? [normalizedKey, sanitizeThreadState(value, normalizedKey)] : null;
    })
    .filter(Boolean) as Array<[string, ConversationThreadState]>;

  return Object.fromEntries(entries);
}

export function getConversationThreadState(
  dedupeState: Record<string, unknown> = {},
  threadOrDetection: string | WatchDetection | Record<string, unknown> | null | undefined
): ConversationThreadState | null {
  const threadKey =
    typeof threadOrDetection === "string"
      ? normalizeConversationThreadKey(threadOrDetection)
      : deriveConversationThreadKey(threadOrDetection);
  if (!threadKey) {
    return null;
  }

  return readConversationThreads(dedupeState)[threadKey] ?? null;
}

export function currentConversationThreadState(dedupeState: Record<string, unknown> = {}): ConversationThreadState | null {
  const threads = readConversationThreads(dedupeState);
  const currentKey =
    normalizeConversationThreadKey(dedupeState.activeConversationThreadKey) ??
    normalizeConversationThreadKey(dedupeState.currentConversationThreadKey);
  if (currentKey && threads[currentKey]) {
    return threads[currentKey];
  }

  return (
    Object.values(threads).sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))[0] ?? null
  );
}

function putThreadState(
  dedupeState: Record<string, unknown>,
  threadState: ConversationThreadState,
  {
    active = false
  }: {
    active?: boolean;
  } = {}
): Record<string, unknown> {
  const threadKey = normalizeConversationThreadKey(threadState.threadKey);
  if (!threadKey) {
    return dedupeState;
  }

  const threads = readConversationThreads(dedupeState);
  return {
    ...dedupeState,
    conversationThreads: {
      ...threads,
      [threadKey]: {
        ...threadState,
        threadKey
      }
    },
    currentConversationThreadKey: threadKey,
    ...(active ? { activeConversationThreadKey: threadKey } : {})
  };
}

export function clearExpiredConversationState(
  dedupeState: Record<string, unknown> = {},
  now = Date.now()
): Record<string, unknown> {
  const threads = readConversationThreads(dedupeState);
  let changed = false;
  const nextThreads = Object.fromEntries(
    Object.entries(threads).map(([threadKey, state]) => {
      let nextState = state;
      if (nextState.replyLeaseExpiresAt && nextState.replyLeaseExpiresAt <= now) {
        nextState = {
          ...nextState,
          replyLeaseExpiresAt: null
        };
        changed = true;
      }
      if (nextState.cooldownUntil && nextState.cooldownUntil <= now) {
        nextState = {
          ...nextState,
          cooldownUntil: null
        };
        changed = true;
      }
      return [threadKey, nextState];
    })
  );

  if (!changed) {
    return dedupeState;
  }

  return {
    ...dedupeState,
    conversationThreads: nextThreads
  };
}

export function hasActiveConversationLease(
  dedupeState: Record<string, unknown> = {},
  threadOrDetection: string | WatchDetection | Record<string, unknown> | null | undefined,
  now = Date.now()
): boolean {
  const state = getConversationThreadState(dedupeState, threadOrDetection);
  return Boolean(state?.replyLeaseExpiresAt && state.replyLeaseExpiresAt > now);
}

export function isConversationThreadEscalated(
  dedupeState: Record<string, unknown> = {},
  threadOrDetection: string | WatchDetection | Record<string, unknown> | null | undefined,
  now = Date.now()
): boolean {
  const state = getConversationThreadState(dedupeState, threadOrDetection);
  if (!state?.escalatedAt) {
    return false;
  }

  return !state.replyLeaseExpiresAt || state.replyLeaseExpiresAt <= now;
}

export function isConversationThreadCooldownActive(
  dedupeState: Record<string, unknown> = {},
  threadOrDetection: string | WatchDetection | Record<string, unknown> | null | undefined,
  now = Date.now()
): boolean {
  const state = getConversationThreadState(dedupeState, threadOrDetection);
  return Boolean(state?.cooldownUntil && state.cooldownUntil > now);
}

export function findConversationThreadByTaskId(
  dedupeState: Record<string, unknown> = {},
  taskId: string | null | undefined
): ConversationThreadState | null {
  const normalizedTaskId = stringValue(taskId);
  if (!normalizedTaskId) {
    return null;
  }

  return Object.values(readConversationThreads(dedupeState)).find((state) => state.lastAgentTaskId === normalizedTaskId) ?? null;
}

export function recordConversationObservation(
  dedupeState: Record<string, unknown> = {},
  detection: WatchDetection | Record<string, unknown> | null | undefined,
  {
    activate = false,
    updatedAt = new Date().toISOString()
  }: {
    activate?: boolean;
    updatedAt?: string;
  } = {}
): Record<string, unknown> {
  const typedDetection = (detection ?? null) as WatchDetection | null;
  const threadKey = deriveConversationThreadKey(typedDetection);
  if (!typedDetection || !threadKey) {
    return dedupeState;
  }

  const current = getConversationThreadState(dedupeState, threadKey) ?? sanitizeThreadState({}, threadKey);
  const messageId = stringValue(typedDetection.metadata?.messageId);
  const sender = stringValue(typedDetection.metadata?.sender);
  const direction = directionValue(typedDetection.metadata?.direction);
  const receivedAt = stringValue(typedDetection.metadata?.receivedAt) ?? updatedAt;

  return putThreadState(
    dedupeState,
    {
      ...current,
      threadKey,
      lastMessageId: messageId ?? current.lastMessageId,
      lastInboundMessageId:
        direction === "outbound" ? current.lastInboundMessageId : (messageId ?? current.lastInboundMessageId),
      lastInboundReceivedAt:
        direction === "outbound" ? current.lastInboundReceivedAt : (receivedAt ?? current.lastInboundReceivedAt),
      lastSender: sender ?? current.lastSender,
      lastDirection: direction,
      updatedAt
    },
    { active: activate }
  );
}

export function recordConversationTaskDispatch(
  dedupeState: Record<string, unknown> = {},
  detection: WatchDetection | Record<string, unknown> | null | undefined,
  {
    taskId,
    dispatchedAt = new Date().toISOString()
  }: {
    taskId: string;
    dispatchedAt?: string;
  }
): Record<string, unknown> {
  const threadKey = deriveConversationThreadKey(detection);
  if (!threadKey) {
    return dedupeState;
  }

  const observed = recordConversationObservation(dedupeState, detection, {
    activate: true,
    updatedAt: dispatchedAt
  });
  const current = getConversationThreadState(observed, threadKey) ?? sanitizeThreadState({}, threadKey);
  return putThreadState(
    {
      ...observed,
      activeConversationThreadKey: threadKey
    },
    {
      ...current,
      lastAgentActionAt: dispatchedAt,
      lastAgentTaskId: taskId,
      updatedAt: dispatchedAt
    },
    { active: true }
  );
}

export function recordConversationApproval(
  dedupeState: Record<string, unknown> = {},
  {
    threadKey,
    expiresAt = null,
    approvedAt = new Date().toISOString(),
    taskId = null
  }: {
    threadKey: string;
    expiresAt?: number | null;
    approvedAt?: string;
    taskId?: string | null;
  }
): Record<string, unknown> {
  const normalizedKey = normalizeConversationThreadKey(threadKey);
  if (!normalizedKey) {
    return dedupeState;
  }

  const current = getConversationThreadState(dedupeState, normalizedKey) ?? sanitizeThreadState({}, normalizedKey);
  return putThreadState(
    {
      ...dedupeState,
      replyApprovalThreadKey: normalizedKey,
      replyApprovalExpiresAt: numericValue(expiresAt)
    },
    {
      ...current,
      replyLeaseExpiresAt: numericValue(expiresAt),
      failureCount: 0,
      cooldownUntil: null,
      escalatedAt: null,
      lastAgentActionAt: approvedAt,
      lastAgentTaskId: stringValue(taskId),
      updatedAt: approvedAt
    },
    { active: true }
  );
}

export function recordConversationTaskCompletion(
  dedupeState: Record<string, unknown> = {},
  {
    threadKey,
    completedAt = new Date().toISOString()
  }: {
    threadKey: string;
    completedAt?: string;
  }
): Record<string, unknown> {
  const normalizedKey = normalizeConversationThreadKey(threadKey);
  if (!normalizedKey) {
    return dedupeState;
  }

  const current = getConversationThreadState(dedupeState, normalizedKey);
  if (!current) {
    return {
      ...dedupeState,
      activeConversationThreadKey: null
    };
  }

  return putThreadState(
    {
      ...dedupeState,
      activeConversationThreadKey: null
    },
    {
      ...current,
      updatedAt: completedAt
    }
  );
}

export function recordConversationFailure(
  dedupeState: Record<string, unknown> = {},
  {
    threadKey,
    failedAt = new Date().toISOString(),
    cooldownUntil = null
  }: {
    threadKey: string;
    failedAt?: string;
    cooldownUntil?: number | null;
  }
): Record<string, unknown> {
  const normalizedKey = normalizeConversationThreadKey(threadKey);
  if (!normalizedKey) {
    return dedupeState;
  }

  const current = getConversationThreadState(dedupeState, normalizedKey) ?? sanitizeThreadState({}, normalizedKey);
  const next = putThreadState(
    {
      ...dedupeState,
      activeConversationThreadKey: null,
      ...(normalizeConversationThreadKey(dedupeState.replyApprovalThreadKey) === normalizedKey
        ? {
            replyApprovalThreadKey: null,
            replyApprovalExpiresAt: null
          }
        : {})
    },
    {
      ...current,
      replyLeaseExpiresAt: null,
      failureCount: current.failureCount + 1,
      cooldownUntil: numericValue(cooldownUntil),
      escalatedAt: current.escalatedAt ?? failedAt,
      updatedAt: failedAt
    }
  );

  return next;
}

export function clearConversationState(dedupeState: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...dedupeState,
    conversationThreads: {},
    currentConversationThreadKey: null,
    activeConversationThreadKey: null,
    replyApprovalThreadKey: null,
    replyApprovalExpiresAt: null
  };
}
