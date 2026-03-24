import fs from "node:fs/promises";
import path from "node:path";

import { createId } from "./id.js";
import type { ControlPlaneStore } from "./store.js";
import type { ArtifactReference, ArtifactUsage } from "../types/runtime-schema.js";

const DEFAULT_MAX_ARTIFACTS_PER_TASK = 20;
const DEFAULT_WORKSPACE_ARTIFACT_BYTES = 500 * 1024 * 1024;
const DEFAULT_GLOBAL_ARTIFACT_BYTES = 3 * 1024 * 1024 * 1024;

interface ArtifactFileEntry {
  path: string;
  size: number;
  createdAtMs: number;
}

type ArtifactWorkspace = {
  id: string;
  rootPath: string;
  artifactsPath: string;
};

export class ArtifactStore {
  store: Pick<ControlPlaneStore, "createArtifact" | "listArtifactsForTask">;
  maxArtifactsPerTask: number;
  workspaceArtifactLimitBytes: number;
  globalArtifactLimitBytes: number;
  usageByWorkspace: Map<string, ArtifactUsage>;

  constructor(
    store: ArtifactStore["store"],
    {
      maxArtifactsPerTask = DEFAULT_MAX_ARTIFACTS_PER_TASK,
      workspaceArtifactLimitBytes = DEFAULT_WORKSPACE_ARTIFACT_BYTES,
      globalArtifactLimitBytes = DEFAULT_GLOBAL_ARTIFACT_BYTES
    }: {
      maxArtifactsPerTask?: number;
      workspaceArtifactLimitBytes?: number;
      globalArtifactLimitBytes?: number;
    } = {}
  ) {
    this.store = store;
    this.maxArtifactsPerTask = maxArtifactsPerTask;
    this.workspaceArtifactLimitBytes = workspaceArtifactLimitBytes;
    this.globalArtifactLimitBytes = globalArtifactLimitBytes;
    this.usageByWorkspace = new Map();
  }

