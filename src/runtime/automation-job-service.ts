import type { AgentOsConfig } from "../config.js";
import type { TaskSpec } from "../types/runtime-schema.js";
import type {
  AutomationJobRecord,
  AutomationJobScheduleType,
  AutomationJobStatusSnapshot,
  AutomationJobTemplate
} from "../types/jobs.js";
import type { EventBus } from "./event-bus.js";
import type { ControlPlaneStore } from "./store.js";

interface AutomationJobServiceOptions {
  store: Pick<
    ControlPlaneStore,
    "putAutomationJob" | "getAutomationJob" | "listAutomationJobs" | "deleteAutomationJob"
  >;
  eventBus: EventBus;
  config: AgentOsConfig;
  createTask(taskSpec: TaskSpec): Promise<{ id: string }>;
  runDigest(): Promise<{ id: string }>;
}

interface CreateAutomationJobInput {
  template: AutomationJobTemplate;
  name?: string | null;
  workspaceName?: string | null;
  preferredSurface?: "auto" | "browser" | "desktop" | null;
  goal?: string | null;
  inputs?: Record<string, unknown> | null;
  enabled?: boolean;
  hourOfDay?: number | null;
  intervalMinutes?: number | null;
}

interface TaskTemplateDefaults {
  name: string;
  goal: string;
  preferredSurface: "auto" | "browser" | "desktop";
  workspaceName?: string | null;
}

interface AutomationJobStartupRecovery {
  reconciledRunningJobCount: number;
  dueJobCountAtStartup: number;
}

type FollowUpScope = "slack" | "wechat" | "mail" | "boss";
type FollowUpPriorityMode = "stale_first" | "balanced" | "recent_first";

interface FollowUpSweepInputs extends Record<string, unknown> {
  scope: FollowUpScope[];
  staleAfterHours: number;
  awaitingMyReplyOnly: boolean;
  priorityMode: FollowUpPriorityMode;
  maxThreads: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function clampHourOfDay(value: number | null | undefined): number {
  const hour = Number(value ?? 0);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error("hourOfDay must be an integer between 0 and 23");
  }
  return hour;
}

function clampIntervalMinutes(value: number | null | undefined): number {
  const minutes = Number(value ?? 0);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error("intervalMinutes must be greater than 0");
  }
  return Math.max(1, Math.round(minutes));
}

function scheduleTypeForTemplate(
  template: AutomationJobTemplate,
  input: Pick<CreateAutomationJobInput, "hourOfDay" | "intervalMinutes">
): AutomationJobScheduleType {
  if (input.intervalMinutes != null) {
    return "interval";
  }
  if (input.hourOfDay != null) {
    return "daily";
  }
  return template === "inbox_sweep" || template === "follow_up_sweep" || template === "proposal_sweep"
    ? "interval"
    : "daily";
}

function defaultHourForTemplate(template: AutomationJobTemplate): number {
  if (template === "daily_digest") {
    return 18;
  }
  if (template === "morning_scan") {
    return 9;
  }
  if (template === "custom_task") {
    return 9;
  }
  return 10;
}

function defaultIntervalForTemplate(template: AutomationJobTemplate): number {
  if (template === "follow_up_sweep") {
    return 180;
  }
  if (template === "proposal_sweep") {
    return 180;
  }
  return 120;
}

function parseBooleanish(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "n", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeStringArray(entry));
  }
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .flatMap((entry) => entry.split(/\s+/))
    .filter(Boolean);
}

function normalizeFollowUpScope(value: unknown): FollowUpScope[] {
  const aliases: Record<string, FollowUpScope> = {
    slack: "slack",
    wechat: "wechat",
    weixin: "wechat",
    wx: "wechat",
    mail: "mail",
    email: "mail",
    gmail: "mail",
    outlook: "mail",
    boss: "boss",
    bosszhipin: "boss",
    "boss-zhipin": "boss",
    "boss直聘": "boss"
  };
  const seen = new Set<FollowUpScope>();
  for (const entry of normalizeStringArray(value)) {
    const normalized = aliases[entry];
    if (normalized) {
      seen.add(normalized);
    }
  }
  return seen.size ? Array.from(seen) : ["slack", "wechat", "mail", "boss"];
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    return fallback;
  }
  return Math.max(1, Math.round(numberValue));
}

function normalizeFollowUpPriority(value: unknown): FollowUpPriorityMode {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "balanced" || normalized === "recent_first" || normalized === "stale_first") {
    return normalized;
  }
  if (normalized === "recent-first") {
    return "recent_first";
  }
  if (normalized === "stale-first" || normalized === "oldest_first") {
    return "stale_first";
  }
  return "stale_first";
}

