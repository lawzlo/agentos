import assert from "node:assert/strict";
import test from "node:test";

import { createTempDir, startAgentServer } from "./helpers.js";

test("surface state probes run through daemon leases and surface snapshots expose the active holder", async () => {
  const dataDir = await createTempDir("agentos-surface-route-");
  const server = await startAgentServer({ dataDir });
  try {
    let signalObserveStarted: (() => void) | null = null;
    const observeStarted = new Promise<void>((resolve) => {
      signalObserveStarted = resolve;
    });

    let releaseObserveGate: (() => void) | null = null;
    const releaseGate = new Promise<void>((resolve) => {
      releaseObserveGate = resolve;
    });

    let enteredObserve = false;
    server.app.controlPlane.surfaceRegistry.surfaces.set(
      "browser",
      {
        name: "browser",
        usesSharedSession() {
          return true;
        },
        async act() {
          return { ok: true };
        },
        async observe() {
          enteredObserve = true;
          signalObserveStarted?.();
          await releaseGate;
          return {
            version: 1,
            surface: "browser",
            workspaceId: "workspace-state-browser",
            appContext: {
              title: "Sign in to Slack",
              url: "https://app.slack.com/client"
            },
            capture: null,
            screenTextBlocks: [],
            interactionCandidates: [],
            visibleText: "Slack\nSign in to Slack\nContinue with Google",
            recentActions: [],
            summary: "Sign in to Slack",
            timestamp: new Date().toISOString()
          };
        },
        async shutdown() {}
      } as never
    );

    const request = {
      surface: "browser",
      appName: null,
      packName: "slack-browser",
      workspaceName: "state-route-browser",
      sampleLimit: 5,
      timeoutMs: 1000,
      requireAccessibility: false,
      waitReady: false,
      url: "https://app.slack.com/client",
      browserProfilePath: null
    };

    const firstProbePromise = fetch(`${server.baseUrl}/surface/state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    }).then((response) => response.json());

    while (!enteredObserve) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const surfaces = await fetch(`${server.baseUrl}/surfaces`).then((response) => response.json());
    const activeSurface = (surfaces.surfaces as Array<Record<string, unknown>>).find(
      (entry) => entry.surfaceKey === "browser-main-session"
    ) as
      | ({
          activeHolder?: {
            holderKind?: string | null;
            holderId?: string | null;
          } | null;
        } & Record<string, unknown>)
      | undefined;
    assert.ok(activeSurface);
    assert.equal(activeSurface.activeHolder?.holderKind, "state_probe");
    assert.match(String(activeSurface.activeHolder?.holderId ?? ""), /state:browser:/);

    await observeStarted;
    releaseObserveGate?.();

    const firstProbe = await firstProbePromise;
    assert.equal(firstProbe.report?.readinessState, "blocked_signin");
    assert.equal(firstProbe.surfaceKey, "browser-main-session");
  } finally {
    await server.close();
  }
});
