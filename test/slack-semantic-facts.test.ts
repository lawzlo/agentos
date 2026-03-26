import test from "node:test";
import assert from "node:assert/strict";

import { inferSlackSemanticFacts, type SlackSemanticModelClient } from "../src/runtime/slack-semantic-facts.js";
import type { WorldState } from "../src/types/runtime-schema.js";

function buildSlackWorldState(visibleText: string): WorldState {
  return {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-slack-semantic-facts",
    appContext: {
      appName: "Slack",
      windows: [{ title: "Slack" }]
    },
    capture: null,
    screenTextBlocks: [],
    interactionCandidates: [],
    visibleText,
    recentActions: [],
    summary: "Slack semantic facts",
    timestamp: new Date().toISOString()
  };
}

test("slack semantic facts derive sender names from visible speaker labels", async () => {
  const facts = await inferSlackSemanticFacts({
    modelClient: null,
    worldState: buildSlackWorldState(
      [
        "Slack",
        "Conversation: Acme renewal",
        "Customer: Can you share pricing?",
        "Teammate: Keep it short.",
        "Message",
        "Send"
      ].join("\n")
    ),
    summary: "Acme renewal",
    threadSummary: "Acme renewal"
  });

  assert.equal(facts.latestInboundMessage, "Customer: Can you share pricing?");
  assert.equal(facts.senderName, "Customer");
  assert.equal(facts.speakerRole, "sender");
  assert.equal(facts.threadSummary, "Acme renewal");
});

test("slack semantic facts can use a model-backed unlabeled thread", async () => {
  const modelClient: SlackSemanticModelClient = {
    isConfigured: () => true,
    async completeJson<TPayload, TResponse>() {
      return {
        latestInboundMessage: "Could you share the latest pricing update?",
        salientContext: [
          "Could you share the latest pricing update?",
          "Need this before tomorrow's renewal review."
        ],
        senderName: "Customer",
        speakerRole: "sender",
        threadSummary: "Acme renewal",
        evidence: "latest inbound request is visible in the thread"
      } as TResponse;
    }
  };

  const facts = await inferSlackSemanticFacts({
    modelClient,
    worldState: buildSlackWorldState(
      [
        "Slack",
        "Conversation: Acme renewal",
        "Could you share the latest pricing update?",
        "Need this before tomorrow's renewal review.",
        "Message",
        "Send"
      ].join("\n")
    ),
    summary: "Acme renewal",
    threadSummary: "Acme renewal"
  });

  assert.equal(facts.source, "model");
  assert.equal(facts.latestInboundMessage, "Could you share the latest pricing update?");
  assert.equal(facts.senderName, "Customer");
  assert.equal(facts.speakerRole, "sender");
  assert.deepEqual(facts.salientContext.slice(0, 2), [
    "Could you share the latest pricing update?",
    "Need this before tomorrow's renewal review."
  ]);
});
