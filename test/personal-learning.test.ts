import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ControlPlaneStore } from "../src/runtime/store.js";
import type { ProposalRecord } from "../src/types/learning.js";
import { createTempDir, startAgentServer, startModelServer, waitForTask } from "./helpers.js";

const execFileAsync = promisify(execFile);

interface LearningSourcePayload {
  kind: string;
  config: Record<string, unknown>;
  state: Record<string, unknown>;
}

async function waitForValue<T>(loader: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 10000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await loader();
    if (predicate(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Timed out waiting for condition");
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  return response.json() as Promise<T>;
}

test("learning indexes selective file content and creates a review proposal", async () => {
  const dataDir = await createTempDir();
  const learnRoot = path.join(dataDir, "learn-root");
  await fs.mkdir(learnRoot, { recursive: true });
  const server = await startAgentServer({
    dataDir,
    learning: {
      metadataRoots: [learnRoot],
      contentRoots: [learnRoot],
      excludedPaths: [path.join(learnRoot, "node_modules")],
      scanIntervalMs: 100,
      maxFilesPerScan: 100,
      maxDepth: 4
    }
  });

  try {
    await fs.writeFile(path.join(learnRoot, "todo.md"), "TODO review contract renewal before Friday", "utf8");

    const memoryPayload = await waitForValue(
      async () =>
        fetchJson<{ chunks: Array<{ content: string }> }>(
          `${server.baseUrl}/memory/search?q=${encodeURIComponent("contract renewal")}`
        ),
      (payload) => payload.chunks.length > 0
    );
    assert.match(memoryPayload.chunks[0].content, /contract renewal/i);

    const proposalsPayload = await waitForValue(
      async () => fetchJson<{ proposals: ProposalRecord[] }>(`${server.baseUrl}/proposals`),
      (payload) => payload.proposals.some((proposal) => proposal.type === "review" && proposal.status === "pending")
    );
    assert.ok(proposalsPayload.proposals.some((proposal) => proposal.type === "review"));

    const learningPayload = await fetchJson<{ learning: { observationCount: number; chunkCount: number } }>(
      `${server.baseUrl}/learning/status`
    );
    assert.ok(learningPayload.learning.observationCount >= 2);
    assert.ok(learningPayload.learning.chunkCount >= 1);
  } finally {
    await server.close();
  }
});

test("learning ignores excluded noisy directories during filesystem scans", async () => {
  const dataDir = await createTempDir();
  const learnRoot = path.join(dataDir, "learn-root");
  await fs.mkdir(path.join(learnRoot, "node_modules"), { recursive: true });
  const server = await startAgentServer({
    dataDir,
    learning: {
      metadataRoots: [learnRoot],
      contentRoots: [learnRoot],
      excludedPaths: [path.join(learnRoot, "node_modules")],
      scanIntervalMs: 100,
      maxFilesPerScan: 100,
      maxDepth: 4
    }
  });

  try {
    await fs.writeFile(path.join(learnRoot, "node_modules", "ignored.md"), "reply to ignored note", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 600));
    const payload = await fetchJson<{ chunks: Array<{ content: string }> }>(
      `${server.baseUrl}/memory/search?q=${encodeURIComponent("ignored note")}`
    );
    assert.equal(payload.chunks.length, 0);
  } finally {
    await server.close();
  }
});

test("learned message observations create proposals that can be accepted into tasks", async () => {
  const dataDir = await createTempDir();
  const learnRoot = path.join(dataDir, "learn-root");
  await fs.mkdir(learnRoot, { recursive: true });
  const server = await startAgentServer({
    dataDir,
    learning: {
      metadataRoots: [learnRoot],
      contentRoots: [learnRoot],
      excludedPaths: [],
      scanIntervalMs: 100,
      maxFilesPerScan: 100,
      maxDepth: 2
    }
  });

  try {
    await fetch(`${server.baseUrl}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "message",
        source: "mailbox",
        payload: {
          subject: "Pricing follow up",
          body: "Can you reply to the pricing question from Acme?"
        }
      })
    });

    const proposalsPayload = await waitForValue(
      async () => fetchJson<{ proposals: ProposalRecord[] }>(`${server.baseUrl}/proposals`),
      (payload) => payload.proposals.some((proposal) => proposal.type === "reply")
    );
    const proposal = proposalsPayload.proposals.find((entry) => entry.type === "reply") as ProposalRecord;

    const acceptPayload = await fetchJson<{ result: { proposal: ProposalRecord; taskId: string } }>(
      `${server.baseUrl}/proposals/${proposal.id}/accept`,
      { method: "POST" }
    );
    assert.equal(acceptPayload.result.proposal.status, "accepted");
    assert.ok(acceptPayload.result.taskId);

    const taskPayload = await fetchJson<{ task: { id: string; goal: string } }>(
      `${server.baseUrl}/tasks/${acceptPayload.result.taskId}`
    );
    assert.match(taskPayload.task.goal, /reply|review/i);
  } finally {
    await server.close();
  }
});

test("manual corrections are learned into preference memory after task completion", async () => {
  const dataDir = await createTempDir();
  const learnRoot = path.join(dataDir, "learn-root");
  await fs.mkdir(learnRoot, { recursive: true });
  const server = await startAgentServer({
    dataDir,
    learning: {
      metadataRoots: [learnRoot],
      contentRoots: [learnRoot],
      excludedPaths: [],
      scanIntervalMs: 100,
      maxFilesPerScan: 100,
      maxDepth: 2
    }
  });

  try {
    const createResponse = await fetchJson<{ task: { id: string } }>(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Pause long enough to record a correction",
        preferredSurface: "desktop",
        steps: [
          {
            label: "Wait one",
            surface: "desktop",
            action: "wait",
            params: { ms: 250 },
            checkpoint: false
          },
          {
            label: "Wait two",
            surface: "desktop",
            action: "wait",
            params: { ms: 250 },
            checkpoint: false
          }
        ]
      })
    });

    await waitForValue(
      async () => fetchJson<{ task: { status: string } }>(`${server.baseUrl}/tasks/${createResponse.task.id}`),
      (payload) => payload.task.status === "running"
    );

    await fetch(`${server.baseUrl}/tasks/${createResponse.task.id}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "request_takeover",
        note: "Prefer shorter desktop responses."
      })
    });
    await fetch(`${server.baseUrl}/tasks/${createResponse.task.id}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "return_to_agent",
        note: "Use concise follow-ups."
      })
    });

    await waitForTask(server.baseUrl, createResponse.task.id, (task) => task.status === "completed");

    const store = new ControlPlaneStore(path.join(dataDir, "agentos.sqlite"));
    try {
      const preferenceEntity = store
        .listMemoryEntities(50)
        .find((entity) => entity.type === "preference" && entity.key === "surface:desktop");
      assert.ok(preferenceEntity);
      const snapshot = store.getMemoryEntitySnapshot(preferenceEntity!.id);
      assert.ok(snapshot?.facts.some((fact) => JSON.stringify(fact.value).includes("Prefer shorter desktop responses")));
    } finally {
      store.close();
    }
  } finally {
    await server.close();
  }
});

test("learned manual reply corrections are passed into later live-pack reply drafts", async () => {
  const dataDir = await createTempDir();
  const modelRequests: Array<Record<string, unknown>> = [];
  const model = await startModelServer(async (body) => {
    modelRequests.push(body as Record<string, unknown>);
    return {
      replyText: "Short follow-up from learned preferences.",
      confidence: 0.91,
      rationale: "used learned style"
    };
  });
  const server = await startAgentServer({
    dataDir,
    model: {
      baseUrl: model.baseUrl,
      apiKey: "test-key",
      name: "fake-model",
      timeoutMs: 5000
    },
    learning: {
      metadataRoots: [dataDir],
      contentRoots: [dataDir],
      excludedPaths: [],
      scanIntervalMs: 100,
      maxFilesPerScan: 100,
      maxDepth: 2
    }
  });

  try {
    const watch = server.app.controlPlane.createWatchRule({
      goal: "Always watch email and reply to unread messages",
      preferredSurface: "browser",
      workspaceName: "mail-learning-main",
      livePack: "generic-mail-browser",
      enabled: false,
      inputs: {
        startUrl: "https://mail.example.test"
      }
    });
    assert.ok(watch);

    const taskResponse = await fetchJson<{ task: { id: string } }>(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Pause long enough to record a mail reply correction",
        preferredSurface: "browser",
        inputs: {
          watchRuleId: watch!.id,
          typeTarget: "Reply box",
          sendTarget: "Send",
          typeText: "Draft a short follow-up"
        },
        steps: [
          {
            label: "Wait one",
            surface: "browser",
            action: "wait",
            params: { ms: 250 },
            checkpoint: false
          },
          {
            label: "Wait two",
            surface: "browser",
            action: "wait",
            params: { ms: 250 },
            checkpoint: false
          }
        ]
      })
    });

    await waitForValue(
      async () => fetchJson<{ task: { status: string } }>(`${server.baseUrl}/tasks/${taskResponse.task.id}`),
      (payload) => payload.task.status === "running"
    );

    await fetch(`${server.baseUrl}/tasks/${taskResponse.task.id}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "request_takeover",
        note: "Keep future mail replies concise and direct."
      })
    });
    await fetch(`${server.baseUrl}/tasks/${taskResponse.task.id}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "return_to_agent",
        note: "Keep future mail replies concise and direct."
      })
    });

    await waitForTask(server.baseUrl, taskResponse.task.id, (task) => task.status === "completed");

    await waitForValue(
      async () => {
        const store = new ControlPlaneStore(path.join(dataDir, "agentos.sqlite"));
        try {
          return store.listMemoryEntities(50).some((entity) => entity.key === "reply-style:generic-mail-browser");
        } finally {
          store.close();
        }
      },
      Boolean
    );

    const draft = await server.app.controlPlane.watchExecutionService.draftReply({
      watchRule: watch!,
      detection: {
        summary: "Customer: Can you send a brief pricing update?",
        context: [
          "Customer: Can you send a brief pricing update?",
          "Need a reply that acknowledges the request."
        ]
      },
      pack: server.app.controlPlane.livePackRegistry.get("generic-mail-browser")!
    });

    assert.equal(draft.replyText, "Short follow-up from learned preferences.");
    assert.equal(Array.isArray(draft.metadata.stylePreferences), true);
    assert.equal(
      (draft.metadata.stylePreferences as string[]).some((entry) => /concise and direct/i.test(entry)),
      true
    );
    assert.equal(modelRequests.length > 0, true);

    const userMessage = (modelRequests.at(-1)?.messages as Array<{ role?: string; content?: string }> | undefined)?.find(
      (entry) => entry.role === "user"
    );
    const modelPayload = JSON.parse(String(userMessage?.content ?? "{}"));
    assert.equal(Array.isArray(modelPayload.stylePreferences), true);
    assert.equal(
      modelPayload.stylePreferences.some((entry: string) => /concise and direct/i.test(entry)),
      true
    );
  } finally {
    await server.close();
    await model.close();
  }
});

test("daily digests are idempotent and proposals survive daemon restarts", async () => {
  const dataDir = await createTempDir();
  const learnRoot = path.join(dataDir, "learn-root");
  await fs.mkdir(learnRoot, { recursive: true });
  let server = await startAgentServer({
    dataDir,
    learning: {
      metadataRoots: [learnRoot],
      contentRoots: [learnRoot],
      excludedPaths: [],
      scanIntervalMs: 100,
      maxFilesPerScan: 100,
      maxDepth: 2
    }
  });

  try {
    await fetch(`${server.baseUrl}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "message",
        source: "slack",
        payload: {
          body: "Can you reply to the migration question?"
        }
      })
    });

    const proposalPayload = await waitForValue(
      async () => fetchJson<{ proposals: ProposalRecord[] }>(`${server.baseUrl}/proposals`),
      (payload) => payload.proposals.length > 0
    );
    const proposalId = proposalPayload.proposals[0].id;

    const firstDigest = await fetchJson<{ digest: { id: string; digestDate: string } }>(
      `${server.baseUrl}/digests/run`,
      { method: "POST" }
    );
    const secondDigest = await fetchJson<{ digest: { id: string; digestDate: string } }>(
      `${server.baseUrl}/digests/run`,
      { method: "POST" }
    );
    assert.equal(firstDigest.digest.digestDate, secondDigest.digest.digestDate);

    await server.close();
    server = await startAgentServer({
      dataDir,
      learning: {
        metadataRoots: [learnRoot],
        contentRoots: [learnRoot],
        excludedPaths: [],
        scanIntervalMs: 100,
        maxFilesPerScan: 100,
        maxDepth: 2
      }
    });

    const restartedPayload = await fetchJson<{ proposals: ProposalRecord[] }>(`${server.baseUrl}/proposals`);
    assert.ok(restartedPayload.proposals.some((proposal) => proposal.id === proposalId));

    const digestsPayload = await fetchJson<{ digests: Array<{ digestDate: string }> }>(`${server.baseUrl}/digests`);
    assert.equal(digestsPayload.digests.length, 1);
  } finally {
    await server.close();
  }
});

