import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createId, nowIso } from "./id.js";

function parseJson(value, fallback = null) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function hydrateTask(row) {
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

function hydrateTrace(row) {
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

function hydrateWorkspace(row) {
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

function hydrateArtifact(row) {
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

function hydrateWatchRule(row) {
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

function hydrateDraft(row) {
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

export class ControlPlaneStore {
  db: any;
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.#initialize();
  }

  #initialize() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        trigger_source TEXT,
        deadline TEXT,
        preferred_surface TEXT,
        workspace_id TEXT,
        trace_id TEXT,
        task_spec TEXT NOT NULL,
        plan TEXT,
        result TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        payload TEXT NOT NULL,
        task_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS traces (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        summary TEXT,
        plan TEXT,
        output TEXT
      );
      CREATE TABLE IF NOT EXISTS trace_events (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        role TEXT NOT NULL,
        type TEXT NOT NULL,
        step_id TEXT,
        message TEXT NOT NULL,
        payload TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        root_path TEXT NOT NULL,
        profile_path TEXT NOT NULL,
        downloads_path TEXT NOT NULL,
        artifacts_path TEXT NOT NULL,
        scratch_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        trace_id TEXT,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        path TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        memory_key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(namespace, memory_key)
      );
      CREATE TABLE IF NOT EXISTS policies (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        name TEXT NOT NULL,
        rule TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vault_entries (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        secret_key TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        tag TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(scope, secret_key)
      );
      CREATE TABLE IF NOT EXISTS workspace_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        root_path TEXT NOT NULL,
        profile_path TEXT NOT NULL,
        downloads_path TEXT NOT NULL,
        artifacts_path TEXT NOT NULL,
        scratch_path TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        surface_scope TEXT NOT NULL,
        trigger_terms TEXT NOT NULL,
        anchors TEXT NOT NULL,
        action_template TEXT NOT NULL,
        success_criteria TEXT NOT NULL,
        recovery_hints TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS watch_rules (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        preferred_surface TEXT NOT NULL,
        workspace_name TEXT,
        skill_name TEXT,
        app_target TEXT,
        live_pack TEXT NOT NULL,
        poll_interval_ms INTEGER NOT NULL,
        watch_profile TEXT NOT NULL,
        task_inputs TEXT NOT NULL,
        dedupe_state TEXT NOT NULL,
        last_observed_at TEXT,
        last_triggered_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY,
        watch_rule_id TEXT,
        live_pack TEXT,
        status TEXT NOT NULL,
        summary TEXT,
        reply_text TEXT,
        fingerprint TEXT,
        task_spec TEXT NOT NULL,
        detection TEXT NOT NULL,
        risk_decision TEXT NOT NULL,
        metadata TEXT NOT NULL,
        task_id TEXT,
        approved_at TEXT,
        rejected_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
      CREATE INDEX IF NOT EXISTS idx_trace_events_trace_id ON trace_events(trace_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_task_id ON artifacts(task_id);
      CREATE INDEX IF NOT EXISTS idx_vault_scope ON vault_entries(scope);
      CREATE INDEX IF NOT EXISTS idx_workspace_profiles_name ON workspace_profiles(name);
      CREATE INDEX IF NOT EXISTS idx_skills_surface ON skills(surface_scope);
      CREATE INDEX IF NOT EXISTS idx_watch_rules_enabled ON watch_rules(enabled);
      CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
    `);
  }

  createTask(taskSpec) {
    const id = taskSpec.id ?? createId("task");
    const createdAt = nowIso();
    const record = {
      id,
      goal: taskSpec.goal,
      status: "queued",
      priority: taskSpec.priority ?? "normal",
      triggerSource: taskSpec.triggerSource ?? "manual",
      deadline: taskSpec.deadline ?? null,
      preferredSurface: taskSpec.preferredSurface ?? "auto",
      workspaceId: taskSpec.workspaceId ?? null,
      traceId: null,
      taskSpec,
      plan: [],
      result: null,
      error: null,
      createdAt,
      updatedAt: createdAt
    };

    this.db.prepare(`
      INSERT INTO tasks (
        id, goal, status, priority, trigger_source, deadline, preferred_surface, workspace_id, trace_id,
        task_spec, plan, result, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.goal,
      record.status,
      record.priority,
      record.triggerSource,
      record.deadline,
      record.preferredSurface,
      record.workspaceId,
      record.traceId,
      JSON.stringify(record.taskSpec),
      JSON.stringify(record.plan),
      JSON.stringify(record.result),
      record.error,
      record.createdAt,
      record.updatedAt
    );

    return this.getTask(record.id);
  }

  updateTask(id, patch) {
    const current = this.getTask(id);
    if (!current) {
      return null;
    }

    const merged = {
      ...current,
      ...patch,
      taskSpec: patch.taskSpec ?? current.taskSpec,
      plan: patch.plan ?? current.plan,
      result: patch.result ?? current.result,
      updatedAt: nowIso()
    };

    this.db.prepare(`
      UPDATE tasks
      SET goal = ?, status = ?, priority = ?, trigger_source = ?, deadline = ?, preferred_surface = ?,
          workspace_id = ?, trace_id = ?, task_spec = ?, plan = ?, result = ?, error = ?, updated_at = ?
      WHERE id = ?
    `).run(
      merged.goal,
      merged.status,
      merged.priority,
      merged.triggerSource,
      merged.deadline,
      merged.preferredSurface,
      merged.workspaceId,
      merged.traceId ?? null,
      JSON.stringify(merged.taskSpec),
      JSON.stringify(merged.plan),
      JSON.stringify(merged.result),
      merged.error ?? null,
      merged.updatedAt,
      id
    );

    return this.getTask(id);
  }

  listTasks(limit = 50) {
    return this.db
      .prepare(`
        SELECT * FROM tasks
        ORDER BY datetime(created_at) DESC
        LIMIT ?
      `)
      .all(limit)
      .map(hydrateTask);
  }

  getTask(id) {
    return hydrateTask(this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id));
  }

  listTasksByStatuses(statuses = []) {
    if (!statuses.length) {
      return [];
    }

    const placeholders = statuses.map(() => "?").join(", ");
    return this.db
      .prepare(`
        SELECT * FROM tasks
        WHERE status IN (${placeholders})
        ORDER BY datetime(created_at) ASC
      `)
      .all(...statuses)
      .map(hydrateTask);
  }

  createEvent(event) {
    const row = {
      id: event.id ?? createId("evt"),
      type: event.type ?? "manual",
      source: event.source ?? "manual",
      payload: event.payload ?? {},
      taskId: event.taskId ?? null,
      createdAt: nowIso()
    };

    this.db.prepare(`
      INSERT INTO events (id, type, source, payload, task_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(row.id, row.type, row.source, JSON.stringify(row.payload), row.taskId, row.createdAt);

    return row;
  }

  attachEventTask(eventId, taskId) {
    this.db.prepare("UPDATE events SET task_id = ? WHERE id = ?").run(taskId, eventId);
    return this.db.prepare("SELECT * FROM events WHERE id = ?").get(eventId);
  }

  listEvents(limit = 50) {
    return this.db
      .prepare(`
        SELECT * FROM events
        ORDER BY datetime(created_at) DESC
        LIMIT ?
      `)
      .all(limit)
      .map((row) => ({
        id: row.id,
        type: row.type,
        source: row.source,
        taskId: row.task_id,
        payload: parseJson(row.payload, {}),
        createdAt: row.created_at
      }));
  }

  createTrace({ taskId, status = "running", plan = [] }) {
    const row = {
      id: createId("trace"),
      taskId,
      status,
      startedAt: nowIso(),
      endedAt: null,
      summary: null,
      plan,
      output: null
    };

    this.db.prepare(`
      INSERT INTO traces (id, task_id, status, started_at, ended_at, summary, plan, output)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.taskId,
      row.status,
      row.startedAt,
      row.endedAt,
      row.summary,
      JSON.stringify(row.plan),
      JSON.stringify(row.output)
    );

    return this.getTrace(row.id);
  }

  updateTrace(id, patch) {
    const current = this.getTrace(id);
    if (!current) {
      return null;
    }

    const merged = {
      ...current,
      ...patch,
      plan: patch.plan ?? current.plan,
      output: patch.output ?? current.output
    };

    this.db.prepare(`
      UPDATE traces
      SET status = ?, ended_at = ?, summary = ?, plan = ?, output = ?
      WHERE id = ?
    `).run(
      merged.status,
      merged.endedAt ?? null,
      merged.summary ?? null,
      JSON.stringify(merged.plan),
      JSON.stringify(merged.output),
      id
    );

    return this.getTrace(id);
  }

  getTrace(id) {
    return hydrateTrace(this.db.prepare("SELECT * FROM traces WHERE id = ?").get(id));
  }

  appendTraceEvent(event) {
    const row = {
      id: event.id ?? createId("tevt"),
      traceId: event.traceId,
      taskId: event.taskId,
      role: event.role,
      type: event.type,
      stepId: event.stepId ?? null,
      message: event.message,
      payload: event.payload ?? {},
      createdAt: nowIso()
    };

    this.db.prepare(`
      INSERT INTO trace_events (id, trace_id, task_id, role, type, step_id, message, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.traceId,
      row.taskId,
      row.role,
      row.type,
      row.stepId,
      row.message,
      JSON.stringify(row.payload),
      row.createdAt
    );

    return row;
  }

  listTraceEvents(traceId) {
    return this.db
      .prepare(`
        SELECT * FROM trace_events
        WHERE trace_id = ?
        ORDER BY datetime(created_at) ASC
      `)
      .all(traceId)
      .map((row) => ({
        id: row.id,
        traceId: row.trace_id,
        taskId: row.task_id,
        role: row.role,
        type: row.type,
        stepId: row.step_id,
        message: row.message,
        payload: parseJson(row.payload, {}),
        createdAt: row.created_at
      }));
  }

  createWorkspace(workspace) {
    this.db.prepare(`
      INSERT INTO workspaces (id, task_id, root_path, profile_path, downloads_path, artifacts_path, scratch_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      workspace.id,
      workspace.taskId,
      workspace.rootPath,
      workspace.profilePath,
      workspace.downloadsPath,
      workspace.artifactsPath,
      workspace.scratchPath,
      workspace.createdAt
    );

    return this.getWorkspace(workspace.id);
  }

  getWorkspace(id) {
    return hydrateWorkspace(this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id));
  }

  getWorkspaceByTask(taskId) {
    return hydrateWorkspace(this.db.prepare("SELECT * FROM workspaces WHERE task_id = ?").get(taskId));
  }

  putWorkspaceProfile(profile) {
    const row = {
      id: profile.id ?? createId("wsp"),
      name: profile.name,
      rootPath: profile.rootPath,
      profilePath: profile.profilePath,
      downloadsPath: profile.downloadsPath,
      artifactsPath: profile.artifactsPath,
      scratchPath: profile.scratchPath,
      metadata: profile.metadata ?? {},
      createdAt: profile.createdAt ?? nowIso(),
      updatedAt: nowIso()
    };

    this.db.prepare(`
      INSERT INTO workspace_profiles (
        id, name, root_path, profile_path, downloads_path, artifacts_path, scratch_path, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name)
      DO UPDATE SET
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `).run(
      row.id,
      row.name,
      row.rootPath,
      row.profilePath,
      row.downloadsPath,
      row.artifactsPath,
      row.scratchPath,
      JSON.stringify(row.metadata),
      row.createdAt,
      row.updatedAt
    );

    return this.getWorkspaceProfileByName(row.name);
  }

  getWorkspaceProfileByName(name) {
    const row = this.db.prepare("SELECT * FROM workspace_profiles WHERE name = ?").get(name);
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

  listWorkspaceProfiles() {
    return this.db
      .prepare(`
        SELECT * FROM workspace_profiles
        ORDER BY name ASC
      `)
      .all()
      .map((row) => ({
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
      }));
  }

  createArtifact(artifact) {
    const row = {
      id: artifact.id ?? createId("artifact"),
      taskId: artifact.taskId,
      traceId: artifact.traceId ?? null,
      kind: artifact.kind,
      label: artifact.label,
      path: artifact.path,
      metadata: artifact.metadata ?? {},
      createdAt: artifact.createdAt ?? nowIso()
    };

    this.db.prepare(`
      INSERT INTO artifacts (id, task_id, trace_id, kind, label, path, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.taskId,
      row.traceId,
      row.kind,
      row.label,
      row.path,
      JSON.stringify(row.metadata),
      row.createdAt
    );

    return hydrateArtifact(
      this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(row.id)
    );
  }

  listArtifactsForTask(taskId) {
    return this.db
      .prepare(`
        SELECT * FROM artifacts
        WHERE task_id = ?
        ORDER BY datetime(created_at) ASC
      `)
      .all(taskId)
      .map(hydrateArtifact);
  }

  putMemory(namespace, key, value) {
    const row = {
      id: createId("mem"),
      namespace,
      key,
      value,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };

    this.db.prepare(`
      INSERT INTO memory_entries (id, namespace, memory_key, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(namespace, memory_key)
      DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(row.id, row.namespace, row.key, JSON.stringify(row.value), row.createdAt, row.updatedAt);

    return this.getMemory(namespace, key);
  }

  getMemory(namespace, key) {
    const row = this.db
      .prepare("SELECT * FROM memory_entries WHERE namespace = ? AND memory_key = ?")
      .get(namespace, key);

    if (!row) {
      return null;
    }

    return {
      namespace: row.namespace,
      key: row.memory_key,
      value: parseJson(row.value, null),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  listPolicies() {
    return this.db
      .prepare("SELECT * FROM policies ORDER BY datetime(created_at) DESC")
      .all()
      .map((row) => ({
        id: row.id,
        scope: row.scope,
        name: row.name,
        rule: parseJson(row.rule, {}),
        createdAt: row.created_at
      }));
  }

  putSkill(skill) {
    const row = {
      id: createId("skill"),
      name: skill.name,
      surfaceScope: skill.surfaceScope ?? "any",
      triggerTerms: skill.triggerTerms ?? [],
      anchors: skill.anchors ?? [],
      actionTemplate: skill.actionTemplate ?? [],
      successCriteria: skill.successCriteria ?? [],
      recoveryHints: skill.recoveryHints ?? [],
      metadata: skill.metadata ?? {},
      createdAt: nowIso(),
      updatedAt: nowIso()
    };

    this.db.prepare(`
      INSERT INTO skills (
        id, name, surface_scope, trigger_terms, anchors, action_template, success_criteria, recovery_hints, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name)
      DO UPDATE SET
        surface_scope = excluded.surface_scope,
        trigger_terms = excluded.trigger_terms,
        anchors = excluded.anchors,
        action_template = excluded.action_template,
        success_criteria = excluded.success_criteria,
        recovery_hints = excluded.recovery_hints,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `).run(
      row.id,
      row.name,
      row.surfaceScope,
      JSON.stringify(row.triggerTerms),
      JSON.stringify(row.anchors),
      JSON.stringify(row.actionTemplate),
      JSON.stringify(row.successCriteria),
      JSON.stringify(row.recoveryHints),
      JSON.stringify(row.metadata),
      row.createdAt,
      row.updatedAt
    );

    return this.getSkill(row.name);
  }

  getSkill(name) {
    const row = this.db.prepare("SELECT * FROM skills WHERE name = ?").get(name);
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

  listSkills() {
    return this.db
      .prepare(`
        SELECT * FROM skills
        ORDER BY name ASC
      `)
      .all()
      .map((row) => ({
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
      }));
  }

  putWatchRule(watchRule) {
    const row = {
      id: watchRule.id ?? createId("watch"),
      goal: watchRule.goal,
      enabled: watchRule.enabled === false ? 0 : 1,
      status: watchRule.status ?? "active",
      preferredSurface: watchRule.preferredSurface ?? "desktop",
      workspaceName: watchRule.workspaceName ?? null,
      skillName: watchRule.skillName ?? null,
      appTarget: watchRule.appTarget ?? null,
      livePack: watchRule.livePack ?? "generic-desktop",
      pollIntervalMs: Number(watchRule.pollIntervalMs ?? 15000),
      watchProfile: watchRule.watchProfile ?? {},
      taskInputs: watchRule.taskInputs ?? {},
      dedupeState: watchRule.dedupeState ?? {},
      lastObservedAt: watchRule.lastObservedAt ?? null,
      lastTriggeredAt: watchRule.lastTriggeredAt ?? null,
      lastError: watchRule.lastError ?? null,
      createdAt: watchRule.createdAt ?? nowIso(),
      updatedAt: nowIso()
    };

    this.db.prepare(`
      INSERT INTO watch_rules (
        id, goal, enabled, status, preferred_surface, workspace_name, skill_name, app_target,
        live_pack, poll_interval_ms, watch_profile, task_inputs, dedupe_state, last_observed_at,
        last_triggered_at, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id)
      DO UPDATE SET
        goal = excluded.goal,
        enabled = excluded.enabled,
        status = excluded.status,
        preferred_surface = excluded.preferred_surface,
        workspace_name = excluded.workspace_name,
        skill_name = excluded.skill_name,
        app_target = excluded.app_target,
        live_pack = excluded.live_pack,
        poll_interval_ms = excluded.poll_interval_ms,
        watch_profile = excluded.watch_profile,
        task_inputs = excluded.task_inputs,
        dedupe_state = excluded.dedupe_state,
        last_observed_at = excluded.last_observed_at,
        last_triggered_at = excluded.last_triggered_at,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(
      row.id,
      row.goal,
      row.enabled,
      row.status,
      row.preferredSurface,
      row.workspaceName,
      row.skillName,
      row.appTarget,
      row.livePack,
      row.pollIntervalMs,
      JSON.stringify(row.watchProfile),
      JSON.stringify(row.taskInputs),
      JSON.stringify(row.dedupeState),
      row.lastObservedAt,
      row.lastTriggeredAt,
      row.lastError,
      row.createdAt,
      row.updatedAt
    );

    return this.getWatchRule(row.id);
  }

  getWatchRule(id) {
    return hydrateWatchRule(this.db.prepare("SELECT * FROM watch_rules WHERE id = ?").get(id));
  }

  listWatchRules() {
    return this.db
      .prepare(`
        SELECT * FROM watch_rules
        ORDER BY datetime(created_at) DESC
      `)
      .all()
      .map(hydrateWatchRule);
  }

  deleteWatchRule(id) {
    const existing = this.getWatchRule(id);
    if (!existing) {
      return false;
    }
    this.db.prepare("DELETE FROM watch_rules WHERE id = ?").run(id);
    return true;
  }

  createDraft(draft) {
    const row = {
      id: draft.id ?? createId("draft"),
      watchRuleId: draft.watchRuleId ?? null,
      livePack: draft.livePack ?? null,
      status: draft.status ?? "pending",
      summary: draft.summary ?? null,
      replyText: draft.replyText ?? null,
      fingerprint: draft.fingerprint ?? null,
      taskSpec: draft.taskSpec ?? {},
      detection: draft.detection ?? {},
      riskDecision: draft.riskDecision ?? {
        policy: "draft_only",
        riskLevel: "normal",
        reasons: [],
        action: "draft"
      },
      metadata: draft.metadata ?? {},
      taskId: draft.taskId ?? null,
      approvedAt: draft.approvedAt ?? null,
      rejectedAt: draft.rejectedAt ?? null,
      createdAt: draft.createdAt ?? nowIso(),
      updatedAt: nowIso()
    };

    this.db.prepare(`
      INSERT INTO drafts (
        id, watch_rule_id, live_pack, status, summary, reply_text, fingerprint, task_spec,
        detection, risk_decision, metadata, task_id, approved_at, rejected_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.watchRuleId,
      row.livePack,
      row.status,
      row.summary,
      row.replyText,
      row.fingerprint,
      JSON.stringify(row.taskSpec),
      JSON.stringify(row.detection),
      JSON.stringify(row.riskDecision),
      JSON.stringify(row.metadata),
      row.taskId,
      row.approvedAt,
      row.rejectedAt,
      row.createdAt,
      row.updatedAt
    );

    return this.getDraft(row.id);
  }

  updateDraft(id, patch) {
    const current = this.getDraft(id);
    if (!current) {
      return null;
    }

    const merged = {
      ...current,
      ...patch,
      taskSpec: patch.taskSpec ?? current.taskSpec,
      detection: patch.detection ?? current.detection,
      riskDecision: patch.riskDecision ?? current.riskDecision,
      metadata: patch.metadata ?? current.metadata,
      updatedAt: nowIso()
    };

    this.db.prepare(`
      UPDATE drafts
      SET watch_rule_id = ?, live_pack = ?, status = ?, summary = ?, reply_text = ?, fingerprint = ?,
          task_spec = ?, detection = ?, risk_decision = ?, metadata = ?, task_id = ?, approved_at = ?,
          rejected_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      merged.watchRuleId,
      merged.livePack,
      merged.status,
      merged.summary,
      merged.replyText,
      merged.fingerprint,
      JSON.stringify(merged.taskSpec),
      JSON.stringify(merged.detection),
      JSON.stringify(merged.riskDecision),
      JSON.stringify(merged.metadata),
      merged.taskId,
      merged.approvedAt,
      merged.rejectedAt,
      merged.updatedAt,
      id
    );

    return this.getDraft(id);
  }

  getDraft(id) {
    return hydrateDraft(this.db.prepare("SELECT * FROM drafts WHERE id = ?").get(id));
  }

  listDrafts(limit = 50) {
    return this.db
      .prepare(`
        SELECT * FROM drafts
        ORDER BY datetime(created_at) DESC
        LIMIT ?
      `)
      .all(limit)
      .map(hydrateDraft);
  }

  putVaultEntry(entry) {
    const row = {
      id: createId("vault"),
      scope: entry.scope,
      secretKey: entry.secretKey,
      ciphertext: entry.ciphertext,
      iv: entry.iv,
      tag: entry.tag,
      metadata: entry.metadata ?? {},
      createdAt: nowIso(),
      updatedAt: nowIso()
    };

    this.db.prepare(`
      INSERT INTO vault_entries (id, scope, secret_key, ciphertext, iv, tag, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, secret_key)
      DO UPDATE SET
        ciphertext = excluded.ciphertext,
        iv = excluded.iv,
        tag = excluded.tag,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `).run(
      row.id,
      row.scope,
      row.secretKey,
      row.ciphertext,
      row.iv,
      row.tag,
      JSON.stringify(row.metadata),
      row.createdAt,
      row.updatedAt
    );

    return this.getVaultEntry(row.scope, row.secretKey);
  }

  getVaultEntry(scope, secretKey) {
    const row = this.db
      .prepare("SELECT * FROM vault_entries WHERE scope = ? AND secret_key = ?")
      .get(scope, secretKey);

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      scope: row.scope,
      secretKey: row.secret_key,
      ciphertext: row.ciphertext,
      iv: row.iv,
      tag: row.tag,
      metadata: parseJson(row.metadata, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  listVaultEntries(scope = "default") {
    return this.db
      .prepare(`
        SELECT * FROM vault_entries
        WHERE scope = ?
        ORDER BY secret_key ASC
      `)
      .all(scope)
      .map((row) => ({
        id: row.id,
        scope: row.scope,
        secretKey: row.secret_key,
        metadata: parseJson(row.metadata, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
  }

  close() {
    this.db.close();
  }
}
