import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { createStagehandRuntime } from "../src/runtime/stagehand-runtime.js";
import { SurfaceCoordinator } from "../src/runtime/surface-coordinator.js";
import { SurfaceRegistry } from "../src/runtime/surface-registry.js";
import { SurfaceScheduler } from "../src/runtime/surface-scheduler.js";
import { SurfaceAdapter } from "../src/runtime/adapters/surface-adapter.js";

test("createStagehandRuntime loads explicit module and executes action lists", async () => {
  const originalModule = process.env.AGENTOS_STAGEHAND_MODULE;
  const stubPath = path.resolve(process.cwd(), "test/fixtures/stagehand-stub.mjs");
  process.env.AGENTOS_STAGEHAND_MODULE = stubPath;
  (globalThis as typeof globalThis & { __agentosStagehandStubState?: { instances: Array<Record<string, unknown>> } }).__agentosStagehandStubState = {
    instances: []
  };

  try {
    const runtime = await createStagehandRuntime({
      cdpUrl: "ws://127.0.0.1:9222/devtools/browser/test",
      modelConfig: {
        provider: "openai",
        apiKey: "test-key",
        name: "gpt-test",
        baseUrl: "https://example.invalid/v1",
        timeoutMs: 5000
      }
    });

    const page = {
      url() {
        return "https://www.zhipin.com/web/geek/chat";
      }
    };

    const result = await runtime.execute(
      {
        instruction: "",
        actions: ["open first unread thread", "prefill reply"],
        maxSteps: 2
      },
      page as never
    );

    assert.equal(result.status, "completed");
    assert.equal(result.finalUrl, "https://www.zhipin.com/web/geek/chat");

    const state = (globalThis as typeof globalThis & {
      __agentosStagehandStubState?: { instances: Array<{ args?: Record<string, unknown>; calls: Array<Record<string, unknown>> }> };
    }).__agentosStagehandStubState;
    assert.ok(state);
    assert.equal(state.instances.length, 1);
    assert.equal(state.instances[0]?.calls.filter((entry) => entry.method === "observe").length, 2);
    assert.equal(state.instances[0]?.calls.filter((entry) => entry.method === "act").length, 2);

    await runtime.close();
  } finally {
    if (originalModule == null) {
      delete process.env.AGENTOS_STAGEHAND_MODULE;
    } else {
      process.env.AGENTOS_STAGEHAND_MODULE = originalModule;
    }
  }
});

test("SurfaceCoordinator routes attach-existing browser sessions to browser-main-session", () => {
  class SharedBrowserAdapter extends SurfaceAdapter {
    usesSharedSession(): boolean {
      return true;
    }
  }

  const coordinator = new SurfaceCoordinator({
    surfaceRegistry: new SurfaceRegistry({
      browser: new SharedBrowserAdapter("browser"),
      desktop: new SurfaceAdapter("desktop")
    }),
    surfaceScheduler: new SurfaceScheduler()
  });

  assert.equal(coordinator.resolveSurfaceKey("browser", "boss-browser-main"), "browser-main-session");
  assert.equal(coordinator.resolveSurfaceKey("desktop", "desktop-main"), "desktop-global");
});
