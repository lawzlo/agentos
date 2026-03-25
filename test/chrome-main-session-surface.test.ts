import test from "node:test";
import assert from "node:assert/strict";

import {
  browserSelectedTextShowsDraftPreview,
  browserSelectedTextLooksLikeFocusedInput,
  browserWorldStateHasVisibleText,
  parseChromeJxaResult,
  preferredBoundsClickPoint,
  selectChromeWorkspaceTab,
  selectChromeWorkspaceTabFromWindows,
  supplementalOcrConfigsForUrl,
  translateOcrBoundsToScreen,
  shouldReuseChromeTabUrl
} from "../src/runtime/adapters/chrome-main-session-surface.js";

test("parseChromeJxaResult reads JXA console output from stderr when stdout is empty", () => {
  const result = parseChromeJxaResult("", '{"running":true,"windows":1}\n');
  assert.deepEqual(result, { running: true, windows: 1 });
});

test("parseChromeJxaResult prefers stdout when both streams contain data", () => {
  const result = parseChromeJxaResult('{"source":"stdout"}\n', '{"source":"stderr"}\n');
  assert.deepEqual(result, { source: "stdout" });
});

test("parseChromeJxaResult returns null when both streams are empty", () => {
  assert.equal(parseChromeJxaResult("", ""), null);
});

test("shouldReuseChromeTabUrl reuses BOSS chat redirects in the main Chrome session", () => {
  assert.equal(
    shouldReuseChromeTabUrl(
      "https://www.zhipin.com/web/chat/index",
      "https://www.zhipin.com/web/geek/chat"
    ),
    true
  );
});

test("shouldReuseChromeTabUrl reuses Slack client pages on the same logged-in surface", () => {
  assert.equal(
    shouldReuseChromeTabUrl(
      "https://app.slack.com/client/T123/C456",
      "https://app.slack.com/client"
    ),
    true
  );
});

test("shouldReuseChromeTabUrl rejects unrelated same-origin pages", () => {
  assert.equal(
    shouldReuseChromeTabUrl(
      "https://www.zhipin.com/web/job-recommend",
      "https://www.zhipin.com/web/geek/chat"
    ),
    false
  );
});

test("selectChromeWorkspaceTab prefers the active reusable Boss chat tab", () => {
  const selected = selectChromeWorkspaceTab(
    {
      activeTabIndex: 5,
      tabs: [
        {
          id: "stale-boss-tab",
          index: 2,
          title: "BOSS直聘",
          url: "https://www.zhipin.com/web/chat/business/mall?ka=menu-prop"
        },
        {
          id: "active-boss-tab",
          index: 5,
          title: "BOSS直聘",
          url: "https://www.zhipin.com/web/chat/index"
        }
      ]
    },
    "https://www.zhipin.com/web/geek/chat"
  );
  assert.equal(selected?.id, "active-boss-tab");
});

test("selectChromeWorkspaceTabFromWindows prefers a reusable Boss chat tab in another window over the wrong active tab", () => {
  const selected = selectChromeWorkspaceTabFromWindows(
    [
      {
        activeTabIndex: 1,
        tabs: [
          {
            id: "chatgpt-tab",
            index: 1,
            title: "Codex",
            url: "https://chat.openai.com/"
          }
        ]
      },
      {
        activeTabIndex: 3,
        tabs: [
          {
            id: "stale-boss-tab",
            index: 1,
            title: "BOSS直聘",
            url: "https://www.zhipin.com/web/chat/business/mall?ka=menu-prop"
          },
          {
            id: "active-boss-tab",
            index: 3,
            title: "BOSS直聘",
            url: "https://www.zhipin.com/web/chat/index"
          }
        ]
      }
    ],
    "https://www.zhipin.com/web/geek/chat"
  );
  assert.equal(selected?.id, "active-boss-tab");
});

test("selectChromeWorkspaceTabFromWindows does not treat Boss home or verification pages as reusable chat tabs", () => {
  const selected = selectChromeWorkspaceTabFromWindows(
    [
      {
        activeTabIndex: 2,
        tabs: [
          {
            id: "boss-home",
            index: 1,
            title: "BOSS直聘-找工作BOSS直聘直接谈！招聘求职找工作！",
            url: "https://www.zhipin.com/"
          },
          {
            id: "boss-verify",
            index: 2,
            title: "网站访客身份验证 - BOSS直聘",
            url: "https://www.zhipin.com/web/user/safe/verify-slider?callbackUrl=https%3A%2F%2Fwww.zhipin.com%2Fweb%2Fgeek%2Fchat"
          }
        ]
      }
    ],
    "https://www.zhipin.com/web/geek/chat"
  );
  assert.equal(selected, null);
});

test("supplementalOcrConfigsForUrl includes a Boss modal OCR region", () => {
  const configs = supplementalOcrConfigsForUrl("https://www.zhipin.com/web/chat/index");
  assert.equal(configs.some((entry) => entry.source === "ocr-boss-modal"), true);
  assert.equal(configs.some((entry) => entry.source === "ocr-boss-list-names"), true);
});

