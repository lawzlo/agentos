import {
  createId,
  hydrateTrace,
  nowIso,
  parseJson
} from "./sqlite-helpers.js";

export class TraceRepository {
  db: any;

  constructor(db: any) {
    this.db = db;
  }

  create({ taskId, status = "running", plan = [] }: Record<string, any>) {
    const row = {
      id: createId("trace"),
      taskId,
      status,
      startedAt: nowIso(),
      endedAt: null,
      summary: null,
      plan,
      output: null
    };

    this.db.prepare(`
      INSERT INTO traces (id, task_id, status, started_at, ended_at, summary, plan, output)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.taskId,
      row.status,
      row.startedAt,
      row.endedAt,
      row.summary,
      JSON.stringify(row.plan),
      JSON.stringify(row.output)
    );

    return this.get(row.id);
  }

  update(id: string, patch: Record<string, any>) {
    const current = this.get(id);
    if (!current) {
      return null;
    }

    const merged = {
      ...current,
      ...patch,
      plan: patch.plan ?? current.plan,
      output: patch.output ?? current.output
    };

    this.db.prepare(`
      UPDATE traces
      SET status = ?, ended_at = ?, summary = ?, plan = ?, output = ?
      WHERE id = ?
    `).run(
      merged.status,
      merged.endedAt ?? null,
      merged.summary ?? null,
      JSON.stringify(merged.plan),
      JSON.stringify(merged.output),
      id
    );

    return this.get(id);
  }

  get(id: string) {
    return hydrateTrace(this.db.prepare("SELECT * FROM traces WHERE id = ?").get(id));
  }

  appendEvent(event: Record<string, any>) {
    const row = {
      id: event.id ?? createId("tevt"),
      traceId: event.traceId,
      taskId: event.taskId,
      role: event.role,
      type: event.type,
      stepId: event.stepId ?? null,
      message: event.message,
      payload: event.payload ?? {},
      createdAt: nowIso()
    };

    this.db.prepare(`
      INSERT INTO trace_events (id, trace_id, task_id, role, type, step_id, message, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.traceId,
      row.taskId,
      row.role,
      row.type,
      row.stepId,
      row.message,
      JSON.stringify(row.payload),
      row.createdAt
    );

    return row;
  }

  listEvents(traceId: string) {
    return this.db
      .prepare(`
        SELECT * FROM trace_events
        WHERE trace_id = ?
        ORDER BY datetime(created_at) ASC
      `)
      .all(traceId)
      .map((row: Record<string, any>) => ({
        id: row.id,
        traceId: row.trace_id,
        taskId: row.task_id,
        role: row.role,
        type: row.type,
        stepId: row.step_id,
        message: row.message,
        payload: parseJson(row.payload, {}),
        createdAt: row.created_at
      }));
  }
}
