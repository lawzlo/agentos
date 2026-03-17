import fs from "node:fs/promises";
import path from "node:path";

import { createId, nowIso } from "./id.js";
import type { ControlPlaneStore } from "./store.js";
import type { TaskSpec, WorkspaceProfile, WorkspaceRecord } from "../types/runtime-schema.js";

export class WorkspaceManager {
  store: Pick<
    ControlPlaneStore,
    "getWorkspaceByTask" | "createWorkspace" | "getWorkspaceProfileByName" | "putWorkspaceProfile" | "listWorkspaceProfiles"
  >;
  rootDir: string;
  profileRootDir: string;
  constructor(store: WorkspaceManager["store"], rootDir: string) {
    this.store = store;
    this.rootDir = path.join(rootDir, "workspaces");
    this.profileRootDir = path.join(rootDir, "workspace-profiles");
  }

  async prepare(taskId: string, taskSpec: TaskSpec = { goal: "" }): Promise<WorkspaceRecord> {
    const existing = this.store.getWorkspaceByTask(taskId);
    if (existing) {
      return existing;
    }

    if (taskSpec.workspaceName) {
      const profile = await this.prepareProfile(taskSpec.workspaceName, {});
      const workspace = {
        id: createId("ws"),
        taskId,
        rootPath: profile.rootPath,
        profilePath: profile.profilePath,
        downloadsPath: profile.downloadsPath,
        artifactsPath: profile.artifactsPath,
        scratchPath: profile.scratchPath,
        createdAt: nowIso()
      };

      return this.store.createWorkspace(workspace);
    }

    const workspace = {
      id: createId("ws"),
      taskId,
      rootPath: path.join(this.rootDir, createId("work")),
      profilePath: "",
      downloadsPath: "",
      artifactsPath: "",
      scratchPath: "",
      createdAt: nowIso()
    };

    workspace.profilePath = path.join(workspace.rootPath, "profile");
    workspace.downloadsPath = path.join(workspace.rootPath, "downloads");
    workspace.artifactsPath = path.join(workspace.rootPath, "artifacts");
    workspace.scratchPath = path.join(workspace.rootPath, "scratch");

    await Promise.all([
      fs.mkdir(workspace.profilePath, { recursive: true }),
      fs.mkdir(workspace.downloadsPath, { recursive: true }),
      fs.mkdir(workspace.artifactsPath, { recursive: true }),
      fs.mkdir(workspace.scratchPath, { recursive: true })
    ]);

    return this.store.createWorkspace(workspace);
  }

  async prepareProfile(name: string, metadata: Record<string, unknown> = {}): Promise<WorkspaceProfile> {
    const existing = this.store.getWorkspaceProfileByName(name);
    if (existing) {
      return existing;
    }

    const safeName = String(name).trim().toLowerCase().replaceAll(/[^a-z0-9-]+/g, "-") || createId("profile");
    const rootPath = path.join(this.profileRootDir, safeName);
    const timestamp = nowIso();
    const profile = {
      id: createId("wsp"),
      name,
      rootPath,
      profilePath: path.join(rootPath, "profile"),
      downloadsPath: path.join(rootPath, "downloads"),
      artifactsPath: path.join(rootPath, "artifacts"),
      scratchPath: path.join(rootPath, "scratch"),
      metadata,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    await Promise.all([
      fs.mkdir(profile.profilePath, { recursive: true }),
      fs.mkdir(profile.downloadsPath, { recursive: true }),
      fs.mkdir(profile.artifactsPath, { recursive: true }),
      fs.mkdir(profile.scratchPath, { recursive: true })
    ]);

    return this.store.putWorkspaceProfile(profile);
  }

  listProfiles(): WorkspaceProfile[] {
    return this.store.listWorkspaceProfiles();
  }
}
