import {
  createId,
  hydrateVaultEntry,
  nowIso
} from "./sqlite-helpers.js";

export class VaultRepository {
  db: any;

  constructor(db: any) {
    this.db = db;
  }

  put(entry: Record<string, any>) {
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

    return this.get(row.scope, row.secretKey);
  }

  get(scope: string, secretKey: string) {
    return hydrateVaultEntry(
      this.db.prepare("SELECT * FROM vault_entries WHERE scope = ? AND secret_key = ?").get(scope, secretKey)
    );
  }

  list(scope = "default") {
    return this.db
      .prepare(`
        SELECT * FROM vault_entries
        WHERE scope = ?
        ORDER BY secret_key ASC
      `)
      .all(scope)
      .map((row: Record<string, any>) => hydrateVaultEntry(row, { includeCiphertext: false }));
  }
}
