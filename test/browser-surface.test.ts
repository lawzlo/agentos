import test from "node:test";
import assert from "node:assert/strict";

import { BrowserSurfaceAdapter } from "../src/runtime/adapters/browser-surface.js";
import type { ArtifactStore } from "../src/runtime/artifact-store.js";

const TEST_ARTIFACT_STORE = {} as ArtifactStore;

function createTask() {
  return {
    id: "task-browser-test",
    goal: "Test browser runtime",
    status: "running",
    createdAt: new Date().toISOString()
  };
}

function createWorkspace() {
  return {
    id: "ws-browser-test",
    name: "browser-test",
    rootPath: "/tmp",
    profilePath: "/tmp/browser-profile"
  };
}

test("browser goto reuses the current tab via desktop actions", async () => {
  const actions: Array<{ action: string; params?: Record<string, unknown> }> = [];
  const adapter = new BrowserSurfaceAdapter({
    artifactStore: TEST_ARTIFACT_STORE,
    browserExecutable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    modelConfig: {
      provider: "openai_compatible",
      baseUrl: "",
      apiKey: "",
      name: "",
      timeoutMs: 5000
    },
    desktopSurface: {
      async observe() {
        return {
          version: 1,
          surface: "desktop",
          workspaceId: "ws-browser-test",
          appContext: {
            appName: "Google Chrome",
            windows: [
              {
                windowName: "Chrome",
                windowNumber: 1,
                bounds: { x: 10, y: 20, width: 1200, height: 800 }
              }
            ],
            captureWindowNumber: 1
          },
          capture: { path: "/tmp/browser.png" },
          screenTextBlocks: [],
          interactionCandidates: [],
          visibleText: "Boss直聘",
          recentActions: [],
          summary: "Chrome",
          timestamp: new Date().toISOString()
        };
      },
      async capture() {
        return { path: "/tmp/browser.png" };
      },
      async focus() {
        return { focused: true };
      },
      async act({ step }) {
        actions.push({ action: step.action, params: step.params });
        return { ok: true };
      },
      async shutdown() {}
    }
  });

  const result = await adapter.act({
    task: createTask(),
    workspace: createWorkspace(),
    traceId: null,
    step: {
      action: "goto",
      params: { url: "https://www.zhipin.com/web/geek/chat" }
    }
  });

  assert.deepEqual(result, { url: "https://www.zhipin.com/web/geek/chat", title: null });
  assert.deepEqual(
    actions.map((entry) => entry.action),
    ["pressKey", "typeText", "pressKey", "wait"]
  );
  assert.equal(actions[0]?.params?.key, "l");
  assert.equal(actions[0]?.params?.modifiers?.[0], "cmd");
  assert.equal(actions[1]?.params?.text, "https://www.zhipin.com/web/geek/chat");
  assert.equal(actions[2]?.params?.key, "enter");
});

