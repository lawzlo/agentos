import test from "node:test";
import assert from "node:assert/strict";

import { DesktopSurfaceAdapter } from "../src/runtime/adapters/desktop-surface.js";

function createAdapter() {
  const adapter = new DesktopSurfaceAdapter({
    artifactStore: {
      registerExistingFile() {
        throw new Error("artifact registration should not run in this test");
      }
    },
    dataDir: "/tmp/agentos-test"
  }) as DesktopSurfaceAdapter & { bridge: Record<string, unknown> };

  const calls: Array<{ action: string; name: string }> = [];
  adapter.bridge = {
    async focusApp(name: string) {
      calls.push({ action: "focus", name });
      return { focused: name };
    },
    async launchApp(name: string) {
      calls.push({ action: "launch", name });
      return { launched: name };
    }
  };

  return { adapter, calls };
}

test("desktop surface focus accepts appName aliases", async () => {
  const { adapter, calls } = createAdapter();

  const result = await adapter.focus({
    step: {
      params: {
        appName: "Slack"
      }
    }
  });

  assert.deepEqual(result, { focused: "Slack" });
  assert.deepEqual(calls, [{ action: "focus", name: "Slack" }]);
});

test("desktop surface actions accept appName aliases for focus and launch", async () => {
  const { adapter, calls } = createAdapter();

  const focusResult = await adapter.act({
    task: { id: "task_test" },
    step: {
      action: "focusApp",
      params: {
        appName: "Slack"
      }
    },
    workspace: {
      rootPath: "/tmp",
      artifactsPath: "/tmp"
    },
    traceId: "trace_test"
  });
  const launchResult = await adapter.act({
    task: { id: "task_test" },
    step: {
      action: "launchApp",
      params: {
        appName: "WeChat"
      }
    },
    workspace: {
      rootPath: "/tmp",
      artifactsPath: "/tmp"
    },
    traceId: "trace_test"
  });

  assert.deepEqual(focusResult, { focused: "Slack" });
  assert.deepEqual(launchResult, { launched: "WeChat" });
  assert.deepEqual(calls, [
    { action: "focus", name: "Slack" },
    { action: "launch", name: "WeChat" }
  ]);
});
