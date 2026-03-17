import {
  createId,
  hydrateDigest,
  nowIso
} from "./sqlite-helpers.js";
import type { DigestRecord } from "../../types/learning.js";

export class DigestRepository {
  db: any;

  constructor(db: any) {
    this.db = db;
  }

  put(digest: Partial<DigestRecord> & Pick<DigestRecord, "digestDate" | "summary">): DigestRecord {
    const current = this.getByDate(digest.digestDate);
    const row = {
      id: current?.id ?? digest.id ?? createId("digest"),
      digestDate: digest.digestDate,
      status: "completed",
      summary: digest.summary,
      metadata: digest.metadata ?? current?.metadata ?? {},
      createdAt: current?.createdAt ?? digest.createdAt ?? nowIso(),
      updatedAt: nowIso()
    };

    this.db.prepare(`
      INSERT INTO digests (id, digest_date, status, summary, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(digest_date)
      DO UPDATE SET
        summary = excluded.summary,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `).run(
      row.id,
      row.digestDate,
      row.status,
      row.summary,
      JSON.stringify(row.metadata),
      row.createdAt,
      row.updatedAt
    );

    return this.getByDate(row.digestDate) as DigestRecord;
  }

  getByDate(digestDate: string): DigestRecord | null {
    return hydrateDigest(this.db.prepare("SELECT * FROM digests WHERE digest_date = ?").get(digestDate));
  }

  latest(): DigestRecord | null {
    return hydrateDigest(this.db.prepare("SELECT * FROM digests ORDER BY digest_date DESC LIMIT 1").get());
  }

  list(limit = 30): DigestRecord[] {
    return this.db
      .prepare("SELECT * FROM digests ORDER BY digest_date DESC LIMIT ?")
      .all(limit)
      .map(hydrateDigest)
      .filter(Boolean);
  }
}

