import {
  createId,
  hydrateSkill,
  nowIso
} from "./sqlite-helpers.js";

export class SkillRepository {
  db: any;

  constructor(db: any) {
    this.db = db;
  }

  put(skill: Record<string, any>) {
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

    return this.get(row.name);
  }

  get(name: string) {
    return hydrateSkill(this.db.prepare("SELECT * FROM skills WHERE name = ?").get(name));
  }

  list() {
    return this.db
      .prepare(`
        SELECT * FROM skills
        ORDER BY name ASC
      `)
      .all()
      .map(hydrateSkill);
  }
}
