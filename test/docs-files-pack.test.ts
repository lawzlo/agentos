import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { createTempDir, startAgentServer, startDocsFilesFixtureServer, waitForTask } from "./helpers.js";

test("browser download workflow can save a file into the managed workspace downloads directory", async () => {
  const dataDir = await createTempDir();
  const fixture = await startDocsFilesFixtureServer();
  const server = await startAgentServer({ dataDir });

  try {
    const createResponse = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Download the report file from the browser workspace.",
        preferredSurface: "browser",
        skillName: "browser-download-file",
        workspaceName: "docs-main",
        inputs: {
          startUrl: `${fixture.url}/docs`,
          downloadTarget: "Download report",
          downloadFileName: "report.txt"
        }
      })
    });
    const { task } = await createResponse.json();

    const completed = await waitForTask(server.baseUrl, task.id, (current) => current.status === "completed");
    assert.equal(completed.status, "completed");
    assert.equal(completed.result.outputs.download.fileName, "report.txt");

    const downloadedFilePath = path.join(dataDir, "workspace-profiles", "docs-main", "downloads", "report.txt");
    const content = await fs.readFile(downloadedFilePath, "utf8");
    assert.match(content, /Quarterly report/);
  } finally {
    await fixture.close();
    await server.close();
  }
});

test("browser docs/files heuristic flow can upload a local file and save an edited document", async () => {
  const dataDir = await createTempDir();
  const fixture = await startDocsFilesFixtureServer();
  const server = await startAgentServer({ dataDir });
  const uploadFilePath = path.join(dataDir, "sample-upload.txt");
  await fs.writeFile(uploadFilePath, "Upload from AgentOS", "utf8");

  try {
    const createResponse = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Handle the docs workspace end to end.",
        preferredSurface: "browser",
        inputs: {
          startUrl: `${fixture.url}/docs`,
          uploadTarget: "Upload file",
          uploadPath: uploadFilePath,
          documentTarget: "Document editor",
          documentText: "Updated project brief from AgentOS",
          saveTarget: "Save document"
        }
      })
    });
    const { task } = await createResponse.json();

    const completed = await waitForTask(server.baseUrl, task.id, (current) => current.status === "completed");
    assert.equal(completed.status, "completed");

    const state = await fixture.getState();
    assert.equal(state.uploadedFileName, "sample-upload.txt");
    assert.equal(state.uploadedFileContent, "Upload from AgentOS");
    assert.equal(state.savedDocument, "Updated project brief from AgentOS");
  } finally {
    await fixture.close();
    await server.close();
  }
});

test("desktop local file actions can write, copy, move, and read files without desktop UI automation", async () => {
  const dataDir = await createTempDir();
  const server = await startAgentServer({ dataDir });

  try {
    const createResponse = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Run the prepared desktop file workflow.",
        preferredSurface: "desktop",
        workspaceName: "docs-local",
        steps: [
          {
            label: "Write source file",
            surface: "desktop",
            action: "writeFileText",
            params: { path: "workspace/source.txt", text: "Draft A" },
            checkpoint: false
          },
          {
            label: "Copy source file",
            surface: "desktop",
            action: "copyFile",
            params: { from: "workspace/source.txt", to: "workspace/copied.txt" },
            checkpoint: false
          },
          {
            label: "Move copied file",
            surface: "desktop",
            action: "moveFile",
            params: { from: "workspace/copied.txt", to: "archive/final.txt" },
            checkpoint: false
          },
          {
            label: "Read final file",
            surface: "desktop",
            action: "readFileText",
            params: { path: "archive/final.txt" },
            saveAs: "fileContent",
            checkpoint: false
          }
        ]
      })
    });
    const { task } = await createResponse.json();

    const completed = await waitForTask(server.baseUrl, task.id, (current) => current.status === "completed");
    assert.equal(completed.status, "completed");
    assert.equal(completed.result.outputs.fileContent.text, "Draft A");

    const workspaceRoot = path.join(dataDir, "workspace-profiles", "docs-local");
    const finalFilePath = path.join(workspaceRoot, "archive", "final.txt");
    const finalContent = await fs.readFile(finalFilePath, "utf8");
    assert.equal(finalContent, "Draft A");
  } finally {
    await server.close();
  }
});
