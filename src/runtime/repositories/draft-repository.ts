import {
  createId,
  hydrateDraft,
  nowIso
} from "./sqlite-helpers.js";

export class DraftRepository {
  db: any;

  constructor(db: any) {
    this.db = db;
  }

  create(draft: Record<string, any>) {
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

    return this.get(row.id);
  }

  update(id: string, patch: Record<string, any>) {
    const current = this.get(id);
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

    return this.get(id);
  }

  get(id: string) {
    return hydrateDraft(this.db.prepare("SELECT * FROM drafts WHERE id = ?").get(id));
  }

  list(limit = 50) {
    return this.db
      .prepare(`
        SELECT * FROM drafts
        ORDER BY datetime(created_at) DESC
        LIMIT ?
      `)
      .all(limit)
      .map(hydrateDraft);
  }
}
