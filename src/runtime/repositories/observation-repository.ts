import {
  createId,
  hydrateObservation,
  nowIso
} from "./sqlite-helpers.js";
import type { ObservationRecord } from "../../types/learning.js";

export class ObservationRepository {
  db: any;

  constructor(db: any) {
    this.db = db;
  }

  create(observation: Partial<ObservationRecord> & Pick<ObservationRecord, "sourceId" | "category" | "fingerprint">) {
    const existing = this.getByFingerprint(observation.sourceId, observation.fingerprint);
    if (existing) {
      return existing;
    }

    const row = {
      id: observation.id ?? createId("obs"),
      sourceId: observation.sourceId,
      category: observation.category,
      fingerprint: observation.fingerprint,
      summary: observation.summary ?? null,
      metadata: observation.metadata ?? {},
      extractedText: observation.extractedText ?? null,
      artifactRefs: observation.artifactRefs ?? [],
      entityRefs: observation.entityRefs ?? [],
      createdAt: observation.createdAt ?? nowIso(),
      updatedAt: nowIso()
    };

    this.db.prepare(`
      INSERT INTO observations (
        id, source_id, category, fingerprint, summary, metadata, extracted_text, artifact_refs, entity_refs, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.sourceId,
      row.category,
      row.fingerprint,
      row.summary,
      JSON.stringify(row.metadata),
      row.extractedText,
      JSON.stringify(row.artifactRefs),
      JSON.stringify(row.entityRefs),
      row.createdAt,
      row.updatedAt
    );

    return this.get(row.id);
  }

  update(id: string, patch: Partial<ObservationRecord>) {
    const current = this.get(id);
    if (!current) {
      return null;
    }
    const merged = {
      ...current,
      ...patch,
      metadata: patch.metadata ?? current.metadata,
      artifactRefs: patch.artifactRefs ?? current.artifactRefs,
      entityRefs: patch.entityRefs ?? current.entityRefs,
      updatedAt: nowIso()
    };

    this.db.prepare(`
      UPDATE observations
      SET summary = ?, metadata = ?, extracted_text = ?, artifact_refs = ?, entity_refs = ?, updated_at = ?
      WHERE id = ?
    `).run(
      merged.summary,
      JSON.stringify(merged.metadata),
      merged.extractedText,
      JSON.stringify(merged.artifactRefs),
      JSON.stringify(merged.entityRefs),
      merged.updatedAt,
      id
    );

    return this.get(id);
  }

  get(id: string) {
    return hydrateObservation(this.db.prepare("SELECT * FROM observations WHERE id = ?").get(id));
  }

  getByFingerprint(sourceId: string, fingerprint: string) {
    return hydrateObservation(
      this.db.prepare("SELECT * FROM observations WHERE source_id = ? AND fingerprint = ?").get(sourceId, fingerprint)
    );
  }

  list(limit = 50): ObservationRecord[] {
    return this.db
      .prepare("SELECT * FROM observations ORDER BY datetime(created_at) DESC LIMIT ?")
      .all(limit)
      .map(hydrateObservation)
      .filter(Boolean);
  }

  listSince(sinceIso: string): ObservationRecord[] {
    return this.db
      .prepare("SELECT * FROM observations WHERE datetime(created_at) >= datetime(?) ORDER BY datetime(created_at) ASC")
      .all(sinceIso)
      .map(hydrateObservation)
      .filter(Boolean);
  }

  count(): number {
    return Number(this.db.prepare("SELECT COUNT(*) as count FROM observations").get()?.count ?? 0);
  }

  latestCreatedAt(): string | null {
    return this.db.prepare("SELECT created_at FROM observations ORDER BY datetime(created_at) DESC LIMIT 1").get()
      ?.created_at ?? null;
  }
}

