import {
  createId,
  hydrateArtifact,
  nowIso
} from "./sqlite-helpers.js";

export class ArtifactRepository {
  db: any;

  constructor(db: any) {
    this.db = db;
  }

  create(artifact: Record<string, any>) {
    const row = {
      id: artifact.id ?? createId("artifact"),
      taskId: artifact.taskId,
      traceId: artifact.traceId ?? null,
      kind: artifact.kind,
      label: artifact.label,
      path: artifact.path,
      metadata: artifact.metadata ?? {},
      createdAt: artifact.createdAt ?? nowIso()
    };

    this.db.prepare(`
      INSERT INTO artifacts (id, task_id, trace_id, kind, label, path, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.taskId,
      row.traceId,
      row.kind,
      row.label,
      row.path,
      JSON.stringify(row.metadata),
      row.createdAt
    );

    return hydrateArtifact(this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(row.id));
  }

  listForTask(taskId: string) {
    return this.db
      .prepare(`
        SELECT * FROM artifacts
        WHERE task_id = ?
        ORDER BY datetime(created_at) ASC
      `)
      .all(taskId)
      .map(hydrateArtifact);
  }
}
