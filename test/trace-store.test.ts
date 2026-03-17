import test from "node:test";
import assert from "node:assert/strict";

import { EventBus } from "../src/runtime/event-bus.js";
import { TraceStore } from "../src/runtime/trace-store.js";

function createMemoryTraceStore() {
  const traces: Map<string, any> = new Map();
  const events: any[] = [];
  let nextId = 1;

  return {
    traces,
    events,
    createTrace(input: any) {
      const record = {
        id: `trace-${String(nextId++).padStart(4, "0")}`,
        status: input.status ?? "running",
        taskId: input.taskId,
        plan: input.plan ?? [],
        startedAt: "2020-01-01T00:00:00.000Z",
        endedAt: null,
        summary: null,
        output: null
      };
      traces.set(record.id, record);
      return record;
    },
    appendTraceEvent(input: any) {
      const event = {
        id: `trace-event-${String(events.length + 1).padStart(4, "0")}`,
        ...input,
        stepId: input.stepId ?? null,
        payload: input.payload ?? {},
        createdAt: "2020-01-01T00:00:01.000Z"
      };
      events.push(event);
      return event;
    },
    updateTrace(traceId: string, patch: any) {
      const existing = traces.get(traceId);
      if (!existing) {
        return null;
      }
      const updated = { ...existing, ...patch };
      traces.set(traceId, updated);
      return updated;
    },
    getTrace(id: string) {
      return traces.get(id) ?? null;
    },
    listTraceEvents(traceId: string) {
      return events.filter((entry) => entry.traceId === traceId);
    }
  };
}

test("trace store emits lifecycle events and returns trace snapshots", async () => {
  const eventBus = new EventBus();
  const store = createMemoryTraceStore();
  const traceStore = new TraceStore(store, eventBus);

  const observed: string[] = [];
  const emittedPayloads: Record<string, Array<unknown>> = {
    started: [],
    event: [],
    finished: [],
    broadcast: []
  };

  eventBus.on("trace.started", (payload) => {
    observed.push("started");
    emittedPayloads.started.push(payload);
  });
  eventBus.on("trace.event", (payload) => {
    observed.push("event");
    emittedPayloads.event.push(payload);
  });
  eventBus.on("trace.finished", (payload) => {
    observed.push("finished");
    emittedPayloads.finished.push(payload);
  });
  eventBus.on("broadcast", (payload) => {
    emittedPayloads.broadcast.push(payload);
  });

  const trace = traceStore.start("task-100");
  const event = traceStore.log({
    traceId: trace.id,
    taskId: "task-100",
    role: "planner",
    type: "plan.generated",
    message: "Generated plan."
  });
  const finished = traceStore.finish(trace.id, "completed", "done", { ok: true });

  assert.equal(observed.at(0), "started");
  assert.equal(observed.at(1), "event");
  assert.equal(observed.at(2), "finished");
  assert.equal(emittedPayloads.started.length, 1);
  assert.equal(emittedPayloads.event.length, 1);
  assert.equal(emittedPayloads.finished.length, 1);

  assert.equal(event.traceId, trace.id);
  assert.equal(event.role, "planner");
  assert.equal(event.type, "plan.generated");

  assert.equal(finished.status, "completed");
  assert.equal(finished.summary, "done");
  assert.deepEqual(finished.output, { ok: true });

  const snapshot = traceStore.get(trace.id);
  assert.equal(snapshot?.id, trace.id);
  assert.equal(snapshot?.events.length, 1);
  assert.equal(snapshot?.events[0]?.id, event.id);
  assert.equal(snapshot?.events[0]?.message, "Generated plan.");

  const firstBroadcast = emittedPayloads.broadcast.find((entry) => {
    return (entry as { type: string }).type === "trace.event";
  });
  assert.equal(Boolean(firstBroadcast), true);
});
