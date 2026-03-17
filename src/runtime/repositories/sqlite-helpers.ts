import { createId, nowIso } from "../id.js";
import type {
  ArtifactReference,
  DraftRecord,
  SkillDefinition,
  TaskRecord,
  TaskSpec,
  TraceRecord,
  WatchRule,
  WorkspaceProfile,
  WorkspaceRecord
} from "../../types/runtime-schema.js";

export { createId, nowIso };

type SqliteRow = Record<string, unknown>;

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  return Boolean(value);
}

function asEnum<TValue extends string>(value: unknown, allowed: readonly TValue[], fallback: TValue): TValue {
  return typeof value === "string" && allowed.includes(value as TValue) ? (value as TValue) : fallback;
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function hydrateTask(row: SqliteRow | null): TaskRecord | null {
  if (!row) {
    return null;
  }

  return {
    id: asString(row.id),
    goal: asString(row.goal),
    status: asEnum(row.status, ["queued", "planning", "running", "verifying", "paused", "takeover", "blocked", "failed", "completed", "interrupted"] as const, "queued"),
    priority: asEnum(row.priority, ["low", "normal", "high"] as const, "normal"),
    triggerSource: asString(row.trigger_source),
    deadline: asNullableString(row.deadline),
    preferredSurface: asEnum(row.preferred_surface, ["auto", "browser", "desktop"] as const, "auto"),
    workspaceId: asNullableString(row.workspace_id),
    traceId: asNullableString(row.trace_id),
    error: asNullableString(row.error),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    taskSpec: parseJson<TaskSpec | Record<string, unknown>>(row.task_spec as string | null | undefined, { goal: asString(row.goal) }),
    plan: parseJson(row.plan as string | null | undefined, []),
    result: parseJson(row.result as string | null | undefined, null)
  };
}

export function hydrateTrace(row: SqliteRow | null): TraceRecord | null {
  if (!row) {
    return null;
  }

  return {
    id: asString(row.id),
    taskId: asString(row.task_id),
    status: asString(row.status),
    startedAt: asString(row.started_at),
    endedAt: asNullableString(row.ended_at),
    summary: asNullableString(row.summary),
    plan: parseJson(row.plan as string | null | undefined, []),
    output: parseJson(row.output as string | null | undefined, null)
  };
}

export function hydrateWorkspace(row: SqliteRow | null): WorkspaceRecord | null {
  if (!row) {
    return null;
  }

  return {
    id: asString(row.id),
    taskId: asString(row.task_id),
    rootPath: asString(row.root_path),
    profilePath: asString(row.profile_path),
    downloadsPath: asString(row.downloads_path),
    artifactsPath: asString(row.artifacts_path),
    scratchPath: asString(row.scratch_path),
    createdAt: asString(row.created_at)
  };
}

export function hydrateArtifact(row: SqliteRow | null): ArtifactReference | null {
  if (!row) {
    return null;
  }

  return {
    id: asString(row.id),
    taskId: asString(row.task_id),
    traceId: asNullableString(row.trace_id),
    kind: asString(row.kind),
    label: asString(row.label),
    path: asString(row.path),
    metadata: parseJson(row.metadata as string | null | undefined, {}),
    createdAt: asString(row.created_at)
  };
}

export function hydrateWatchRule(row: SqliteRow | null): WatchRule | null {
  if (!row) {
    return null;
  }

  return {
    id: asString(row.id),
    goal: asString(row.goal),
    enabled: asBoolean(row.enabled),
    status: asString(row.status),
    preferredSurface: asEnum(row.preferred_surface, ["browser", "desktop"] as const, "desktop"),
    workspaceName: asNullableString(row.workspace_name),
    skillName: asNullableString(row.skill_name),
    appTarget: asNullableString(row.app_target),
    livePack: asString(row.live_pack),
    pollIntervalMs: asNumber(row.poll_interval_ms, 30000),
    watchProfile: parseJson(row.watch_profile as string | null | undefined, {}),
    taskInputs: parseJson(row.task_inputs as string | null | undefined, {}),
    dedupeState: parseJson(row.dedupe_state as string | null | undefined, {}),
    lastObservedAt: asNullableString(row.last_observed_at),
    lastTriggeredAt: asNullableString(row.last_triggered_at),
    lastError: asNullableString(row.last_error),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at)
  };
}

export function hydrateDraft(row: SqliteRow | null): DraftRecord | null {
  if (!row) {
    return null;
  }

  return {
    id: asString(row.id),
    watchRuleId: asString(row.watch_rule_id),
    livePack: asString(row.live_pack),
    status: asEnum(row.status, ["pending", "approved", "rejected", "expired"] as const, "pending"),
    summary: asString(row.summary),
    replyText: asString(row.reply_text),
    fingerprint: asString(row.fingerprint),
    taskSpec: parseJson(row.task_spec as string | null | undefined, { goal: "" }),
    detection: parseJson(row.detection as string | null | undefined, {}),
    riskDecision: parseJson(row.risk_decision as string | null | undefined, {
      policy: "draft_only",
      riskLevel: "normal",
      reasons: [],
      action: "draft"
    }),
    metadata: parseJson(row.metadata as string | null | undefined, {}),
    taskId: asNullableString(row.task_id),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    approvedAt: asNullableString(row.approved_at),
    rejectedAt: asNullableString(row.rejected_at)
  };
}

export function hydrateWorkspaceProfile(row: SqliteRow | null): WorkspaceProfile | null {
  if (!row) {
    return null;
  }

  return {
    id: asString(row.id),
    name: asString(row.name),
    rootPath: asString(row.root_path),
    profilePath: asString(row.profile_path),
    downloadsPath: asString(row.downloads_path),
    artifactsPath: asString(row.artifacts_path),
    scratchPath: asString(row.scratch_path),
    metadata: parseJson(row.metadata as string | null | undefined, {}),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at)
  };
}

export function hydrateSkill(row: SqliteRow | null): SkillDefinition | null {
  if (!row) {
    return null;
  }

  return {
    id: asString(row.id),
    name: asString(row.name),
    surfaceScope: asEnum(row.surface_scope, ["browser", "desktop", "any"] as const, "any"),
    triggerTerms: parseJson(row.trigger_terms as string | null | undefined, []),
    anchors: parseJson(row.anchors as string | null | undefined, []),
    actionTemplate: parseJson(row.action_template as string | null | undefined, []),
    successCriteria: parseJson(row.success_criteria as string | null | undefined, []),
    recoveryHints: parseJson(row.recovery_hints as string | null | undefined, []),
    metadata: parseJson(row.metadata as string | null | undefined, {}),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at)
  };
}

export function hydrateVaultEntry(
  row: SqliteRow | null,
  { includeCiphertext = true }: { includeCiphertext?: boolean } = {}
) {
  if (!row) {
    return null;
  }

  return {
    id: asString(row.id),
    scope: asString(row.scope),
    secretKey: asString(row.secret_key),
    ...(includeCiphertext
      ? {
          ciphertext: asString(row.ciphertext),
          iv: asString(row.iv),
          tag: asString(row.tag)
        }
      : {}),
    metadata: parseJson(row.metadata as string | null | undefined, {}),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at)
  };
}
