import { json, readJsonBody } from "../http-utils.js";
import type { TaskSpec, RuntimeStep, ControlAction } from "../../types/runtime-schema.js";
import type { ApiRouteContext } from "../types.js";

interface ControlTaskBody {
  action?: ControlAction | string;
  source?: string;
  reason?: string | null;
  note?: string | null;
}

interface TeachStepBody {
  step: RuntimeStep;
  source?: string;
}

export async function handleTaskRoutes({
  req,
  res,
  url,
  controlPlane
}: ApiRouteContext): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/tasks") {
    json(res, 200, { tasks: controlPlane.listTasks(Number(url.searchParams.get("limit") ?? 50)) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/tasks") {
    const task = await controlPlane.createTask(await readJsonBody<TaskSpec>(req));
    json(res, 202, { task });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/tasks/preview") {
    const preview = await controlPlane.previewTask(await readJsonBody<TaskSpec>(req));
    json(res, 200, { preview });
    return true;
  }

  if (req.method === "POST" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/control")) {
    const taskId = url.pathname.split("/")[2];
    const body = await readJsonBody<ControlTaskBody>(req);
    if (!body.action) {
      json(res, 400, { error: "action is required" });
      return true;
    }

    try {
      const task = controlPlane.controlTask(taskId, body.action, {
        source: body.source ?? "user",
        reason: body.reason ?? null,
        note: body.note ?? null
      });
      json(res, 200, { task });
    } catch (error: unknown) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/teach-steps")) {
    const taskId = url.pathname.split("/")[2];
    const body = await readJsonBody<TeachStepBody>(req);

    try {
      const task = controlPlane.recordTaskTeachStep(taskId, body.step, {
        source: body.source ?? "user"
      });
      json(res, 200, { task });
    } catch (error: unknown) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname.startsWith("/tasks/")) {
    const taskId = url.pathname.split("/")[2];
    const task = controlPlane.getTask(taskId);
    if (!task) {
      json(res, 404, { error: "Task not found" });
      return true;
    }

    json(res, 200, { task });
    return true;
  }

  if (req.method === "GET" && url.pathname.startsWith("/traces/")) {
    const traceId = url.pathname.split("/")[2];
    const trace = controlPlane.getTrace(traceId);
    if (!trace) {
      json(res, 404, { error: "Trace not found" });
      return true;
    }

    json(res, 200, { trace });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    json(res, 200, { events: controlPlane.listEvents(Number(url.searchParams.get("limit") ?? 50)) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/events") {
    const result = await controlPlane.ingestEvent(await readJsonBody<Record<string, unknown>>(req));
    json(res, 202, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/policy/evaluate") {
    json(res, 200, { evaluation: controlPlane.evaluatePolicy(await readJsonBody<TaskSpec>(req)) });
    return true;
  }

  return false;
}
