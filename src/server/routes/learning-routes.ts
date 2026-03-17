import { json } from "../http-utils.js";
import type { ApiRouteContext } from "../types.js";

export async function handleLearningRoutes({
  req,
  res,
  url,
  controlPlane
}: ApiRouteContext): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/learning/status") {
    json(res, 200, { learning: controlPlane.getLearningStatus() });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/learning/sources") {
    json(res, 200, { sources: controlPlane.listLearningSources() });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/memory/search") {
    json(res, 200, {
      chunks: controlPlane.searchMemory(url.searchParams.get("q") ?? "", Number(url.searchParams.get("limit") ?? 20))
    });
    return true;
  }

  if (req.method === "GET" && url.pathname.startsWith("/memory/entities/")) {
    const entityId = url.pathname.split("/")[3];
    const entity = controlPlane.inspectMemoryEntity(entityId);
    if (!entity) {
      json(res, 404, { error: "Memory entity not found" });
      return true;
    }
    json(res, 200, { entity });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/digests") {
    json(res, 200, { digests: controlPlane.listDigests(Number(url.searchParams.get("limit") ?? 30)) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/digests/run") {
    json(res, 200, { digest: await controlPlane.runDigest() });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/proposals") {
    json(res, 200, { proposals: controlPlane.listProposals(Number(url.searchParams.get("limit") ?? 50)) });
    return true;
  }

  if (req.method === "POST" && url.pathname.startsWith("/proposals/") && url.pathname.endsWith("/accept")) {
    const proposalId = url.pathname.split("/")[2];
    try {
      json(res, 200, { result: await controlPlane.acceptProposal(proposalId) });
    } catch (error: unknown) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname.startsWith("/proposals/") && url.pathname.endsWith("/reject")) {
    const proposalId = url.pathname.split("/")[2];
    try {
      json(res, 200, { proposal: controlPlane.rejectProposal(proposalId) });
    } catch (error: unknown) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  return false;
}

