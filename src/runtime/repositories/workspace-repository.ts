import {
  createId,
  hydrateWorkspace,
  hydrateWorkspaceProfile,
  nowIso
} from "./sqlite-helpers.js";

export class WorkspaceRepository {
  db: any;

  constructor(db: any) {
    this.db = db;
  }

  create(workspace: Record<string, any>) {
    this.db.prepare(`
      INSERT INTO workspaces (id, task_id, root_path, profile_path, downloads_path, artifacts_path, scratch_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      workspace.id,
      workspace.taskId,
      workspace.rootPath,
      workspace.profilePath,
      workspace.downloadsPath,
      workspace.artifactsPath,
      workspace.scratchPath,
      workspace.createdAt
    );

    return this.get(workspace.id);
  }

  get(id: string) {
    return hydrateWorkspace(this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id));
  }

  getByTask(taskId: string) {
    return hydrateWorkspace(this.db.prepare("SELECT * FROM workspaces WHERE task_id = ?").get(taskId));
  }

  putProfile(profile: Record<string, any>) {
    const row = {
      id: profile.id ?? createId("wsp"),
      name: profile.name,
      rootPath: profile.rootPath,
      profilePath: profile.profilePath,
      downloadsPath: profile.downloadsPath,
      artifactsPath: profile.artifactsPath,
      scratchPath: profile.scratchPath,
      metadata: profile.metadata ?? {},
      createdAt: profile.createdAt ?? nowIso(),
      updatedAt: nowIso()
    };

    this.db.prepare(`
      INSERT INTO workspace_profiles (
        id, name, root_path, profile_path, downloads_path, artifacts_path, scratch_path, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name)
      DO UPDATE SET
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `).run(
      row.id,
      row.name,
      row.rootPath,
      row.profilePath,
      row.downloadsPath,
      row.artifactsPath,
      row.scratchPath,
      JSON.stringify(row.metadata),
      row.createdAt,
      row.updatedAt
    );

    return this.getProfileByName(row.name);
  }

  getProfileByName(name: string) {
    return hydrateWorkspaceProfile(this.db.prepare("SELECT * FROM workspace_profiles WHERE name = ?").get(name));
  }

  listProfiles() {
    return this.db
      .prepare(`
        SELECT * FROM workspace_profiles
        ORDER BY name ASC
      `)
      .all()
      .map(hydrateWorkspaceProfile);
  }
}
