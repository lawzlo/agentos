import { createId, nowIso, parseJson } from "./sqlite-helpers.js";

export class MemoryRepository {
  db: any;

  constructor(db: any) {
    this.db = db;
  }

  put(namespace: string, key: string, value: unknown) {
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

    return this.get(namespace, key);
  }

  get(namespace: string, key: string) {
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
      .map((row: Record<string, any>) => ({
        id: row.id,
        scope: row.scope,
        name: row.name,
        rule: parseJson(row.rule, {}),
        createdAt: row.created_at
      }));
  }
}
