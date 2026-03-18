import {
  apiRequest,
  boolOption,
  print,
  type CliOptions
} from "../cli-utils.js";
import type { AutomationJobRecord } from "../../src/types/jobs.js";

function formatJob(job: AutomationJobRecord) {
  const cadence =
    job.scheduleType === "daily"
      ? `daily@${String(job.hourOfDay ?? 0).padStart(2, "0")}:00`
      : `every ${job.intervalMinutes}m`;
  return [
    job.id,
    job.enabled ? "enabled" : "disabled",
    job.status,
    job.template,
    cadence,
    job.nextRunAt ? `next ${job.nextRunAt}` : "next n/a",
    job.name
  ].join("  ");
}

export async function commandJobs(subcommand: string | undefined, positionals: string[], options: CliOptions) {
  if (subcommand === "ls") {
    const payload = await apiRequest<{ jobs: AutomationJobRecord[] }>("GET", `/jobs?limit=${Number(options.limit ?? 100)}`);
    if (options.json) {
      print(payload.jobs, options);
      return;
    }
    console.log(payload.jobs.map(formatJob).join("\n") || "No automation jobs found.");
    return;
  }

  if (subcommand === "add") {
    const [template, ...goalParts] = positionals;
    if (!template) {
      throw new Error("jobs add requires a template");
    }
    const payload = await apiRequest<{ job: AutomationJobRecord }>("POST", "/jobs", {
      template,
      name: typeof options.name === "string" ? options.name : undefined,
      goal: typeof options.goal === "string" ? options.goal : goalParts.join(" ").trim() || undefined,
      preferredSurface: options.surface,
      workspaceName: options.workspace,
      enabled: options.enabled == null ? true : boolOption(options.enabled),
      hourOfDay: options.hour != null ? Number(options.hour) : undefined,
      intervalMinutes: options.intervalMinutes != null ? Number(options.intervalMinutes) : undefined
    });
    print(payload.job, options);
    return;
  }

  if (subcommand === "inspect") {
    const [jobId] = positionals;
    if (!jobId) {
      throw new Error("jobs inspect requires a job id");
    }
    const payload = await apiRequest<{ job: AutomationJobRecord }>("GET", `/jobs/${jobId}`);
    print(payload.job, options);
    return;
  }

  if (subcommand === "run") {
    const [jobId] = positionals;
    if (!jobId) {
      throw new Error("jobs run requires a job id");
    }
    const payload = await apiRequest<{ job: AutomationJobRecord }>("POST", `/jobs/${jobId}/run`);
    print(payload.job, options);
    return;
  }

  if (subcommand === "enable" || subcommand === "disable") {
    const [jobId] = positionals;
    if (!jobId) {
      throw new Error(`jobs ${subcommand} requires a job id`);
    }
    const payload = await apiRequest<{ job: AutomationJobRecord }>("POST", `/jobs/${jobId}/${subcommand}`);
    print(payload.job, options);
    return;
  }

  if (subcommand === "rm") {
    const [jobId] = positionals;
    if (!jobId) {
      throw new Error("jobs rm requires a job id");
    }
    const payload = await apiRequest<{ ok: boolean }>("DELETE", `/jobs/${jobId}`);
    print(payload, options);
    return;
  }

  throw new Error(`Unsupported jobs command: ${subcommand}`);
}
