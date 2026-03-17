import fs from "node:fs/promises";
import path from "node:path";

import { createId } from "./id.js";
import type { ControlPlaneStore } from "./store.js";
import type { ArtifactReference, WorkspaceRecord } from "../types/runtime-schema.js";

export class ArtifactStore {
  store: Pick<ControlPlaneStore, "createArtifact">;
  constructor(store: ArtifactStore["store"]) {
    this.store = store;
  }

  async #allocateFile(workspace: WorkspaceRecord, kind: string, label: string, extension = "txt"): Promise<string> {
    const safeLabel = label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "");
    const fileName = `${Date.now()}-${safeLabel || createId(kind)}.${extension}`;
    const targetPath = path.join(workspace.artifactsPath, fileName);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    return targetPath;
  }

  async writeText({
    workspace,
    taskId,
    traceId,
    kind,
    label,
    content
  }: {
    workspace: WorkspaceRecord;
    taskId: string;
    traceId: string | null;
    kind: string;
    label: string;
    content: string;
  }): Promise<ArtifactReference> {
    const targetPath = await this.#allocateFile(workspace, kind, label, "txt");
    await fs.writeFile(targetPath, content, "utf8");
    return this.store.createArtifact({
      taskId,
      traceId,
      kind,
      label,
      path: targetPath,
      metadata: { encoding: "utf8" }
    });
  }

  async writeJson({
    workspace,
    taskId,
    traceId,
    kind,
    label,
    payload
  }: {
    workspace: WorkspaceRecord;
    taskId: string;
    traceId: string | null;
    kind: string;
    label: string;
    payload: unknown;
  }): Promise<ArtifactReference> {
    const targetPath = await this.#allocateFile(workspace, kind, label, "json");
    await fs.writeFile(targetPath, JSON.stringify(payload, null, 2), "utf8");
    return this.store.createArtifact({
      taskId,
      traceId,
      kind,
      label,
      path: targetPath,
      metadata: { encoding: "utf8", format: "json" }
    });
  }

  async registerExistingFile({
    taskId,
    traceId,
    kind,
    label,
    filePath,
    metadata = {}
  }: {
    taskId: string;
    traceId: string | null;
    kind: string;
    label: string;
    filePath: string;
    metadata?: Record<string, unknown>;
  }): Promise<ArtifactReference> {
    return this.store.createArtifact({
      taskId,
      traceId,
      kind,
      label,
      path: filePath,
      metadata
    });
  }
}
