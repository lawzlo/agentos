import test from "node:test";
import assert from "node:assert/strict";

import { RecoveryAgent } from "../src/runtime/agents/recovery.js";
import { GroundingError, PolicyError, RecoverableError, TakeoverRequiredError, VerificationError } from "../src/runtime/errors.js";

interface TraceEventLog {
  traceId: string;
  taskId: string;
  role: string;
  type: string;
  message: string;
  payload: Record<string, unknown>;
  stepId: string | null;
}

function makeTraceStore() {
  const events: TraceEventLog[] = [];
  return {
    events,
    log(entry: Omit<TraceEventLog, "stepId"> & { stepId?: string | null }) {
      events.push({ ...entry, stepId: entry.stepId ?? null });
      return entry as unknown as TraceEventLog;
    }
  };
}

test("recovery agent classifies errors by policy and autonomy intent", () => {
  const agent = new RecoveryAgent(makeTraceStore() as never);

  assert.deepEqual(agent.classify(new TakeoverRequiredError("User permission required")), {
    classification: "permission_blocked",
    decision: "takeover",
    nextAction: "request_takeover"
  });

  assert.deepEqual(agent.classify(new PolicyError("policy denied this action")), {
    classification: "permission_blocked",
    decision: "takeover",
    nextAction: "request_takeover"
  });

  assert.deepEqual(agent.classify(new GroundingError("Could not ground target element")), {
    classification: "target_not_found",
    decision: "retry",
    nextAction: "reobserve"
  });

  assert.deepEqual(agent.classify("Navigation changed unexpectedly"), {
    classification: "unexpected_navigation",
    decision: "retry",
    nextAction: "reobserve"
  });

  assert.deepEqual(agent.classify(new VerificationError("verification check failed")), {
    classification: "target_changed",
    decision: "retry",
    nextAction: "reground"
  });

  assert.deepEqual(agent.classify(new RecoverableError("Request timed out")), {
    classification: "surface_changed",
    decision: "retry",
    nextAction: "wait_and_retry"
  });

  assert.deepEqual(agent.classify("Unknown random failure mode"), {
    classification: "low_confidence",
    decision: "fail",
    nextAction: "stop"
  });
});

test("recovery handle records trace payload with attempt and attached error details", () => {
  const store = makeTraceStore();
  const agent = new RecoveryAgent(store as never);
  const error = Object.assign(new Error("Policy denied action"), {
    details: { policy: "forbidden", severity: "high" }
  });

  const result = agent.handle({
    taskId: "task-101",
    traceId: "trace-1",
    attempt: 4,
    error
  });

  assert.deepEqual(result, {
    classification: "permission_blocked",
    decision: "takeover",
    nextAction: "request_takeover"
  });

  assert.equal(store.events.length, 1);
  const entry = store.events[0];
  assert.equal(entry.traceId, "trace-1");
  assert.equal(entry.taskId, "task-101");
  assert.equal(entry.type, "recovery.decision");
  assert.equal(entry.message.includes("permission_blocked"), true);
  assert.equal((entry.payload as { details?: { policy: string } }).details?.policy, "forbidden");
  assert.equal((entry.payload as { attempt?: number }).attempt, 4);
  assert.equal((entry.payload as { classification?: string }).classification, "permission_blocked");
});
