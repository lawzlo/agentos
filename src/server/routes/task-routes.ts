import { json, readJsonBody } from "../http-utils.js";

export async function handleTaskRoutes({
  req,
  res,
  url,
  controlPlane
}: Record<string, any>) {
  if (req.method === "GET" && url.pathname === "/tasks") {
    json(res, 200, { tasks: controlPlane.listTasks(Number(url.searchParams.get("limit") ?? 50)) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/tasks") {
    const task = await controlPlane.createTask(await readJsonBody(req));
    json(res, 202, { task });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/tasks/preview") {
    const preview = await controlPlane.previewTask(await readJsonBody(req));
    json(res, 200, { preview });
    return true;
  }

  if (req.method === "POST" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/control")) {
    const taskId = url.pathname.split("/")[2];
    const body = await readJsonBody(req);
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
    } catch (error: any) {
      json(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/teach-steps")) {
    const taskId = url.pathname.split("/")[2];
    const body = await readJsonBody(req);

    try {
      const task = controlPlane.recordTaskTeachStep(taskId, body.step, {
        source: body.source ?? "user"
      });
      json(res, 200, { task });
    } catch (error: any) {
      json(res, 400, { error: error.message });
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
    const result = await controlPlane.ingestEvent(await readJsonBody(req));
    json(res, 202, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/policy/evaluate") {
    json(res, 200, { evaluation: controlPlane.evaluatePolicy(await readJsonBody(req)) });
    return true;
  }

  return false;
}