test("browserExtract uses visible browser state with the image model", async () => {
  const prompts: Array<{ schemaName: string; imagePath: string; userPrompt: string }> = [];
  const adapter = new BrowserSurfaceAdapter({
    artifactStore: TEST_ARTIFACT_STORE,
    modelConfig: {
      provider: "openai_compatible",
      baseUrl: "",
      apiKey: "",
      name: "",
      timeoutMs: 5000
    },
    visualModelClient: {
      supportsImageJson() {
        return true;
      },
      async analyzeImageJson<TResponse>({ schemaName, imagePath, userPrompt }) {
        prompts.push({ schemaName, imagePath, userPrompt });
        return { latestInboundMessage: "可以约周三下午沟通吗？" } as TResponse;
      }
    },
    desktopSurface: {
      async observe() {
        return {
          version: 1,
          surface: "desktop",
          workspaceId: "ws-browser-test",
          appContext: {
            appName: "Google Chrome",
            windows: [
              {
                windowName: "Boss",
                windowNumber: 2,
                bounds: { x: 10, y: 20, width: 1200, height: 800 }
              }
            ],
            captureWindowNumber: 2
          },
          capture: { path: "/tmp/browser-extract.png" },
          screenTextBlocks: [],
          interactionCandidates: [
            { id: "thread-row", text: "Lazaro Waters", role: "button", isInteractive: true, bounds: { centerX: 200, centerY: 280 } }
          ],
          visibleText: "Lazaro Waters\nCan we speak Wednesday afternoon?",
          recentActions: [],
          summary: "Chrome",
          timestamp: new Date().toISOString()
        };
      },
      async capture() {
        return { path: "/tmp/browser-extract.png" };
      },
      async focus() {
        return { focused: true };
      },
      async act() {
        return { ok: true };
      },
      async shutdown() {}
    }
  });

  const result = await adapter.act({
    task: createTask(),
    workspace: createWorkspace(),
    traceId: null,
    step: {
      action: "browserExtract",
      params: {
        instruction: "Extract the latest inbound message from the current visible chat thread.",
        schema: {
          type: "object",
          properties: {
            latestInboundMessage: { type: "string" }
          },
          required: ["latestInboundMessage"]
        }
      }
    }
  });

  assert.deepEqual(result, { extracted: { latestInboundMessage: "可以约周三下午沟通吗？" } });
  assert.equal(prompts[0]?.schemaName, "agentos_browser_extract");
  assert.equal(prompts[0]?.imagePath, "/tmp/browser-extract.png");
  assert.match(prompts[0]?.userPrompt ?? "", /latest inbound message/i);
});

test("browserExecute does not auto-navigate the current tab from startUrl hints", async () => {
  const actions: Array<{ action: string; params?: Record<string, unknown> }> = [];
  const adapter = new BrowserSurfaceAdapter({
    artifactStore: TEST_ARTIFACT_STORE,
    modelConfig: {
      provider: "openai_compatible",
      baseUrl: "",
      apiKey: "",
      name: "",
      timeoutMs: 5000
    },
    visualModelClient: {
      supportsImageJson() {
        return true;
      },
      async analyzeImageJson<TResponse>() {
        return {
          status: "completed",
          rationale: "The current visible tab is already ready for takeover."
        } as TResponse;
      }
    },
    desktopSurface: {
      async observe() {
        return {
          version: 1,
          surface: "desktop",
          workspaceId: "ws-browser-test",
          appContext: {
            appName: "Google Chrome",
            title: "BOSS直聘",
            url: "https://www.zhipin.com/web/geek/chat",
            windows: [
              {
                windowName: "BOSS直聘",
                windowNumber: 1,
                bounds: { x: 10, y: 20, width: 1200, height: 800 }
              }
            ],
            captureWindowNumber: 1
          },
          capture: { path: "/tmp/browser-execute.png" },
          screenTextBlocks: [],
          interactionCandidates: [],
          visibleText: "全部\n未读\n当前暂无消息",
          recentActions: [],
          summary: "BOSS直聘",
          timestamp: new Date().toISOString()
        };
      },
      async capture() {
        return { path: "/tmp/browser-execute.png" };
      },
      async focus() {
        return { focused: true };
      },
      async act({ step }) {
        actions.push({ action: step.action, params: step.params });
        return { ok: true };
      },
      async shutdown() {}
    }
  });

  const result = await adapter.act({
    task: createTask(),
    workspace: createWorkspace(),
    traceId: null,
    step: {
      action: "browserExecute",
      params: {
        instruction: "Take over the current Boss直聘 tab without changing pages.",
        startUrl: "https://www.zhipin.com/web/geek/chat",
        maxSteps: 1
      }
    }
  });

  assert.deepEqual(actions, []);
  assert.deepEqual(result, {
    status: "completed",
    finalUrl: "https://www.zhipin.com/web/geek/chat",
    blockers: [],
    verification: null
  });
});
