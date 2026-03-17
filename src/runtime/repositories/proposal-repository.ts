import {
  createId,
  hydrateProposal,
  nowIso
} from "./sqlite-helpers.js";
import type { ProposalRecord } from "../../types/learning.js";

export class ProposalRepository {
  db: any;

  constructor(db: any) {
    this.db = db;
  }

  put(proposal: Partial<ProposalRecord> & Pick<ProposalRecord, "type" | "fingerprint" | "rationale" | "confidence" | "taskSpec">): ProposalRecord {
    const current = this.getByFingerprint(proposal.fingerprint);
    const row = {
      id: current?.id ?? proposal.id ?? createId("prop"),
      type: proposal.type,
      status: proposal.status ?? current?.status ?? "pending",
      fingerprint: proposal.fingerprint,
      sourceEntityIds: proposal.sourceEntityIds ?? current?.sourceEntityIds ?? [],
      rationale: proposal.rationale,
      confidence: proposal.confidence,
      taskSpec: proposal.taskSpec,
      metadata: proposal.metadata ?? current?.metadata ?? {},
      taskId: proposal.taskId ?? current?.taskId ?? null,
      actedAt: proposal.actedAt ?? current?.actedAt ?? null,
      createdAt: current?.createdAt ?? proposal.createdAt ?? nowIso(),
      updatedAt: nowIso()
    };

    this.db.prepare(`
      INSERT INTO proposals (
        id, proposal_type, status, fingerprint, source_entity_ids, rationale, confidence, task_spec, metadata, task_id, acted_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fingerprint)
      DO UPDATE SET
        proposal_type = excluded.proposal_type,
        status = excluded.status,
        source_entity_ids = excluded.source_entity_ids,
        rationale = excluded.rationale,
        confidence = excluded.confidence,
        task_spec = excluded.task_spec,
        metadata = excluded.metadata,
        task_id = excluded.task_id,
        acted_at = excluded.acted_at,
        updated_at = excluded.updated_at
    `).run(
      row.id,
      row.type,
      row.status,
      row.fingerprint,
      JSON.stringify(row.sourceEntityIds),
      row.rationale,
      row.confidence,
      JSON.stringify(row.taskSpec),
      JSON.stringify(row.metadata),
      row.taskId,
      row.actedAt,
      row.createdAt,
      row.updatedAt
    );

    return this.getByFingerprint(row.fingerprint) as ProposalRecord;
  }

  get(id: string): ProposalRecord | null {
    return hydrateProposal(this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id));
  }

  getByFingerprint(fingerprint: string): ProposalRecord | null {
    return hydrateProposal(this.db.prepare("SELECT * FROM proposals WHERE fingerprint = ?").get(fingerprint));
  }

  update(id: string, patch: Partial<ProposalRecord>) {
    const current = this.get(id);
    if (!current) {
      return null;
    }
    return this.put({
      ...current,
      ...patch,
      id
    });
  }

  list(limit = 50): ProposalRecord[] {
    return this.db
      .prepare("SELECT * FROM proposals ORDER BY datetime(created_at) DESC LIMIT ?")
      .all(limit)
      .map(hydrateProposal)
      .filter(Boolean);
  }

  countPending(): number {
    return Number(this.db.prepare("SELECT COUNT(*) as count FROM proposals WHERE status = 'pending'").get()?.count ?? 0);
  }
}

