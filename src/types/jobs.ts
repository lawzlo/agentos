import type { TaskSpec } from "./runtime-schema.js";

export type AutomationJobKind = "digest" | "task";
export type AutomationJobTemplate =
  | "daily_digest"
  | "morning_scan"
  | "inbox_sweep"
  | "proposal_sweep"
  | "custom_task";
export type AutomationJobStatus = "idle" | "running" | "healthy" | "degraded";
export type AutomationJobScheduleType = "daily" | "interval";

export interface AutomationJobRecord {
  id: string;
  name: string;
  kind: AutomationJobKind;
  template: AutomationJobTemplate;
  enabled: boolean;
  status: AutomationJobStatus;
  scheduleType: AutomationJobScheduleType;
  hourOfDay: number | null;
  intervalMinutes: number | null;
  taskSpec: TaskSpec | null;
  metadata: Record<string, unknown>;
  lastRunAt: string | null;
  lastTaskId: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationJobStatusSnapshot {
  running: boolean;
  jobCount: number;
  enabledJobCount: number;
  degradedJobCount: number;
  nextRunAt: string | null;
}
