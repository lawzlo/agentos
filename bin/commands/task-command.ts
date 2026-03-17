import {
  apiRequest,
  boolOption,
  type CliOptions,
  formatTask,
  parseInputs,
  print,
  waitForTask
} from "../cli-utils.js";
import type { TaskSnapshot } from "../../src/types/runtime-schema.js";
import type { DoctorBundle, DoctorReport } from "../../src/types/system.js";
import type { RuntimeVersionInfo } from "../../src/version.js";

export async function commandRun(positionals: string[], options: CliOptions) {
  const goal = positionals.join(" ").trim();
  if (!goal) {
    throw new Error("run requires a goal");
  }

  const taskPayload = {
    goal,
    preferredSurface: options.surface,
    workspaceName: options.workspace,
    skillName: options.skill,
    executionMode: options.mode,
    inputs: parseInputs(options.input)
  };
  const response = await apiRequest<{ task: TaskSnapshot }>("POST", "/tasks", taskPayload);

  if (boolOption(options.wait)) {
    const task = await waitForTask(response.task.id, Number(options.timeout ?? 30000));
    print(task, options);
    return;
  }

  print(options.json ? response.task : `Queued ${response.task.id}`, options);
}

export async function commandDoctor(options: CliOptions) {
  if (boolOption(options.bundle)) {
    const payload = await apiRequest<{ bundle: DoctorBundle }>("POST", "/doctor/bundle");
    print(payload.bundle, options);
    return;
  }

  const payload = await apiRequest<{ doctor: DoctorReport }>("GET", "/doctor");
  print(payload.doctor, options);
}

export async function commandVersion(options: CliOptions) {
  const payload = await apiRequest<{ version: RuntimeVersionInfo }>("GET", "/version");
  print(payload.version, options);
}

export async function commandPs(options: CliOptions) {
  const payload = await apiRequest<{ tasks: TaskSnapshot[] }>(
    "GET",
    `/tasks?limit=${Number(options.limit ?? 20)}`
  );
  if (options.json) {
    print(payload.tasks, options);
    return;
  }
  console.log(payload.tasks.map(formatTask).join("\n") || "No tasks found.");
}

export async function commandInspect(taskId: string | undefined, options: CliOptions) {
  if (!taskId) {
    throw new Error("inspect requires a task id");
  }
  const payload = await apiRequest<{ task: TaskSnapshot }>("GET", `/tasks/${taskId}`);
  print(payload.task, options);
}

export async function commandLogs(taskId: string | undefined, options: CliOptions) {
  if (!taskId) {
    throw new Error("logs requires a task id");
  }
  const payload = await apiRequest<{ task: TaskSnapshot }>("GET", `/tasks/${taskId}`);
  const events = payload.task.trace?.events ?? [];
  if (options.json) {
    print(events, options);
    return;
  }
  console.log(
    events.map((event) => `${event.createdAt}  ${event.role}/${event.type}  ${event.message}`).join("\n") ||
      "No trace events yet."
  );
}

export async function commandControl(positionals: string[], options: CliOptions) {
  const [taskId, action] = positionals;
  if (!taskId || !action) {
    throw new Error("control requires <task-id> and an action");
  }

  const payload = await apiRequest<{ task: TaskSnapshot }>("POST", `/tasks/${taskId}/control`, {
    action,
    note: options.note ?? null,
    reason: options.reason ?? null
  });
  print(payload.task, options);
}

export async function commandTeachStep(positionals: string[], options: CliOptions) {
  const [taskId] = positionals;
  if (!taskId || !options.action) {
    throw new Error("teach-step requires <task-id> and --action");
  }

  const params: Record<string, unknown> = {};
  if (options.target) {
    params.targetQuery = options.target;
  }
  if (options.text) {
    params.text = options.text;
  }
  if (options.url) {
    params.url = options.url;
  }
  if (options.app) {
    params.name = options.app;
  }

  const payload = await apiRequest<{ task: TaskSnapshot }>("POST", `/tasks/${taskId}/teach-steps`, {
    step: {
      action: options.action,
      surface: options.surface,
      label: options.label,
      params
    }
  });
  print(payload.task, options);
}
