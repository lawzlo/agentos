import test from "node:test";
import assert from "node:assert/strict";

import { inferWeChatSemanticFacts, type WeChatSemanticModelClient } from "../src/runtime/wechat-semantic-facts.js";
import type { WorldState } from "../src/types/runtime-schema.js";

function buildWeChatWorldState(visibleText: string): WorldState {
  return {
    version: 1,
    surface: "desktop",
    workspaceId: "workspace-wechat-semantic-facts",
    appContext: {
      appName: "WeChat",
      windows: [{ title: "WeChat" }]
    },
    capture: null,
    screenTextBlocks: [],
    interactionCandidates: [],
    visibleText,
    recentActions: [],
    summary: "WeChat semantic facts",
    timestamp: new Date().toISOString()
  };
}

test("wechat semantic facts prefer the visible latest snippet and infer the thread sender", async () => {
  const facts = await inferWeChatSemanticFacts({
    modelClient: null,
    worldState: buildWeChatWorldState(
      [
        "微信",
        "张三",
        "你好",
        "明天下午方便吗？",
        "输入消息",
        "发送"
      ].join("\n")
    ),
    summary: "张三",
    threadSummary: "张三",
    preferredLatestSnippet: "明天下午方便吗？",
    replyReason: "Unread direct question likely needs a response"
  });

  assert.equal(facts.latestInboundMessage, "明天下午方便吗？");
  assert.equal(facts.senderName, "张三");
  assert.equal(facts.speakerRole, "sender");
  assert.equal(facts.source, "vision");
  assert.equal(facts.replyLanguageHint, "zh");
});

test("wechat semantic facts can use a model-backed unlabeled thread", async () => {
  const modelClient: WeChatSemanticModelClient = {
    isConfigured: () => true,
    async completeJson<TPayload, TResponse>() {
      return {
        latestInboundMessage: "Could we talk tomorrow afternoon?",
        salientContext: [
          "Could we talk tomorrow afternoon?",
          "I can send the details if that works for you."
        ],
        senderName: "Lazaro Waters",
        speakerRole: "sender",
        threadSummary: "Lazaro Waters",
        evidence: "latest visible inbound question and follow-up are present"
      } as TResponse;
    }
  };

  const facts = await inferWeChatSemanticFacts({
    modelClient,
    worldState: buildWeChatWorldState(
      [
        "WeChat",
        "Lazaro Waters",
        "Could we talk tomorrow afternoon?",
        "I can send the details if that works for you.",
        "Message",
        "Send"
      ].join("\n")
    ),
    summary: "Lazaro Waters",
    threadSummary: "Lazaro Waters"
  });

  assert.equal(facts.source, "model");
  assert.equal(facts.latestInboundMessage, "Could we talk tomorrow afternoon?");
  assert.equal(facts.senderName, "Lazaro Waters");
  assert.equal(facts.speakerRole, "sender");
  assert.deepEqual(facts.salientContext.slice(0, 2), [
    "Could we talk tomorrow afternoon?",
    "I can send the details if that works for you."
  ]);
});
