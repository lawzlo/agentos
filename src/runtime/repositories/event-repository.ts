import { createId, nowIso, parseJson } from "./sqlite-helpers.js";

export class EventRepository {
  db: any;

  constructor(db: any) {
    this.db = db;
  }

  create(event: Record<string, any>) {
    const row = {
      id: event.id ?? createId("evt"),
      type: event.type ?? "manual",
      source: event.source ?? "manual",
      payload: event.payload ?? {},
      taskId: event.taskId ?? null,
      createdAt: nowIso()
    };

    this.db.prepare(`
      INSERT INTO events (id, type, source, payload, task_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(row.id, row.type, row.source, JSON.stringify(row.payload), row.taskId, row.createdAt);

    return row;
  }

  attachTask(eventId: string, taskId: string) {
    this.db.prepare("UPDATE events SET task_id = ? WHERE id = ?").run(taskId, eventId);
    return this.db.prepare("SELECT * FROM events WHERE id = ?").get(eventId);
  }

  list(limit = 50) {
    return this.db
      .prepare(`
        SELECT * FROM events
        ORDER BY datetime(created_at) DESC
        LIMIT ?
      `)
      .all(limit)
      .map((row: Record<string, any>) => ({
        id: row.id,
        type: row.type,
        source: row.source,
        taskId: row.task_id,
        payload: parseJson(row.payload, {}),
        createdAt: row.created_at
      }));
  }
}
