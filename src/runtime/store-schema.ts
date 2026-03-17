import { STORE_SCHEMA_VERSION } from "../version.js";

export function getStoreSchemaVersion(db: any): number {
  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version?: number }
    | number
    | undefined;
  if (typeof row === "number") {
    return Number(row);
  }
  return Number(row?.user_version ?? 0);
}

export function initializeStoreSchema(db: any): void {
  const currentVersion = getStoreSchemaVersion(db);
  if (currentVersion > STORE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported AgentOS store schema version ${currentVersion}. This runtime supports up to ${STORE_SCHEMA_VERSION}.`
    );
  }

  db.exec(`
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
    CREATE TABLE IF NOT EXISTS learning_sources (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      config TEXT NOT NULL,
      state TEXT NOT NULL,
      last_observed_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      category TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      summary TEXT,
      metadata TEXT NOT NULL,
      extracted_text TEXT,
      artifact_refs TEXT NOT NULL,
      entity_refs TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source_id, fingerprint)
    );
    CREATE TABLE IF NOT EXISTS memory_entities (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      metadata TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(entity_type, entity_key)
    );
    CREATE TABLE IF NOT EXISTS memory_facts (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      source_observation_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      observation_id TEXT,
      entity_id TEXT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
      chunk_id UNINDEXED,
      title,
      content
    );
    CREATE TABLE IF NOT EXISTS digests (
      id TEXT PRIMARY KEY,
      digest_date TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      metadata TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      proposal_type TEXT NOT NULL,
      status TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      source_entity_ids TEXT NOT NULL,
      rationale TEXT NOT NULL,
      confidence REAL NOT NULL,
      task_spec TEXT NOT NULL,
      metadata TEXT NOT NULL,
      task_id TEXT,
      acted_at TEXT,
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
    CREATE INDEX IF NOT EXISTS idx_observations_source_id ON observations(source_id);
    CREATE INDEX IF NOT EXISTS idx_observations_created_at ON observations(created_at);
    CREATE INDEX IF NOT EXISTS idx_memory_entities_type_key ON memory_entities(entity_type, entity_key);
    CREATE INDEX IF NOT EXISTS idx_memory_facts_entity_id ON memory_facts(entity_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_source_id ON knowledge_chunks(source_id);
    CREATE INDEX IF NOT EXISTS idx_digests_date ON digests(digest_date);
    CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
    PRAGMA user_version = ${STORE_SCHEMA_VERSION};
  `);
}
