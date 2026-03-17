import { json, readJsonBody } from "../http-utils.js";
import type { SkillDefinition } from "../../types/runtime-schema.js";
import type { ApiRouteContext } from "../types.js";

interface SkillFromTaskBody {
  taskId?: string;
  name?: string;
}

interface WorkspaceProfileBody {
  metadata?: Record<string, unknown>;
}

interface VaultPutBody {
  scope?: string;
  value?: string;
  metadata?: Record<string, unknown>;
}

export async function handleAdminRoutes({
  req,
  res,
  url,
  controlPlane
}: ApiRouteContext): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/skills") {
    json(res, 200, { skills: controlPlane.listSkills() });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/skills/from-task") {
    const body = await readJsonBody<SkillFromTaskBody>(req);
    if (!body.taskId || !body.name) {
      json(res, 400, { error: "taskId and name are required" });
      return true;
    }
    const skill = controlPlane.saveTaskAsSkill(body.taskId, body.name);
    json(res, 200, { skill });
    return true;
  }

  if (req.method === "GET" && url.pathname.startsWith("/skills/")) {
    const name = decodeURIComponent(url.pathname.split("/")[2] ?? "");
    const skill = controlPlane.getSkill(name);
    if (!skill) {
      json(res, 404, { error: "Skill not found" });
      return true;
    }
    json(res, 200, { skill });
    return true;
  }

  if (req.method === "PUT" && url.pathname.startsWith("/skills/")) {
    const name = decodeURIComponent(url.pathname.split("/")[2] ?? "");
    const body = await readJsonBody<Partial<SkillDefinition>>(req);
    const skill = controlPlane.putSkill({ ...body, name } as SkillDefinition);
    json(res, 200, { skill });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/workspace-profiles") {
    json(res, 200, { profiles: controlPlane.listWorkspaceProfiles() });
    return true;
  }

  if (req.method === "PUT" && url.pathname.startsWith("/workspace-profiles/")) {
    const name = decodeURIComponent(url.pathname.split("/")[2] ?? "");
    const body = await readJsonBody<WorkspaceProfileBody>(req);
    const profile = await controlPlane.prepareWorkspaceProfile(name, body.metadata ?? {});
    json(res, 200, { profile });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/vault/secrets") {
    json(res, 200, { secrets: controlPlane.listVaultSecrets(url.searchParams.get("scope") ?? "default") });
    return true;
  }

  if (req.method === "PUT" && url.pathname.startsWith("/vault/secrets/")) {
    const secretKey = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const body = await readJsonBody<VaultPutBody>(req);
    const secret = await controlPlane.putVaultSecret({
      scope: body.scope ?? "default",
      secretKey,
      value: body.value ?? "",
      metadata: body.metadata ?? {}
    });
    json(res, 200, { secret });
    return true;
  }

  if (req.method === "GET" && url.pathname.startsWith("/vault/secrets/")) {
    const secretKey = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const scope = url.searchParams.get("scope") ?? "default";
    const secret = await controlPlane.getVaultSecret(scope, secretKey);
    if (!secret) {
      json(res, 404, { error: "Secret not found" });
      return true;
    }
    json(res, 200, { secret });
    return true;
  }

  return false;
}
