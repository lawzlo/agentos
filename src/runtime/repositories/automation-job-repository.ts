import {
  createId,
  hydrateAutomationJob,
  nowIso
} from "./sqlite-helpers.js";
import type { AutomationJobRecord } from "../../types/jobs.js";

export class AutomationJobRepository {
  db: any;

  constructor(db: any) {
    this.db = db;
  }

  put(
    job: Partial<AutomationJobRecord> &
      Pick<AutomationJobRecord, "name" | "kind" | "template" | "scheduleType">
  ): AutomationJobRecord {
    const current = job.id ? this.get(job.id) : null;
    const row = {
      id: current?.id ?? job.id ?? createId("job"),
      name: job.name,
      kind: job.kind,
      template: job.template,
      enabled: job.enabled ?? current?.enabled ?? true,
      status: job.status ?? current?.status ?? "idle",
      scheduleType: job.scheduleType,
      hourOfDay: job.hourOfDay ?? current?.hourOfDay ?? null,
      intervalMinutes: job.intervalMinutes ?? current?.intervalMinutes ?? null,
      taskSpec: job.taskSpec ?? current?.taskSpec ?? null,
      metadata: job.metadata ?? current?.metadata ?? {},
      lastRunAt: job.lastRunAt ?? current?.lastRunAt ?? null,
      lastTaskId: job.lastTaskId ?? current?.lastTaskId ?? null,
      nextRunAt: job.nextRunAt ?? current?.nextRunAt ?? null,
      lastError: job.lastError ?? current?.lastError ?? null,
      createdAt: current?.createdAt ?? job.createdAt ?? nowIso(),
      updatedAt: nowIso()
    };

    this.db.prepare(`
      INSERT INTO automation_jobs (
        id, name, job_kind, template, enabled, status, schedule_type, hour_of_day, interval_minutes, task_spec, metadata,
        last_run_at, last_task_id, next_run_at, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id)
      DO UPDATE SET
        name = excluded.name,
        job_kind = excluded.job_kind,
        template = excluded.template,
        enabled = excluded.enabled,
        status = excluded.status,
        schedule_type = excluded.schedule_type,
        hour_of_day = excluded.hour_of_day,
        interval_minutes = excluded.interval_minutes,
        task_spec = excluded.task_spec,
        metadata = excluded.metadata,
        last_run_at = excluded.last_run_at,
        last_task_id = excluded.last_task_id,
        next_run_at = excluded.next_run_at,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(
      row.id,
      row.name,
      row.kind,
      row.template,
      row.enabled ? 1 : 0,
      row.status,
      row.scheduleType,
      row.hourOfDay,
      row.intervalMinutes,
      row.taskSpec ? JSON.stringify(row.taskSpec) : null,
      JSON.stringify(row.metadata),
      row.lastRunAt,
      row.lastTaskId,
      row.nextRunAt,
      row.lastError,
      row.createdAt,
      row.updatedAt
    );

    return this.get(row.id) as AutomationJobRecord;
  }

  get(id: string): AutomationJobRecord | null {
    return hydrateAutomationJob(this.db.prepare("SELECT * FROM automation_jobs WHERE id = ?").get(id));
  }

  list(limit = 100): AutomationJobRecord[] {
    return this.db
      .prepare("SELECT * FROM automation_jobs ORDER BY enabled DESC, datetime(updated_at) DESC LIMIT ?")
      .all(limit)
      .map(hydrateAutomationJob)
      .filter(Boolean);
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM automation_jobs WHERE id = ?").run(id);
    return Number(result.changes ?? 0) > 0;
  }
}
