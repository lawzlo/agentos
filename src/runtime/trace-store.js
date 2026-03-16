import { nowIso } from "./id.js";

export class TraceStore {
  constructor(store, eventBus) {
    this.store = store;
    this.eventBus = eventBus;
  }

  start(taskId, plan = []) {
    const trace = this.store.createTrace({ taskId, plan, status: "running" });
    this.eventBus.broadcast("trace.started", trace);
    return trace;
  }

  log({ traceId, taskId, role, type, message, payload = {}, stepId = null }) {
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

  finish(traceId, status, summary, output) {
    const trace = this.store.updateTrace(traceId, {
      status,
      summary,
      output,
      endedAt: nowIso()
    });
    this.eventBus.broadcast("trace.finished", trace);
    return trace;
  }

  get(traceId) {
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
