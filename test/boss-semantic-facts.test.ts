import test from "node:test";
import assert from "node:assert/strict";

import { inferBossSemanticFacts, type BossSemanticModelClient } from "../src/runtime/boss-semantic-facts.js";
import type { WorldState } from "../src/types/runtime-schema.js";

function buildBossWorldState(visibleText: string): WorldState {
  return {
    version: 1,
    surface: "browser",
    workspaceId: "workspace-boss-semantic-facts",
    appContext: {
      title: "BOSS直聘",
      url: "http://boss.local/boss"
    },
    capture: {
      id: "artifact-boss-semantic-facts",
      taskId: "task-boss-semantic-facts",
      traceId: null,
      kind: "screenshot",
      label: "Boss semantic facts",
      path: "/tmp/boss-semantic-facts.png",
      metadata: {
        windowBounds: {
          x: 0,
          y: 0,
          width: 1440,
          height: 960,
          centerX: 720,
          centerY: 480
        }
      },
      createdAt: new Date().toISOString()
    },
    screenTextBlocks: [],
    interactionCandidates: [],
    visibleText,
    recentActions: [],
    summary: "BOSS candidate thread",
    timestamp: new Date().toISOString()
  };
}

test("boss semantic facts derive sender names from generic candidate prefixes", async () => {
  const facts = await inferBossSemanticFacts({
    modelClient: null,
    worldState: buildBossWorldState(
      [
        "BOSS直聘",
        "李雷",
        "产品经理",
        "候选人: 方便聊下这个岗位吗？",
        "发送消息给李雷",
        "发送"
      ].join("\n")
    ),
    summary: "李雷 · 产品经理",
    threadSummary: "李雷 · 产品经理",
    trailingWindow: 6,
    excludeComposeChrome: true
  });

  assert.equal(facts.latestInboundMessage, "候选人: 方便聊下这个岗位吗？");
  assert.equal(facts.senderName, "李雷");
  assert.equal(facts.speakerRole, "candidate");
  assert.equal(facts.threadSummary, "李雷");
});

test("boss semantic facts can use model-backed unlabeled thread lines without prefixed heuristics", async () => {
  const modelClient: BossSemanticModelClient = {
    isConfigured: () => true,
    async completeJson<TPayload, TResponse>() {
      return {
        latestInboundMessage: "Curious, are you using AWS or Google Cloud?",
        salientContext: [
          "Curious, are you using AWS or Google Cloud?",
          "We help funded startups stretch runway by getting them $50-100k+ in cloud credits."
        ],
        senderName: "Lazaro Waters",
        speakerRole: "candidate",
        threadSummary: "Lazaro Waters",
        evidence: "latest candidate question visible"
      } as TResponse;
    }
  };

  const facts = await inferBossSemanticFacts({
    modelClient,
    worldState: buildBossWorldState(
      [
        "BOSS直聘",
        "Lazaro Waters",
        "Partnerships Coordinator",
        "Curious, are you using AWS or Google Cloud?",
        "We help funded startups stretch runway by getting them $50-100k+ in cloud credits.",
        "Message Lazaro Waters",
        "Send"
      ].join("\n")
    ),
    summary: "Lazaro Waters",
    threadSummary: "Lazaro Waters",
    trailingWindow: 8,
    excludeComposeChrome: true
  });

  assert.equal(facts.source, "model");
  assert.equal(facts.latestInboundMessage, "Curious, are you using AWS or Google Cloud?");
  assert.equal(facts.senderName, "Lazaro Waters");
  assert.equal(facts.speakerRole, "candidate");
  assert.deepEqual(facts.salientContext.slice(0, 2), [
    "Curious, are you using AWS or Google Cloud?",
    "We help funded startups stretch runway by getting them $50-100k+ in cloud credits."
  ]);
});

test("boss semantic facts fall back cleanly when model extraction exceeds the detect-stage budget", async () => {
  const modelClient: BossSemanticModelClient = {
    isConfigured: () => true,
    async completeJson<TPayload, TResponse>() {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        latestInboundMessage: "Should not win the race",
        salientContext: ["Should not win the race"],
        senderName: "Timeout Candidate",
        speakerRole: "candidate",
        threadSummary: "Timeout Candidate",
        evidence: "delayed"
      } as TResponse;
    }
  };

  const facts = await inferBossSemanticFacts({
    modelClient,
    worldState: buildBossWorldState(
      [
        "BOSS直聘",
        "李雷",
        "产品经理",
        "候选人: 方便聊下这个岗位吗？",
        "发送消息给李雷",
        "发送"
      ].join("\n")
    ),
    summary: "李雷 · 产品经理",
    threadSummary: "李雷 · 产品经理",
    trailingWindow: 6,
    excludeComposeChrome: true,
    timeoutMs: 1
  });

  assert.equal(facts.source, "heuristic");
  assert.equal(facts.latestInboundMessage, "候选人: 方便聊下这个岗位吗？");
  assert.equal(facts.senderName, "李雷");
});