  async #allocateFile(workspace: ArtifactWorkspace, kind: string, label: string, extension = "txt"): Promise<string> {
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
    workspace: ArtifactWorkspace;
    taskId: string;
    traceId: string | null;
    kind: string;
    label: string;
    content: string;
  }): Promise<ArtifactReference> {
    const targetPath = await this.#allocateFile(workspace, kind, label, "txt");
    await this.#enforceArtifactBudgets({ workspace, taskId });
    await fs.writeFile(targetPath, content, "utf8");
    const artifact = this.store.createArtifact({
      taskId,
      traceId,
      kind,
      label,
      path: targetPath,
      metadata: { encoding: "utf8" }
    });
    await this.#enforceArtifactBudgets({ workspace, taskId });
    return artifact;
  }

  async writeJson({
    workspace,
    taskId,
    traceId,
    kind,
    label,
    payload
  }: {
    workspace: ArtifactWorkspace;
    taskId: string;
    traceId: string | null;
    kind: string;
    label: string;
    payload: unknown;
  }): Promise<ArtifactReference> {
    const targetPath = await this.#allocateFile(workspace, kind, label, "json");
    await this.#enforceArtifactBudgets({ workspace, taskId });
    await fs.writeFile(targetPath, JSON.stringify(payload, null, 2), "utf8");
    const artifact = this.store.createArtifact({
      taskId,
      traceId,
      kind,
      label,
      path: targetPath,
      metadata: { encoding: "utf8", format: "json" }
    });
    await this.#enforceArtifactBudgets({ workspace, taskId });
    return artifact;
  }

  async registerExistingFile({
    workspace,
    taskId,
    traceId,
    kind,
    label,
    filePath,
    metadata = {}
  }: {
    workspace: ArtifactWorkspace;
    taskId: string;
    traceId: string | null;
    kind: string;
    label: string;
    filePath: string;
    metadata?: Record<string, unknown>;
  }): Promise<ArtifactReference> {
    await this.#enforceArtifactBudgets({ workspace, taskId });
    const artifact = this.store.createArtifact({
      taskId,
      traceId,
      kind,
      label,
      path: filePath,
      metadata
    });
    await this.#enforceArtifactBudgets({ workspace, taskId });
    return artifact;
  }

  async getUsage(workspace: ArtifactWorkspace): Promise<ArtifactUsage> {
    const usage = await this.#refreshUsage(workspace, 0);
    return {
      ...usage
    };
  }

  async #enforceArtifactBudgets({
    workspace,
    taskId
  }: {
    workspace: ArtifactWorkspace;
    taskId: string;
  }): Promise<void> {
    let prunedFiles = 0;
    prunedFiles += await this.#enforcePerTaskCap(taskId);
    prunedFiles += await this.#enforceWorkspaceCap(workspace);
    prunedFiles += await this.#enforceGlobalCap(workspace);
    await this.#refreshUsage(workspace, prunedFiles);
  }

  async #enforcePerTaskCap(taskId: string): Promise<number> {
    const artifacts = this.store.listArtifactsForTask(taskId);
    const existingArtifacts: ArtifactReference[] = [];
    for (const artifact of artifacts) {
      if (await this.#fileExists(artifact.path)) {
        existingArtifacts.push(artifact);
      }
    }

    if (existingArtifacts.length <= this.maxArtifactsPerTask) {
      return 0;
    }

    let pruned = 0;
    for (const artifact of existingArtifacts.slice(0, existingArtifacts.length - this.maxArtifactsPerTask)) {
      pruned += await this.#unlinkIfPresent(artifact.path);
    }
    return pruned;
  }

  async #enforceWorkspaceCap(workspace: ArtifactWorkspace): Promise<number> {
    if (!this.workspaceArtifactLimitBytes || this.workspaceArtifactLimitBytes <= 0) {
      return 0;
    }

    const entries = await this.#listArtifactFiles(workspace.artifactsPath);
    const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (totalBytes <= this.workspaceArtifactLimitBytes) {
      return 0;
    }

    return this.#pruneEntries(entries, totalBytes - this.workspaceArtifactLimitBytes);
  }

  async #enforceGlobalCap(workspace: ArtifactWorkspace): Promise<number> {
    if (!this.globalArtifactLimitBytes || this.globalArtifactLimitBytes <= 0) {
      return 0;
    }

    const artifactsRoot = path.dirname(workspace.rootPath);
    const workspaceNames = await fs.readdir(artifactsRoot, { withFileTypes: true }).catch(() => []);
    const artifactDirs = workspaceNames
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(artifactsRoot, entry.name, "artifacts"));

    const entries: ArtifactFileEntry[] = [];
    for (const artifactDir of artifactDirs) {
      entries.push(...(await this.#listArtifactFiles(artifactDir)));
    }

    const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (totalBytes <= this.globalArtifactLimitBytes) {
      return 0;
    }

    return this.#pruneEntries(entries, totalBytes - this.globalArtifactLimitBytes);
  }

  async #refreshUsage(workspace: ArtifactWorkspace, prunedFiles: number): Promise<ArtifactUsage> {
    const workspaceEntries = await this.#listArtifactFiles(workspace.artifactsPath);
    const workspaceArtifactBytes = workspaceEntries.reduce((sum, entry) => sum + entry.size, 0);

    let globalArtifactBytes: number | null = null;
    if (this.globalArtifactLimitBytes > 0) {
      const artifactsRoot = path.dirname(workspace.rootPath);
      const workspaceNames = await fs.readdir(artifactsRoot, { withFileTypes: true }).catch(() => []);
      let total = 0;
      for (const entry of workspaceNames) {
        if (!entry.isDirectory()) {
          continue;
        }
        const siblingEntries = await this.#listArtifactFiles(path.join(artifactsRoot, entry.name, "artifacts"));
        total += siblingEntries.reduce((sum, siblingEntry) => sum + siblingEntry.size, 0);
      }
      globalArtifactBytes = total;
    }

    const usage: ArtifactUsage = {
      workspaceArtifactBytes,
      workspaceArtifactLimitBytes: this.workspaceArtifactLimitBytes,
      globalArtifactBytes,
      globalArtifactLimitBytes: this.globalArtifactLimitBytes > 0 ? this.globalArtifactLimitBytes : null,
      prunedFiles
    };
    this.usageByWorkspace.set(workspace.id, usage);
    return usage;
  }

  async #listArtifactFiles(directory: string): Promise<ArtifactFileEntry[]> {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    const files: ArtifactFileEntry[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const filePath = path.join(directory, entry.name);
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat?.isFile()) {
        continue;
      }
      files.push({
        path: filePath,
        size: Number(stat.size ?? 0),
        createdAtMs: Number(stat.mtimeMs ?? stat.birthtimeMs ?? 0)
      });
    }

    return files.sort((left, right) => left.createdAtMs - right.createdAtMs);
  }

  async #pruneEntries(entries: ArtifactFileEntry[], bytesToFree: number): Promise<number> {
    let remaining = Math.max(0, bytesToFree);
    let pruned = 0;
    for (const entry of entries) {
      if (remaining <= 0) {
        break;
      }
      const removed = await this.#unlinkIfPresent(entry.path);
      if (removed > 0) {
        remaining -= entry.size;
        pruned += removed;
      }
    }
    return pruned;
  }

  async #unlinkIfPresent(filePath: string): Promise<number> {
    try {
      await fs.rm(filePath, { force: true });
      return 1;
    } catch {
      return 0;
    }
  }

  async #fileExists(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(filePath);
      return stat.isFile();
    } catch {
      return false;
    }
  }
}
