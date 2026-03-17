import { createId, nowIso } from "../id.js";

export { createId, nowIso };

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

export function hydrateTask(row: Record<string, any> | null) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    goal: row.goal,
    status: row.status,
    priority: row.priority,
    triggerSource: row.trigger_source,
    deadline: row.deadline,
    preferredSurface: row.preferred_surface,
    workspaceId: row.workspace_id,
    traceId: row.trace_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    taskSpec: parseJson(row.task_spec, {}),
    plan: parseJson(row.plan, []),
    result: parseJson(row.result, null)
  };
}

export function hydrateTrace(row: Record<string, any> | null) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    taskId: row.task_id,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    summary: row.summary,
    plan: parseJson(row.plan, []),
    output: parseJson(row.output, null)
  };
}

export function hydrateWorkspace(row: Record<string, any> | null) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    taskId: row.task_id,
    rootPath: row.root_path,
    profilePath: row.profile_path,
    downloadsPath: row.downloads_path,
    artifactsPath: row.artifacts_path,
    scratchPath: row.scratch_path,
    createdAt: row.created_at
  };
}

export function hydrateArtifact(row: Record<string, any> | null) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    taskId: row.task_id,
    traceId: row.trace_id,
    kind: row.kind,
    label: row.label,
    path: row.path,
    metadata: parseJson(row.metadata, {}),
    createdAt: row.created_at
  };
}

export function hydrateWatchRule(row: Record<string, any> | null) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    goal: row.goal,
    enabled: Boolean(row.enabled),
    status: row.status,
    preferredSurface: row.preferred_surface,
    workspaceName: row.workspace_name,
    skillName: row.skill_name,
    appTarget: row.app_target,
    livePack: row.live_pack,
    pollIntervalMs: row.poll_interval_ms,
    watchProfile: parseJson(row.watch_profile, {}),
    taskInputs: parseJson(row.task_inputs, {}),
    dedupeState: parseJson(row.dedupe_state, {}),
    lastObservedAt: row.last_observed_at,
    lastTriggeredAt: row.last_triggered_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function hydrateDraft(row: Record<string, any> | null) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    watchRuleId: row.watch_rule_id,
    livePack: row.live_pack,
    status: row.status,
    summary: row.summary,
    replyText: row.reply_text,
    fingerprint: row.fingerprint,
    taskSpec: parseJson(row.task_spec, {}),
    detection: parseJson(row.detection, {}),
    riskDecision: parseJson(row.risk_decision, {
      policy: "draft_only",
      riskLevel: "normal",
      reasons: [],
      action: "draft"
    }),
    metadata: parseJson(row.metadata, {}),
    taskId: row.task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at,
    rejectedAt: row.rejected_at
  };
}

export function hydrateWorkspaceProfile(row: Record<string, any> | null) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    profilePath: row.profile_path,
    downloadsPath: row.downloads_path,
    artifactsPath: row.artifacts_path,
    scratchPath: row.scratch_path,
    metadata: parseJson(row.metadata, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function hydrateSkill(row: Record<string, any> | null) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    surfaceScope: row.surface_scope,
    triggerTerms: parseJson(row.trigger_terms, []),
    anchors: parseJson(row.anchors, []),
    actionTemplate: parseJson(row.action_template, []),
    successCriteria: parseJson(row.success_criteria, []),
    recoveryHints: parseJson(row.recovery_hints, []),
    metadata: parseJson(row.metadata, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function hydrateVaultEntry(row: Record<string, any> | null, { includeCiphertext = true } = {}) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    scope: row.scope,
    secretKey: row.secret_key,
    ...(includeCiphertext
      ? {
          ciphertext: row.ciphertext,
          iv: row.iv,
          tag: row.tag
        }
      : {}),
    metadata: parseJson(row.metadata, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