test("learning sources expose roots, exclusions, and scan metadata", async () => {
  const dataDir = await createTempDir();
  const learnRoot = path.join(dataDir, "learn-root");
  const excludedPath = path.join(learnRoot, "node_modules");
  await fs.mkdir(excludedPath, { recursive: true });
  const server = await startAgentServer({
    dataDir,
    learning: {
      metadataRoots: [learnRoot],
      contentRoots: [learnRoot],
      excludedPaths: [excludedPath],
      textExtensions: ["txt", "md"],
      scanIntervalMs: 100,
      maxFilesPerScan: 100,
      maxDepth: 4
    }
  });

  try {
    const sourcesPayload = await waitForValue(
      async () => fetchJson<{ sources: LearningSourcePayload[] }>(`${server.baseUrl}/learning/sources`),
      (payload) => payload.sources.length >= 5
    );

    const metadataSource = sourcesPayload.sources.find((entry) => entry.kind === "filesystem-metadata");
    const contentSource = sourcesPayload.sources.find((entry) => entry.kind === "filesystem-content");
    assert.ok(metadataSource);
    assert.ok(contentSource);
    assert.deepEqual(metadataSource.config.roots, [learnRoot]);
    assert.deepEqual(metadataSource.config.excludedPaths, [excludedPath]);
    assert.deepEqual(contentSource.config.roots, [learnRoot]);
    assert.deepEqual(contentSource.config.textExtensions, ["txt", "md"]);
  } finally {
    await server.close();
  }
});

