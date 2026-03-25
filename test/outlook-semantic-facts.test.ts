import test from "node:test";
import assert from "node:assert/strict";

import { inferOutlookSemanticFacts } from "../src/runtime/outlook-semantic-facts.js";

test("outlook semantic facts prefer a visible latest snippet and stop before quoted history", async () => {
  const facts = await inferOutlookSemanticFacts({
    modelClient: null,
    worldState: {
      version: 1,
      surface: "desktop",
      workspaceId: "workspace-outlook-semantic-fallback",
      appContext: {
        appName: "Microsoft Outlook"
      },
      capture: {
        path: "/tmp/outlook-semantic-fallback.png",
        metadata: {}
      },
      ocrBlocks: [],
      interactionCandidates: [
        {
          id: "thread-row",
          surface: "desktop",
          kind: "element",
          text: "Lazaro Waters",
          role: "row",
          bounds: { x: 20, y: 120, width: 220, height: 32, centerX: 130, centerY: 136 },
          confidence: 0.92,
          sourceHints: { source: "accessibility", windowTitle: "Microsoft Outlook" },
          isInteractive: true
        }
      ],
      visibleText: [
        "Outlook",
        "Lazaro Waters",
        "Re: extend runway",
        "Thanks for the note.",
        "Could we talk Tuesday afternoon?",
        "From: Lazaro Waters <waters@example.com>",
        "Date: Tuesday, March 24, 2026 at 10:15 AM"
      ].join("\n"),
      recentActions: [],
      summary: "Outlook",
      timestamp: new Date().toISOString()
    } as never,
    summary: "Lazaro Waters",
    threadSummary: "Lazaro Waters",
    subjectCue: "Re: extend runway",
    preferredLatestSnippet: "Could we talk Tuesday afternoon?"
  });

  assert.equal(facts.latestInboundMessage, "Could we talk Tuesday afternoon?");
  assert.equal(facts.salientContext.includes("From: Lazaro Waters <waters@example.com>"), false);
  assert.equal(facts.source, "vision");
  assert.equal(facts.replyLanguageHint, "en");
});

test("outlook semantic facts can use a model-backed unlabeled thread", async () => {
  const facts = await inferOutlookSemanticFacts({
    modelClient: {
      isConfigured: () => true,
      async completeJson() {
        return {
          latestInboundMessage: "我们这周四下午方便电话沟通吗？",
          salientContext: [
            "我们这周四下午方便电话沟通吗？",
            "如果可以的话我会把时间安排发给你。"
          ],
          senderName: "李伟",
          speakerRole: "sender",
          threadSummary: "李伟",
          subjectCue: "新案委托回复",
          replyLanguageHint: "zh",
          evidence: "latest visible sender question and follow-up are both present"
        };
      }
    } as never,
    worldState: {
      version: 1,
      surface: "desktop",
      workspaceId: "workspace-outlook-semantic-model",
      appContext: {
        appName: "Microsoft Outlook"
      },
      capture: {
        path: "/tmp/outlook-semantic-model.png",
        metadata: {}
      },
      ocrBlocks: [],
      interactionCandidates: [],
      visibleText: [
        "Microsoft Outlook",
        "李伟",
        "新案委托回复",
        "我们这周四下午方便电话沟通吗？",
        "如果可以的话我会把时间安排发给你。"
      ].join("\n"),
      recentActions: [],
      summary: "Outlook",
      timestamp: new Date().toISOString()
    } as never,
    summary: "李伟",
    threadSummary: "李伟",
    subjectCue: "新案委托回复"
  });

  assert.equal(facts.latestInboundMessage, "我们这周四下午方便电话沟通吗？");
  assert.equal(facts.speakerRole, "sender");
  assert.equal(facts.source, "model");
  assert.equal(facts.replyLanguageHint, "zh");
});
