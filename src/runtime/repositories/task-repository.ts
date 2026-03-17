import { DatabaseSync } from "node:sqlite";

import {
  createId,
  hydrateTask,
  nowIso
} from "./sqlite-helpers.js";
import type { TaskRecord, TaskSpec, TaskStatus } from "../../types/runtime-schema.js";

export class TaskRepository {
  db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(taskSpec: TaskSpec & Partial<TaskRecord>) {
    const id = taskSpec.id ?? createId("task");
    const createdAt = nowIso();
    const record = {
      id,
      goal: taskSpec.goal,
      status: "queued",
      priority: taskSpec.priority ?? "normal",
      triggerSource: taskSpec.triggerSource ?? "manual",
      deadline: taskSpec.deadline ?? null,
      preferredSurface: taskSpec.preferredSurface ?? "auto",
      workspaceId: taskSpec.workspaceId ?? null,
      traceId: null,
      taskSpec,
      plan: [],
      result: null,
      error: null,
      createdAt,
      updatedAt: createdAt
    };

    this.db.prepare(`
      INSERT INTO tasks (
        id, goal, status, priority, trigger_source, deadline, preferred_surface, workspace_id, trace_id,
        task_spec, plan, result, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.goal,
      record.status,
      record.priority,
      record.triggerSource,
      record.deadline,
      record.preferredSurface,
      record.workspaceId,
      record.traceId,
      JSON.stringify(record.taskSpec),
      JSON.stringify(record.plan),
      JSON.stringify(record.result),
      record.error,
      record.createdAt,
      record.updatedAt
    );

    return this.get(record.id);
  }

  update(id: string, patch: Partial<TaskRecord>) {
    const current = this.get(id);
    if (!current) {
      return null;
    }

    const merged = {
      ...current,
      ...patch,
      taskSpec: patch.taskSpec ?? current.taskSpec,
      plan: patch.plan ?? current.plan,
      result: patch.result ?? current.result,
      updatedAt: nowIso()
    };

    this.db.prepare(`
      UPDATE tasks
      SET goal = ?, status = ?, priority = ?, trigger_source = ?, deadline = ?, preferred_surface = ?,
          workspace_id = ?, trace_id = ?, task_spec = ?, plan = ?, result = ?, error = ?, updated_at = ?
      WHERE id = ?
    `).run(
      merged.goal,
      merged.status,
      merged.priority,
      merged.triggerSource,
      merged.deadline,
      merged.preferredSurface,
      merged.workspaceId,
      merged.traceId ?? null,
      JSON.stringify(merged.taskSpec),
      JSON.stringify(merged.plan),
      JSON.stringify(merged.result),
      merged.error ?? null,
      merged.updatedAt,
      id
    );

    return this.get(id);
  }

  list(limit = 50): TaskRecord[] {
    return this.db
      .prepare(`
        SELECT * FROM tasks
        ORDER BY datetime(created_at) DESC
        LIMIT ?
      `)
      .all(limit)
      .map(hydrateTask);
  }

  get(id: string): TaskRecord | null {
    return hydrateTask(this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id));
  }

  listByStatuses(statuses: TaskStatus[] = []): TaskRecord[] {
    if (!statuses.length) {
      return [];
    }

    const placeholders = statuses.map(() => "?").join(", ");
    return this.db
      .prepare(`
        SELECT * FROM tasks
        WHERE status IN (${placeholders})
        ORDER BY datetime(created_at) ASC
      `)
      .all(...statuses)
      .map(hydrateTask);
  }
}
