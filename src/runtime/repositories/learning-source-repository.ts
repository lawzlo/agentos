import {
  createId,
  hydrateLearningSource,
  nowIso
} from "./sqlite-helpers.js";
import type { LearningSource } from "../../types/learning.js";

export class LearningSourceRepository {
  db: any;

  constructor(db: any) {
    this.db = db;
  }

  put(source: Partial<LearningSource> & Pick<LearningSource, "kind">): LearningSource {
    const current = this.getByKind(source.kind);
    const row = {
      id: current?.id ?? source.id ?? createId("lsrc"),
      kind: source.kind,
      enabled: source.enabled === false ? 0 : 1,
      status: source.status ?? current?.status ?? "idle",
      config: source.config ?? current?.config ?? {},
      state: source.state ?? current?.state ?? {},
      lastObservedAt: source.lastObservedAt ?? current?.lastObservedAt ?? null,
      lastError: source.lastError ?? current?.lastError ?? null,
      createdAt: current?.createdAt ?? source.createdAt ?? nowIso(),
      updatedAt: nowIso()
    };

    this.db.prepare(`
      INSERT INTO learning_sources (
        id, kind, enabled, status, config, state, last_observed_at, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind)
      DO UPDATE SET
        enabled = excluded.enabled,
        status = excluded.status,
        config = excluded.config,
        state = excluded.state,
        last_observed_at = excluded.last_observed_at,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(
      row.id,
      row.kind,
      row.enabled,
      row.status,
      JSON.stringify(row.config),
      JSON.stringify(row.state),
      row.lastObservedAt,
      row.lastError,
      row.createdAt,
      row.updatedAt
    );

    return this.getByKind(row.kind) as LearningSource;
  }

  get(id: string): LearningSource | null {
    return hydrateLearningSource(this.db.prepare("SELECT * FROM learning_sources WHERE id = ?").get(id));
  }

  getByKind(kind: LearningSource["kind"]): LearningSource | null {
    return hydrateLearningSource(this.db.prepare("SELECT * FROM learning_sources WHERE kind = ?").get(kind));
  }

  list(): LearningSource[] {
    return this.db
      .prepare("SELECT * FROM learning_sources ORDER BY kind ASC")
      .all()
      .map(hydrateLearningSource)
      .filter(Boolean);
  }
}

