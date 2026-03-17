import {
  createId,
  hydrateMemoryEntity,
  hydrateMemoryFact,
  nowIso
} from "./sqlite-helpers.js";
import type { MemoryEntity, MemoryEntitySnapshot, MemoryFact } from "../../types/learning.js";

export class EntityRepository {
  db: any;

  constructor(db: any) {
    this.db = db;
  }

  upsert(entity: Partial<MemoryEntity> & Pick<MemoryEntity, "type" | "key" | "title">): MemoryEntity {
    const current = this.getByTypeKey(entity.type, entity.key);
    const row = {
      id: current?.id ?? entity.id ?? createId("ment"),
      type: entity.type,
      key: entity.key,
      title: entity.title,
      summary: entity.summary ?? current?.summary ?? null,
      metadata: entity.metadata ?? current?.metadata ?? {},
      lastObservedAt: entity.lastObservedAt ?? nowIso(),
      createdAt: current?.createdAt ?? entity.createdAt ?? nowIso(),
      updatedAt: nowIso()
    };

    this.db.prepare(`
      INSERT INTO memory_entities (
        id, entity_type, entity_key, title, summary, metadata, last_observed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_key)
      DO UPDATE SET
        title = excluded.title,
        summary = excluded.summary,
        metadata = excluded.metadata,
        last_observed_at = excluded.last_observed_at,
        updated_at = excluded.updated_at
    `).run(
      row.id,
      row.type,
      row.key,
      row.title,
      row.summary,
      JSON.stringify(row.metadata),
      row.lastObservedAt,
      row.createdAt,
      row.updatedAt
    );

    return this.getByTypeKey(row.type, row.key) as MemoryEntity;
  }

  get(id: string): MemoryEntity | null {
    return hydrateMemoryEntity(this.db.prepare("SELECT * FROM memory_entities WHERE id = ?").get(id));
  }

  getByTypeKey(type: MemoryEntity["type"], key: string): MemoryEntity | null {
    return hydrateMemoryEntity(
      this.db.prepare("SELECT * FROM memory_entities WHERE entity_type = ? AND entity_key = ?").get(type, key)
    );
  }

  list(limit = 50): MemoryEntity[] {
    return this.db
      .prepare("SELECT * FROM memory_entities ORDER BY datetime(last_observed_at) DESC LIMIT ?")
      .all(limit)
      .map(hydrateMemoryEntity)
      .filter(Boolean);
  }

  count(): number {
    return Number(this.db.prepare("SELECT COUNT(*) as count FROM memory_entities").get()?.count ?? 0);
  }

  addFact(fact: Partial<MemoryFact> & Pick<MemoryFact, "entityId" | "kind" | "value">): MemoryFact {
    const row = {
      id: fact.id ?? createId("fact"),
      entityId: fact.entityId,
      kind: fact.kind,
      value: fact.value,
      sourceObservationId: fact.sourceObservationId ?? null,
      createdAt: fact.createdAt ?? nowIso(),
      updatedAt: nowIso()
    };

    this.db.prepare(`
      INSERT INTO memory_facts (id, entity_id, kind, value, source_observation_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.entityId,
      row.kind,
      JSON.stringify(row.value),
      row.sourceObservationId,
      row.createdAt,
      row.updatedAt
    );

    return hydrateMemoryFact(this.db.prepare("SELECT * FROM memory_facts WHERE id = ?").get(row.id)) as MemoryFact;
  }

  listFacts(entityId: string): MemoryFact[] {
    return this.db
      .prepare("SELECT * FROM memory_facts WHERE entity_id = ? ORDER BY datetime(created_at) ASC")
      .all(entityId)
      .map(hydrateMemoryFact)
      .filter(Boolean);
  }

  getSnapshot(entityId: string): MemoryEntitySnapshot | null {
    const entity = this.get(entityId);
    if (!entity) {
      return null;
    }

    return {
      ...entity,
      facts: this.listFacts(entityId)
    };
  }
}

