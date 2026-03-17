import {
  createId,
  hydrateKnowledgeChunk,
  nowIso
} from "./sqlite-helpers.js";
import type { KnowledgeChunk } from "../../types/learning.js";

export class KnowledgeRepository {
  db: any;

  constructor(db: any) {
    this.db = db;
  }

  create(chunk: Partial<KnowledgeChunk> & Pick<KnowledgeChunk, "sourceId" | "title" | "content">): KnowledgeChunk {
    const row = {
      id: chunk.id ?? createId("chunk"),
      sourceId: chunk.sourceId,
      observationId: chunk.observationId ?? null,
      entityId: chunk.entityId ?? null,
      title: chunk.title,
      content: chunk.content,
      metadata: chunk.metadata ?? {},
      createdAt: chunk.createdAt ?? nowIso()
    };

    this.db.prepare(`
      INSERT INTO knowledge_chunks (
        id, source_id, observation_id, entity_id, title, content, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.sourceId,
      row.observationId,
      row.entityId,
      row.title,
      row.content,
      JSON.stringify(row.metadata),
      row.createdAt
    );
    this.db.prepare(`
      INSERT INTO knowledge_chunks_fts (chunk_id, title, content)
      VALUES (?, ?, ?)
    `).run(row.id, row.title, row.content);

    return this.get(row.id) as KnowledgeChunk;
  }

  get(id: string): KnowledgeChunk | null {
    return hydrateKnowledgeChunk(this.db.prepare("SELECT * FROM knowledge_chunks WHERE id = ?").get(id));
  }

  count(): number {
    return Number(this.db.prepare("SELECT COUNT(*) as count FROM knowledge_chunks").get()?.count ?? 0);
  }

  search(query: string, limit = 20): KnowledgeChunk[] {
    const trimmed = String(query ?? "").trim();
    if (!trimmed) {
      return [];
    }

    try {
      return this.db
        .prepare(`
          SELECT kc.*
          FROM knowledge_chunks_fts fts
          JOIN knowledge_chunks kc ON kc.id = fts.chunk_id
          WHERE knowledge_chunks_fts MATCH ?
          LIMIT ?
        `)
        .all(trimmed, limit)
        .map(hydrateKnowledgeChunk)
        .filter(Boolean);
    } catch {
      return this.db
        .prepare(`
          SELECT * FROM knowledge_chunks
          WHERE title LIKE ? OR content LIKE ?
          ORDER BY datetime(created_at) DESC
          LIMIT ?
        `)
        .all(`%${trimmed}%`, `%${trimmed}%`, limit)
        .map(hydrateKnowledgeChunk)
        .filter(Boolean);
    }
  }
}

