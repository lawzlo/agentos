import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ArtifactStore } from "../src/runtime/artifact-store.js";

function createFakeStore() {
  const artifacts: Array<{
    id: string;
    taskId: string;
    traceId: string | null;
    kind: string;
    label: string;
    path: string;
    metadata: Record<string, unknown>;
    createdAt: string;
  }> = [];
  return {
    artifacts,
    createArtifact(payload: Record<string, unknown>) {
      const record = {
        id: `artifact_${artifacts.length + 1}`,
        taskId: String(payload.taskId),
        traceId: typeof payload.traceId === "string" ? payload.traceId : null,
        kind: String(payload.kind),
        label: String(payload.label),
        path: String(payload.path),
        metadata: (payload.metadata ?? {}) as Record<string, unknown>,
        createdAt: new Date().toISOString()
      };
      artifacts.push(record);
      return record;
    },
    listArtifactsForTask(taskId: string) {
      return artifacts.filter((artifact) => artifact.taskId === taskId);
    }
  };
}

test("artifact store prunes oldest task artifacts beyond the per-task cap", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentos-artifacts-task-cap-"));
  const workspace = {
    id: "workspace_a",
    rootPath: path.join(tempDir, "workspace-profiles", "workspace-a"),
    artifactsPath: path.join(tempDir, "workspace-profiles", "workspace-a", "artifacts")
  };
  await fs.mkdir(workspace.artifactsPath, { recursive: true });
  const fakeStore = createFakeStore();
  const artifactStore = new ArtifactStore(fakeStore, {
    maxArtifactsPerTask: 2,
    workspaceArtifactLimitBytes: 1_000_000,
    globalArtifactLimitBytes: 1_000_000
  });

  const filePaths: string[] = [];
  for (const label of ["one", "two", "three"]) {
    const filePath = path.join(workspace.artifactsPath, `${label}.png`);
    await fs.writeFile(filePath, Buffer.from(label.repeat(8)));
    filePaths.push(filePath);
    await artifactStore.registerExistingFile({
      workspace,
      taskId: "task_a",
      traceId: null,
      kind: "screenshot",
      label,
      filePath
    });
  }

  assert.equal(await fs.access(filePaths[0]).then(() => true).catch(() => false), false);
  assert.equal(await fs.access(filePaths[1]).then(() => true).catch(() => false), true);
  assert.equal(await fs.access(filePaths[2]).then(() => true).catch(() => false), true);
});

test("artifact store prunes oldest files across workspaces when the global cap is exceeded", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentos-artifacts-global-cap-"));
  const fakeStore = createFakeStore();
  const artifactStore = new ArtifactStore(fakeStore, {
    maxArtifactsPerTask: 10,
    workspaceArtifactLimitBytes: 1_000_000,
    globalArtifactLimitBytes: 70
  });
  const workspaceA = {
    id: "workspace_a",
    rootPath: path.join(tempDir, "workspace-profiles", "workspace-a"),
    artifactsPath: path.join(tempDir, "workspace-profiles", "workspace-a", "artifacts")
  };
  const workspaceB = {
    id: "workspace_b",
    rootPath: path.join(tempDir, "workspace-profiles", "workspace-b"),
    artifactsPath: path.join(tempDir, "workspace-profiles", "workspace-b", "artifacts")
  };
  await fs.mkdir(workspaceA.artifactsPath, { recursive: true });
  await fs.mkdir(workspaceB.artifactsPath, { recursive: true });

  const oldFile = path.join(workspaceA.artifactsPath, "old.png");
  const newFile = path.join(workspaceB.artifactsPath, "new.png");
  await fs.writeFile(oldFile, Buffer.alloc(40, 1));
  await artifactStore.registerExistingFile({
    workspace: workspaceA,
    taskId: "task_old",
    traceId: null,
    kind: "screenshot",
    label: "old",
    filePath: oldFile
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await fs.writeFile(newFile, Buffer.alloc(40, 2));
  await artifactStore.registerExistingFile({
    workspace: workspaceB,
    taskId: "task_new",
    traceId: null,
    kind: "screenshot",
    label: "new",
    filePath: newFile
  });

  assert.equal(await fs.access(oldFile).then(() => true).catch(() => false), false);
  assert.equal(await fs.access(newFile).then(() => true).catch(() => false), true);

  const usage = await artifactStore.getUsage(workspaceB);
  assert.equal(usage.globalArtifactLimitBytes, 70);
  assert.ok((usage.globalArtifactBytes ?? 0) <= 70);
});
