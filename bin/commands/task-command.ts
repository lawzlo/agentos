import {
  apiRequest,
  boolOption,
  formatTask,
  parseInputs,
  print,
  waitForTask
} from "../cli-utils.js";

export async function commandRun(positionals: string[], options: Record<string, any>) {
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
  const response = await apiRequest("POST", "/tasks", taskPayload);

  if (boolOption(options.wait)) {
    const task = await waitForTask(response.task.id, Number(options.timeout ?? 30000));
    print(task, options);
    return;
  }

  print(options.json ? response.task : `Queued ${response.task.id}`, options);
}

export async function commandDoctor(options: Record<string, any>) {
  const payload = await apiRequest("GET", "/doctor");
  print(payload.doctor, options);
}

export async function commandPs(options: Record<string, any>) {
  const payload = await apiRequest("GET", `/tasks?limit=${Number(options.limit ?? 20)}`);
  if (options.json) {
    print(payload.tasks, options);
    return;
  }
  console.log(payload.tasks.map(formatTask).join("\n") || "No tasks found.");
}

export async function commandInspect(taskId: string | undefined, options: Record<string, any>) {
  if (!taskId) {
    throw new Error("inspect requires a task id");
  }
  const payload = await apiRequest("GET", `/tasks/${taskId}`);
  print(payload.task, options);
}

export async function commandLogs(taskId: string | undefined, options: Record<string, any>) {
  if (!taskId) {
    throw new Error("logs requires a task id");
  }
  const payload = await apiRequest("GET", `/tasks/${taskId}`);
  const events = payload.task.trace?.events ?? [];
  if (options.json) {
    print(events, options);
    return;
  }
  console.log(
    events.map((event: Record<string, any>) => `${event.createdAt}  ${event.role}/${event.type}  ${event.message}`).join("\n") ||
      "No trace events yet."
  );
}

export async function commandControl(positionals: string[], options: Record<string, any>) {
  const [taskId, action] = positionals;
  if (!taskId || !action) {
    throw new Error("control requires <task-id> and an action");
  }

  const payload = await apiRequest("POST", `/tasks/${taskId}/control`, {
    action,
    note: options.note ?? null,
    reason: options.reason ?? null
  });
  print(payload.task, options);
}

export async function commandTeachStep(positionals: string[], options: Record<string, any>) {
  const [taskId] = positionals;
  if (!taskId || !options.action) {
    throw new Error("teach-step requires <task-id> and --action");
  }

  const params: Record<string, any> = {};
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

  const payload = await apiRequest("POST", `/tasks/${taskId}/teach-steps`, {
    step: {
      action: options.action,
      surface: options.surface,
      label: options.label,
      params
    }
  });
  print(payload.task, options);
}
