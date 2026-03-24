import test from "node:test";
import assert from "node:assert/strict";

import { OperatorAgent } from "../src/runtime/agents/operator.js";

function createOperator({
  groundResult
}: {
  groundResult: {
    targetId: string;
    resolutionMode: string;
    confidence: number;
    target: Record<string, unknown>;
    fallbacks?: unknown[];
  };
}) {
  const actedSteps: Array<Record<string, unknown>> = [];
  const surface = {
    async observe() {
      return {
        interactionCandidates: [],
        visibleText: "",
        appContext: {}
      };
    },
    async act({ step }: { step: Record<string, unknown> }) {
      actedSteps.push(step);
      return { ok: true };
    },
    async verify() {
      return { ok: true, details: {} };
    },
    async checkpoint() {
      return null;
    }
  };

  const operator = new OperatorAgent({
    surfaceRegistry: {
      get() {
        return surface;
      }
    } as never,
    traceStore: {
      log() {}
    } as never,
    policyEngine: {
      evaluateStep() {
        return { allowed: true, reasons: [] };
      }
    } as never,
    groundingEngine: {
      ground() {
        return groundResult;
      }
    } as never
  });

  return { operator, actedSteps };
}

function createTask() {
  return {
    id: "task-1",
    goal: "Open Outlook thread",
    preferredSurface: "desktop",
    taskSpec: {
      goal: "Open Outlook thread"
    }
  } as never;
}

function createWorkspace() {
  return {
    id: "workspace-1",
    name: "outlook-desktop-main"
  } as never;
}

test("operator skips low-confidence desktop fuzzy pre-grounding and keeps targetQuery-only execution", async () => {
  const { operator, actedSteps } = createOperator({
    groundResult: {
      targetId: "desktop-ocr-1",
      resolutionMode: "fuzzy_text",
      confidence: 0.15,
      target: {
        id: "desktop-ocr-1",
        text: "+",
        bounds: { centerX: 10, centerY: 20 }
      }
    }
  });

  await operator.execute({
    task: createTask(),
    workspace: createWorkspace(),
    traceId: "trace-1",
    plan: [
      {
        id: "step-1",
        label: "Open unread Outlook thread",
        surface: "desktop",
        action: "clickTarget",
        params: { targetQuery: "上海光华" },
        checkpoint: false
      }
    ]
  });

  assert.equal(actedSteps.length, 1);
  const params = (actedSteps[0]?.params ?? {}) as Record<string, unknown>;
  assert.equal(params.targetQuery, "上海光华");
  assert.equal("target" in params, false);
});

test("operator preserves high-confidence pre-grounded desktop targets", async () => {
  const { operator, actedSteps } = createOperator({
    groundResult: {
      targetId: "desktop-ocr-thread",
      resolutionMode: "exact_text",
      confidence: 0.92,
      target: {
        id: "desktop-ocr-thread",
        text: "上海光华",
        bounds: { centerX: 300, centerY: 200 }
      }
    }
  });

  await operator.execute({
    task: createTask(),
    workspace: createWorkspace(),
    traceId: "trace-2",
    plan: [
      {
        id: "step-1",
        label: "Open unread Outlook thread",
        surface: "desktop",
        action: "clickTarget",
        params: { targetQuery: "上海光华" },
        checkpoint: false
      }
    ]
  });

  assert.equal(actedSteps.length, 1);
  const params = (actedSteps[0]?.params ?? {}) as Record<string, unknown>;
  assert.equal(params.targetQuery, "上海光华");
  assert.equal((params.target as { text?: string }).text, "上海光华");
});
