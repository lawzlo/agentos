import test from "node:test";
import assert from "node:assert/strict";

import { normalizeWatchRule } from "../src/runtime/watch-rule-parser.js";

test("normalizeWatchRule infers slack packs from goal and surface", async () => {
  const watch = normalizeWatchRule({
    goal: "Watch Slack for unread messages and reply",
    preferredSurface: "browser"
  });

  assert.equal(watch.livePack, "slack-browser");
  assert.equal(watch.preferredSurface, "browser");
  assert.equal(watch.watchProfile.executionMode, "planned");
  assert.ok(watch.watchProfile.triggerTexts.includes("unread"));
});

test("normalizeWatchRule infers wechat desktop pack from goal", async () => {
  const watch = normalizeWatchRule({
    goal: "Monitor 微信通知并处理",
    preferredSurface: "desktop"
  });

  assert.equal(watch.livePack, "wechat-desktop");
  assert.equal(watch.preferredSurface, "desktop");
  assert.equal(watch.appTarget, "WeChat");
});

test("normalizeWatchRule infers drive trigger hints for download and upload", async () => {
  const watch = normalizeWatchRule({
    goal: "Always check Google Drive for pending file operations",
    preferredSurface: "browser"
  });

  assert.equal(watch.livePack, "google-drive-browser");
  assert.equal(watch.watchProfile.triggerTexts.includes("pending upload"), true);
  assert.equal(watch.watchProfile.triggerTexts.includes("pending download"), true);
});

test("normalizeWatchRule infers boss browser pack from recruiting goals", async () => {
  const watch = normalizeWatchRule({
    goal: "Always watch BOSS直聘 for new candidates and review them.",
    preferredSurface: "browser"
  });

  assert.equal(watch.livePack, "boss-browser");
  assert.equal(watch.preferredSurface, "browser");
  assert.equal(watch.watchProfile.triggerTexts.includes("新候选人"), true);
});

test("normalizeWatchRule validates required goal", async () => {
  assert.throws(() => {
    normalizeWatchRule({});
  }, /watch goal is required/);
});

test("normalizeWatchRule keeps explicit livePack and clamps poll interval", async () => {
  const watch = normalizeWatchRule({
    goal: "Watch browser docs and keep updated",
    livePack: "google-docs-browser",
    pollIntervalMs: 50
  });

  assert.equal(watch.livePack, "google-docs-browser");
  assert.equal(watch.preferredSurface, "browser");
  assert.equal(watch.pollIntervalMs, 1000);
  assert.equal(watch.appTarget, null);
  assert.equal(watch.id, undefined);
});

test("normalizeWatchRule uses model capability to infer autonomous execution mode", async () => {
  const watch = normalizeWatchRule(
    {
      goal: "Watch Slack for unanswered mentions"
    },
    { modelConfigured: true }
  );

  assert.equal(watch.watchProfile.executionMode, "autonomous");
});

test("normalizeWatchRule preserves explicit execution mode and trigger texts", async () => {
  const watch = normalizeWatchRule({
    goal: "Inspect my daily inbox for priority mail",
    watchProfile: {
      executionMode: "autonomous",
      triggerTexts: ["inbox", "reply needed"]
    }
  });

  assert.equal(watch.watchProfile.executionMode, "autonomous");
  assert.deepEqual(watch.watchProfile.triggerTexts, ["inbox", "reply needed"]);
});

test("normalizeWatchRule maps preferred browser mail goal to browser live pack", async () => {
  const watch = normalizeWatchRule({
    goal: "Check unread email and handle follow-up actions.",
    preferredSurface: "browser",
    skillName: "mail-follow-up"
  });

  assert.equal(watch.livePack, "generic-mail-browser");
  assert.equal(watch.preferredSurface, "browser");
  assert.equal(watch.appTarget, null);
  assert.equal(watch.watchProfile.executionMode, "planned");
});

test("normalizeWatchRule normalizes governance settings", async () => {
  const watch = normalizeWatchRule({
    goal: "Watch Slack and keep actions bounded",
    governance: {
      approvalMode: "draft_only",
      cooldownMs: 30_500,
      maxAutoActionsPerDay: 2,
      maxConsecutiveFailures: 1,
      quietHours: {
        startHour: 22,
        endHour: 8
      }
    }
  });

  assert.deepEqual(watch.watchProfile.governance, {
    approvalMode: "draft_only",
    cooldownMs: 30500,
    maxAutoActionsPerDay: 2,
    maxConsecutiveFailures: 1,
    quietHours: {
      startHour: 22,
      endHour: 8
    }
  });
});