test("learning scans update source states and can be queried through the API", async () => {
  const dataDir = await createTempDir();
  const learnRoot = path.join(dataDir, "learn-root");
  await fs.mkdir(learnRoot, { recursive: true });
  const server = await startAgentServer({
    dataDir,
    learning: {
      metadataRoots: [learnRoot],
      contentRoots: [learnRoot],
      excludedPaths: [],
      scanIntervalMs: 100,
      maxFilesPerScan: 100,
      maxDepth: 4
    }
  });

  try {
    await fs.writeFile(path.join(learnRoot, "notes.txt"), "Learning scan state should be updated.", "utf8");

    const payload = await waitForValue(
      async () =>
        fetchJson<{ sources: Array<{ kind: string; state: Record<string, unknown> }> }>(
          `${server.baseUrl}/learning/sources`
        ),
      (response) => {
        const metadataSource = response.sources.find((entry) => entry.kind === "filesystem-metadata");
        const contentSource = response.sources.find((entry) => entry.kind === "filesystem-content");
        return Boolean(
          metadataSource?.state?.scannedCount &&
            Number(metadataSource.state.scannedCount) >= 1 &&
            contentSource?.state?.scannedCount &&
            Number(contentSource.state.scannedCount) >= 1
        );
      }
    );

    const metadataState = payload.sources.find((entry) => entry.kind === "filesystem-metadata")?.state;
    const contentState = payload.sources.find((entry) => entry.kind === "filesystem-content")?.state;
    assert.equal(typeof metadataState?.scannedCount, "number");
    assert.equal(typeof contentState?.scannedCount, "number");
  } finally {
    await server.close();
  }
});

