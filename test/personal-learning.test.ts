import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { ControlPlaneStore } from "../src/runtime/store.js";
import type { ProposalRecord } from "../src/types/learning.js";
import { createTempDir, startAgentServer, waitForTask } from "./helpers.js";

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