test("preferredBoundsClickPoint biases vision text targets toward the readable row body", () => {
  assert.deepEqual(
    preferredBoundsClickPoint({
      kind: "text",
      role: "text",
      bounds: {
        x: 100,
        y: 200,
        width: 300,
        height: 80,
        centerX: 250,
        centerY: 240
      },
      sourceHints: {
        source: "vision"
      }
    }),
    {
      x: 166,
      y: 228.8
    }
  );
});

test("preferredBoundsClickPoint keeps centered clicks for non-vision targets", () => {
  assert.deepEqual(
    preferredBoundsClickPoint({
      kind: "button",
      role: "button",
      bounds: {
        x: 100,
        y: 200,
        width: 300,
        height: 80,
        centerX: 250,
        centerY: 240
      },
      sourceHints: {
        source: "ocr"
      }
    }),
    {
      x: 250,
      y: 240
    }
  );
});

test("preferredBoundsClickPoint biases Boss compose fallbacks into the lower editor body", () => {
  assert.deepEqual(
    preferredBoundsClickPoint({
      role: "textbox",
      bounds: {
        x: 1000,
        y: 1100,
        width: 900,
        height: 220,
        centerX: 1450,
        centerY: 1210
      },
      sourceHints: {
        source: "boss-compose-region-fallback"
      }
    }),
    {
      x: 1090,
      y: 1258.4
    }
  );
});

test("preferredBoundsClickPoint biases generic reply input boxes into the lower editor body", () => {
  assert.deepEqual(
    preferredBoundsClickPoint({
      text: "Reply input field at the bottom of the chat.",
      role: "textbox",
      bounds: {
        x: 1200,
        y: 1100,
        width: 900,
        height: 220,
        centerX: 1650,
        centerY: 1210
      },
      sourceHints: {
        source: "vision"
      }
    }),
    {
      x: 1290,
      y: 1258.4
    }
  );
});

test("translateOcrBoundsToScreen converts retina screenshot pixels back to window points", () => {
  assert.deepEqual(
    translateOcrBoundsToScreen(
      {
        x: 600,
        y: 300,
        width: 400,
        height: 200,
        centerX: 800,
        centerY: 400
      },
      {
        x: 363,
        y: 30,
        width: 1877,
        height: 1331
      },
      {
        width: 3754,
        height: 2662
      }
    ),
    {
      x: 663,
      y: 180,
      width: 200,
      height: 100,
      centerX: 763,
      centerY: 230
    }
  );
});

test("browserWorldStateHasVisibleText falls back to OCR candidates when visibleText is truncated", () => {
  assert.equal(
    browserWorldStateHasVisibleText(
      {
        visibleText: "BOSS直聘\nLeon\n候选人: 你好",
        interactionCandidates: [
          { text: "Leon" },
          { text: "你好，我已看到你的信息，会尽快查看并和你沟通后续。" }
        ]
      },
      "你好，我已看到你的信息，会尽快查看并和你沟通后续。"
    ),
    true
  );
});

test("browserSelectedTextLooksLikeFocusedInput rejects whole-page selections", () => {
  assert.equal(
    browserSelectedTextLooksLikeFocusedInput(
      "职位管理\n推荐牛人\n搜索\n沟通\n王蕊\n你好，我已看到你的信息，会尽快查看并和你沟通后续。\n更多页面内容",
      "你好，我已看到你的信息，会尽快查看并和你沟通后续。"
    ),
    false
  );
});

test("browserSelectedTextLooksLikeFocusedInput accepts a focused composer selection", () => {
  assert.equal(
    browserSelectedTextLooksLikeFocusedInput(
      "你好，我已看到你的信息，会尽快查看并和你沟通后续。",
      "你好，我已看到你的信息，会尽快查看并和你沟通后续。"
    ),
    true
  );
});

test("browserSelectedTextShowsDraftPreview accepts Boss draft preview lines", () => {
  assert.equal(
    browserSelectedTextShowsDraftPreview(
      "王蕊ai产品经理\n[草稿] 你好，我已看到你的信息，会尽快查看并和你沟通后续。\n昨天\n杨安娜ai产品经理",
      "你好，我已看到你的信息，会尽快查看并和你沟通后续。",
      "王蕊 ai产品经理"
    ),
    true
  );
});

test("browserSelectedTextShowsDraftPreview rejects draft previews from a different Boss thread", () => {
  assert.equal(
    browserSelectedTextShowsDraftPreview(
      "王蕊ai产品经理\n[草稿] 你好，我已看到你的信息，会尽快查看并和你沟通后续。\n昨天\n杨安娜ai产品经理",
      "你好，我已看到你的信息，会尽快查看并和你沟通后续。",
      "庄瑞莹 ai产品经理"
    ),
    false
  );
});