test("cli learn sources ls exposes filesystem learning source kinds", async () => {
  const dataDir = await createTempDir();
  const learnRoot = path.join(dataDir, "learn-root");
  await fs.mkdir(learnRoot, { recursive: true });
  const server = await startAgentServer({
    dataDir,
    learning: {
      metadataRoots: [learnRoot],
      contentRoots: [learnRoot],
      excludedPaths: [],
      scanIntervalMs: 100,
      maxFilesPerScan: 100,
      maxDepth: 4
    }
  });

  try {
    const env = {
      ...process.env,
      AGENTOS_BASE_URL: server.baseUrl,
      AGENTOS_DATA_DIR: dataDir
    };

    const learnResult = await execFileAsync(
      process.execPath,
      ["dist/bin/agentos.js", "learn", "sources", "ls", "--json"],
      {
        cwd: process.cwd(),
        env
      }
    );

    const sources = JSON.parse(learnResult.stdout) as Array<{ kind: string }>;
    assert.ok(sources.some((entry) => entry.kind === "filesystem-metadata"));
    assert.ok(sources.some((entry) => entry.kind === "filesystem-content"));
    assert.ok(sources.some((entry) => entry.kind === "watch-events"));
  } finally {
    await server.close();
  }
});

test("events can create tasks through embedded taskSpec", async () => {
  const dataDir = await createTempDir();
  const server = await startAgentServer({ dataDir });

  try {
    const eventPayload = {
      type: "automation.request",
      source: "test-suite",
      payload: {
        taskSpec: {
          goal: "Process automated event task",
          preferredSurface: "desktop",
          steps: [
            {
              label: "Pause",
              surface: "desktop",
              action: "wait",
              params: {
                ms: 50
              },
              checkpoint: false
            }
          ]
        }
      }
    };

    const eventResponse = await fetchJson<{
      event: { id: string; taskId: string | null };
      task: { id: string } | null;
    }>(`${server.baseUrl}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(eventPayload)
    });

    assert.ok(eventResponse.task?.id);
    assert.equal(eventResponse.event.taskId, eventResponse.task!.id);

    const completedTask = await waitForTask(server.baseUrl, eventResponse.task.id, (task) => task.status === "completed");
    assert.equal(completedTask.goal.includes("Process automated event task"), true);
  } finally {
    await server.close();
  }
});

test("memory search respects limit parameter", async () => {
  const dataDir = await createTempDir();
  const learnRoot = path.join(dataDir, "learn-root");
  await fs.mkdir(learnRoot, { recursive: true });
  const payloadText = "agentos marker token";
  await fs.writeFile(path.join(learnRoot, "a.txt"), `first ${payloadText}`, "utf8");
  await fs.writeFile(path.join(learnRoot, "b.txt"), `second ${payloadText}`, "utf8");
  await fs.writeFile(path.join(learnRoot, "c.txt"), `third ${payloadText}`, "utf8");
  const server = await startAgentServer({
    dataDir,
    learning: {
      metadataRoots: [learnRoot],
      contentRoots: [learnRoot],
      excludedPaths: [],
      scanIntervalMs: 100,
      maxFilesPerScan: 100,
      maxDepth: 4
    }
  });

  try {
    const limited = await waitForValue(
      async () => fetchJson<{ chunks: Array<{ content: string }> }>(
        `${server.baseUrl}/memory/search?q=${encodeURIComponent(payloadText)}&limit=2`
      ),
      (result) => result.chunks.length === 2
    );
    assert.equal(limited.chunks.length, 2);

    const full = await fetchJson<{ chunks: Array<{ content: string }> }>(
      `${server.baseUrl}/memory/search?q=${encodeURIComponent(payloadText)}&limit=10`
    );
    assert.ok(full.chunks.length >= 3);
  } finally {
    await server.close();
  }
});