function formatFollowUpScope(scope: FollowUpScope[]): string {
  const labels: Record<FollowUpScope, string> = {
    slack: "Slack",
    wechat: "WeChat",
    mail: "email",
    boss: "BOSS"
  };
  const parts = scope.map((entry) => labels[entry]);
  if (parts.length <= 1) {
    return parts[0] ?? "Slack, WeChat, email, and BOSS";
  }
  if (parts.length === 2) {
    return `${parts[0]} and ${parts[1]}`;
  }
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

function normalizeFollowUpSweepInputs(value: Record<string, unknown> | null | undefined): FollowUpSweepInputs {
  const raw = value ?? {};
  const scope = normalizeFollowUpScope(raw.scope ?? raw.channels ?? raw.packs);
  const staleAfterHours = normalizePositiveInteger(raw.staleAfterHours ?? raw.staleHours, 24);
  const awaitingMyReplyOnly = parseBooleanish(
    raw.awaitingMyReplyOnly ?? raw.awaitingMe ?? raw.awaiting,
    true
  );
  const priorityMode = normalizeFollowUpPriority(raw.priorityMode ?? raw.priority);
  const maxThreads = normalizePositiveInteger(raw.maxThreads ?? raw.limit, 12);
  return {
    scope,
    staleAfterHours,
    awaitingMyReplyOnly,
    priorityMode,
    maxThreads
  };
}

function buildFollowUpSweepGoal(inputs: FollowUpSweepInputs): string {
  const scopeText = formatFollowUpScope(inputs.scope);
  const attentionText = inputs.awaitingMyReplyOnly ? "are waiting on me" : "may need a proactive touch";
  const priorityText =
    inputs.priorityMode === "balanced"
      ? "balance stale urgency with recent activity"
      : inputs.priorityMode === "recent_first"
        ? "prioritize the most recent high-signal threads first"
        : "prioritize the oldest stale threads first";
  return `Review ${scopeText} conversations that have been stale for at least ${inputs.staleAfterHours} hours and ${attentionText}, ${priorityText}, handle up to ${inputs.maxThreads} thread(s), draft low-risk follow-ups or nudges, and leave uncertain or risky outreach for approval.`;
}

function templateTaskDefaults(
  template: AutomationJobTemplate,
  input: Pick<CreateAutomationJobInput, "goal" | "preferredSurface" | "workspaceName" | "inputs">
): TaskTemplateDefaults | null {
  if (template === "daily_digest") {
    return null;
  }

  if (template === "morning_scan") {
    return {
      name: "Morning scan",
      goal:
        input.goal?.trim() ||
        "Review my priority inbox, urgent chat threads, and important open work, then prepare a concise morning brief with follow-up suggestions.",
      preferredSurface: input.preferredSurface ?? "browser",
      workspaceName: input.workspaceName ?? "personal-main"
    };
  }

  if (template === "inbox_sweep") {
    return {
      name: "Inbox sweep",
      goal:
        input.goal?.trim() ||
        "Sweep my inbox and messaging apps, identify urgent items, and draft safe replies while leaving risky replies for approval.",
      preferredSurface: input.preferredSurface ?? "browser",
      workspaceName: input.workspaceName ?? "personal-main"
    };
  }

  if (template === "follow_up_sweep") {
    const followUpInputs = normalizeFollowUpSweepInputs(input.inputs);
    return {
      name: "Follow-up sweep",
      goal: input.goal?.trim() || buildFollowUpSweepGoal(followUpInputs),
      preferredSurface: input.preferredSurface ?? "auto",
      workspaceName: input.workspaceName ?? "personal-main"
    };
  }

  if (template === "proposal_sweep") {
    return {
      name: "Proposal sweep",
      goal:
        input.goal?.trim() ||
        "Review pending AgentOS proposals, summarize the important ones, and recommend what should be accepted, rejected, or deferred.",
      preferredSurface: input.preferredSurface ?? "auto",
      workspaceName: input.workspaceName ?? "personal-main"
    };
  }

  const customGoal = input.goal?.trim();
  if (!customGoal) {
    throw new Error("custom_task jobs require a goal");
  }
  return {
    name: "Custom task",
    goal: customGoal,
    preferredSurface: input.preferredSurface ?? "auto",
    workspaceName: input.workspaceName ?? "personal-main"
  };
}

function buildTaskSpecForTemplate(
  template: AutomationJobTemplate,
  input: Pick<CreateAutomationJobInput, "goal" | "preferredSurface" | "workspaceName" | "inputs">
): TaskSpec | null {
  const defaults = templateTaskDefaults(template, input);
  if (!defaults) {
    return null;
  }

  const normalizedInputs =
    template === "follow_up_sweep"
      ? normalizeFollowUpSweepInputs(input.inputs)
      : input.inputs && Object.keys(input.inputs).length
        ? input.inputs
        : undefined;

  return {
    goal: defaults.goal,
    preferredSurface: defaults.preferredSurface,
    workspaceName: defaults.workspaceName ?? null,
    triggerSource: "automation_job",
    ...(normalizedInputs ? { inputs: normalizedInputs } : {})
  };
}

function defaultNameForTemplate(template: AutomationJobTemplate, input: CreateAutomationJobInput): string {
  return (
    input.name?.trim() ||
    templateTaskDefaults(template, input)?.name ||
    (template === "daily_digest" ? "Daily digest" : "Automation job")
  );
}

function computeNextRunAt(job: AutomationJobRecord, fromDate = new Date()): string | null {
  if (!job.enabled) {
    return null;
  }

  if (job.scheduleType === "interval") {
    const minutes = clampIntervalMinutes(job.intervalMinutes);
    return new Date(fromDate.getTime() + minutes * 60_000).toISOString();
  }

  const next = new Date(fromDate);
  next.setMinutes(0, 0, 0);
  next.setHours(clampHourOfDay(job.hourOfDay), 0, 0, 0);
  if (next.getTime() <= fromDate.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.toISOString();
}

export class AutomationJobService {
  store: AutomationJobServiceOptions["store"];
  eventBus: EventBus;
  config: AgentOsConfig;
  createTask: AutomationJobServiceOptions["createTask"];
  runDigest: AutomationJobServiceOptions["runDigest"];
  running: boolean;
  timer: NodeJS.Timeout | null;
  tickInProgress: Promise<void> | null;
  startupRecovery: AutomationJobStartupRecovery | null;

  constructor({ store, eventBus, config, createTask, runDigest }: AutomationJobServiceOptions) {
    this.store = store;
    this.eventBus = eventBus;
    this.config = config;
    this.createTask = createTask;
    this.runDigest = runDigest;
    this.running = false;
    this.timer = null;
    this.tickInProgress = null;
    this.startupRecovery = null;
  }

  async start(): Promise<AutomationJobStartupRecovery> {
    if (!this.config.jobs.enabled) {
      const summary = {
        reconciledRunningJobCount: 0,
        dueJobCountAtStartup: 0
      };
      this.startupRecovery = summary;
      return summary;
    }

    if (this.running) {
      return (
        this.startupRecovery ?? {
          reconciledRunningJobCount: 0,
          dueJobCountAtStartup: 0
        }
      );
    }
    this.running = true;
    this.startupRecovery = this.reconcileStartupState();
    await this.runDueJobs();
    this.timer = setInterval(() => {
      void this.runDueJobs();
    }, this.config.jobs.pollIntervalMs);
    return this.startupRecovery;
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await Promise.allSettled([this.tickInProgress ?? Promise.resolve()]);
    this.tickInProgress = null;
  }

  status(): AutomationJobStatusSnapshot {
    const jobs = this.store.listAutomationJobs();
    const enabled = jobs.filter((job) => job.enabled);
    const nextRunAt = enabled
      .map((job) => job.nextRunAt)
      .filter((value): value is string => Boolean(value))
      .sort()[0] ?? null;
    return {
      running: this.running,
      jobCount: jobs.length,
      enabledJobCount: enabled.length,
      degradedJobCount: jobs.filter((job) => job.status === "degraded").length,
      nextRunAt
    };
  }

  listJobs(limit = 100): AutomationJobRecord[] {
    return this.store.listAutomationJobs(limit);
  }

  getJob(jobId: string): AutomationJobRecord | null {
    return this.store.getAutomationJob(jobId);
  }

  getStartupRecovery(): AutomationJobStartupRecovery | null {
    return this.startupRecovery;
  }

  createJob(input: CreateAutomationJobInput): AutomationJobRecord {
    const scheduleType = scheduleTypeForTemplate(input.template, input);
    const taskSpec = buildTaskSpecForTemplate(input.template, input);
    const enabled = input.enabled ?? true;
    const baseJob = this.store.putAutomationJob({
      name: defaultNameForTemplate(input.template, input),
      kind: input.template === "daily_digest" ? "digest" : "task",
      template: input.template,
      enabled,
      status: "idle",
      scheduleType,
      hourOfDay: scheduleType === "daily" ? clampHourOfDay(input.hourOfDay ?? defaultHourForTemplate(input.template)) : null,
      intervalMinutes:
        scheduleType === "interval"
          ? clampIntervalMinutes(input.intervalMinutes ?? defaultIntervalForTemplate(input.template))
          : null,
      taskSpec,
      metadata: {
        workspaceName: taskSpec?.workspaceName ?? null,
        preferredSurface: taskSpec?.preferredSurface ?? null,
        inputs: taskSpec?.inputs ?? {}
      },
      lastRunAt: null,
      lastTaskId: null,
      nextRunAt: null,
      lastError: null
    });

    return this.store.putAutomationJob({
      ...baseJob,
      nextRunAt: computeNextRunAt(baseJob)
    });
  }

  enableJob(jobId: string): AutomationJobRecord {
    const current = this.requireJob(jobId);
    return this.store.putAutomationJob({
      ...current,
      enabled: true,
      status: current.status === "degraded" ? current.status : "idle",
      nextRunAt: current.nextRunAt ?? computeNextRunAt({ ...current, enabled: true })
    });
  }

  disableJob(jobId: string): AutomationJobRecord {
    const current = this.requireJob(jobId);
    return this.store.putAutomationJob({
      ...current,
      enabled: false,
      nextRunAt: null
    });
  }

  deleteJob(jobId: string): boolean {
    return this.store.deleteAutomationJob(jobId);
  }

  async runJobNow(jobId: string): Promise<AutomationJobRecord> {
    return this.#executeJob(this.requireJob(jobId), { manual: true });
  }

  async runDueJobs(): Promise<void> {
    if (!this.running || this.tickInProgress) {
      return;
    }

    const tick = (async () => {
      const now = Date.now();
      const due = this.store
        .listAutomationJobs()
        .filter((job) => job.enabled && job.nextRunAt && Date.parse(job.nextRunAt) <= now && job.status !== "running")
        .sort((left, right) => Date.parse(left.nextRunAt ?? left.updatedAt) - Date.parse(right.nextRunAt ?? right.updatedAt));

      for (const job of due) {
        await this.#executeJob(job);
      }
    })().finally(() => {
      if (this.tickInProgress === tick) {
        this.tickInProgress = null;
      }
    });

    this.tickInProgress = tick;
    await tick;
  }

  requireJob(jobId: string): AutomationJobRecord {
    const job = this.getJob(jobId);
    if (!job) {
      throw new Error(`Automation job not found: ${jobId}`);
    }
    return job;
  }

  reconcileStartupState(): AutomationJobStartupRecovery {
    const recoveredAt = nowIso();
    const jobs = this.store.listAutomationJobs();
    const runningJobs = jobs.filter((job) => job.status === "running");
    const dueJobCountAtStartup = jobs.filter(
      (job) => job.enabled && job.nextRunAt && Date.parse(job.nextRunAt) <= Date.now()
    ).length;

    for (const job of runningJobs) {
      const recovered = this.store.putAutomationJob({
        ...job,
        status: "degraded",
        lastError: "Daemon restarted before automation job completion.",
        metadata: {
          ...job.metadata,
          recoveredAfterRestartAt: recoveredAt,
          recoveryReason: "daemon_restart"
        }
      });
      this.eventBus.broadcast("job.updated", recovered);
    }

    return {
      reconciledRunningJobCount: runningJobs.length,
      dueJobCountAtStartup
    };
  }

  async #executeJob(job: AutomationJobRecord, { manual = false }: { manual?: boolean } = {}): Promise<AutomationJobRecord> {
    const runningJob = this.store.putAutomationJob({
      ...job,
      status: "running",
      lastError: null
    });
    this.eventBus.broadcast("job.updated", runningJob);

    try {
      let lastTaskId: string | null = null;
      if (runningJob.kind === "digest") {
        await this.runDigest();
      } else if (runningJob.taskSpec) {
        const task = await this.createTask({
          ...runningJob.taskSpec,
          triggerSource: "automation_job"
        });
        lastTaskId = task.id;
      }

      const finished = this.store.putAutomationJob({
        ...runningJob,
        status: "healthy",
        lastRunAt: nowIso(),
        lastTaskId,
        nextRunAt: runningJob.enabled ? computeNextRunAt(runningJob, new Date()) : null,
        lastError: null
      });
      this.eventBus.broadcast("job.updated", finished);
      return finished;
    } catch (error: unknown) {
      const finished = this.store.putAutomationJob({
        ...runningJob,
        status: "degraded",
        lastRunAt: nowIso(),
        nextRunAt: runningJob.enabled ? computeNextRunAt(runningJob, new Date()) : null,
        lastError: error instanceof Error ? error.message : String(error)
      });
      this.eventBus.broadcast("job.updated", finished);
      return finished;
    }
  }
}
