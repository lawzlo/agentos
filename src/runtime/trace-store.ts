import { nowIso } from "./id.js";
import type { EventBus } from "./event-bus.js";
import type { ControlPlaneStore } from "./store.js";
import type { RuntimeStep, TraceEventRecord, TraceSnapshot } from "../types/runtime-schema.js";

interface TraceLogInput {
  traceId: string;
  taskId: string;
  role: string;
  type: string;
  message: string;
  payload?: Record<string, unknown>;
  stepId?: string | null;
}

export class TraceStore {
  store: Pick<ControlPlaneStore, "createTrace" | "appendTraceEvent" | "updateTrace" | "getTrace" | "listTraceEvents">;
  eventBus: EventBus;
  constructor(store: TraceStore["store"], eventBus: EventBus) {
    this.store = store;
    this.eventBus = eventBus;
  }

  start(taskId: string, plan: RuntimeStep[] = []) {
    const trace = this.store.createTrace({ taskId, plan, status: "running" });
    this.eventBus.broadcast("trace.started", trace);
    return trace;
  }

  log({ traceId, taskId, role, type, message, payload = {}, stepId = null }: TraceLogInput): TraceEventRecord {
    const event = this.store.appendTraceEvent({
      traceId,
      taskId,
      role,
      type,
      stepId,
      message,
      payload
    });
    this.eventBus.broadcast("trace.event", event);
    return event;
  }

  finish(traceId: string, status: string, summary: string, output: Record<string, unknown> | null) {
    const trace = this.store.updateTrace(traceId, {
      status,
      summary,
      output,
      endedAt: nowIso()
    });
    this.eventBus.broadcast("trace.finished", trace);
    return trace;
  }

  get(traceId: string): TraceSnapshot | null {
    const trace = this.store.getTrace(traceId);
    if (!trace) {
      return null;
    }

    return {
      ...trace,
      events: this.store.listTraceEvents(traceId)
    };
  }
}
