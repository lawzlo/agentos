import { json, readJsonBody } from "../http-utils.js";
import type { WatchRuleInput } from "../../runtime/watch-rule-parser.js";
import type { ApiRouteContext } from "../types.js";

interface WatchFromTaskBody extends Record<string, unknown> {
  taskId?: string;
}

interface DraftRejectBody {
  reason?: string | null;
}

export async function handleWatchRoutes({
  req,
  res,
  url,
  controlPlane
}: ApiRouteContext): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/connectors") {
    json(res, 200, { connectors: controlPlane.listConnectors(), livePacks: controlPlane.listLivePacks() });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/packs") {
    json(res, 200, { packs: await controlPlane.listLivePackInfo() });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/watches") {
    json(res, 200, { watches: controlPlane.listWatchRules() });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/watches/from-task") {
    try {
      const body = await readJsonBody<WatchFromTaskBody>(req);
      if (!body.taskId) {
        json(res, 400, { error: "taskId is required" });
        return true;
      }
      const watch = controlPlane.saveTaskAsWatchRule(body.taskId, body);
      json(res, 200, { watch });
    } catch (error: unknown) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/watches") {
    try {
      const watch = controlPlane.createWatchRule(await readJsonBody<WatchRuleInput>(req));
      json(res, 201, { watch });
    } catch (error: unknown) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname.startsWith("/watches/")) {
    if (url.pathname.endsWith("/health")) {
      const watchRuleId = url.pathname.split("/")[2];
      try {
        json(res, 200, { health: controlPlane.getWatchHealth(watchRuleId) });
      } catch (error: unknown) {
        json(res, 404, { error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }

    const watchRuleId = url.pathname.split("/")[2];
    const watch = controlPlane.getWatchRule(watchRuleId);
    if (!watch) {
      json(res, 404, { error: "Watch rule not found" });
      return true;
    }
    json(res, 200, { watch });
    return true;
  }

  if (req.method === "POST" && url.pathname.startsWith("/watches/") && /\/(enable|disable|retry)$/.test(url.pathname)) {
    const watchRuleId = url.pathname.split("/")[2];
    const action = url.pathname.split("/")[3];
    try {
      const watch =
        action === "enable"
          ? controlPlane.enableWatchRule(watchRuleId)
          : action === "disable"
            ? controlPlane.disableWatchRule(watchRuleId)
            : controlPlane.retryWatchRule(watchRuleId);
      json(res, 200, { watch });
    } catch (error: unknown) {
      json(res, 404, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/watches/")) {
    const watchRuleId = url.pathname.split("/")[2];
    try {
      await controlPlane.deleteWatchRule(watchRuleId);
      json(res, 200, { ok: true });
    } catch (error: unknown) {
      json(res, 404, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/drafts") {
    json(res, 200, { drafts: controlPlane.listDrafts(Number(url.searchParams.get("limit") ?? 50)) });
    return true;
  }

  if (req.method === "GET" && url.pathname.startsWith("/drafts/")) {
    const draftId = url.pathname.split("/")[2];
    if (url.pathname.endsWith("/approve")) {
      json(res, 405, { error: "Use POST /drafts/:id/approve" });
      return true;
    }
    if (url.pathname.endsWith("/reject")) {
      json(res, 405, { error: "Use POST /drafts/:id/reject" });
      return true;
    }
    const draft = controlPlane.getDraft(draftId);
    if (!draft) {
      json(res, 404, { error: "Draft not found" });
      return true;
    }
    json(res, 200, { draft });
    return true;
  }

  if (req.method === "POST" && url.pathname.startsWith("/drafts/") && url.pathname.endsWith("/approve")) {
    const draftId = url.pathname.split("/")[2];
    try {
      const draft = await controlPlane.approveDraft(draftId);
      json(res, 200, { draft });
    } catch (error: unknown) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname.startsWith("/drafts/") && url.pathname.endsWith("/reject")) {
    const draftId = url.pathname.split("/")[2];
    const body = await readJsonBody<DraftRejectBody>(req);
    try {
      const draft = controlPlane.rejectDraft(draftId, body.reason ?? null);
      json(res, 200, { draft });
    } catch (error: unknown) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  return false;
}
