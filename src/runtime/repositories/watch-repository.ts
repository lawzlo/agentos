import {
  createId,
  hydrateWatchRule,
  nowIso
} from "./sqlite-helpers.js";

export class WatchRepository {
  db: any;

  constructor(db: any) {
    this.db = db;
  }

  put(watchRule: Record<string, any>) {
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

    return this.get(row.id);
  }

  get(id: string) {
    return hydrateWatchRule(this.db.prepare("SELECT * FROM watch_rules WHERE id = ?").get(id));
  }

  list() {
    return this.db
      .prepare(`
        SELECT * FROM watch_rules
        ORDER BY datetime(created_at) DESC
      `)
      .all()
      .map(hydrateWatchRule);
  }

  delete(id: string) {
    const existing = this.get(id);
    if (!existing) {
      return false;
    }
    this.db.prepare("DELETE FROM watch_rules WHERE id = ?").run(id);
    return true;
  }
}
