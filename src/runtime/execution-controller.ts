import { ExecutionStoppedError } from "./errors.js";

function nowIso() {
  return new Date().toISOString();
}

function snapshot(state) {
  if (!state) {
    return null;
  }

  return {
    mode: state.mode,
    reason: state.reason,
    source: state.source,
    updatedAt: state.updatedAt
  };
}

export class ExecutionController {
  states: any;
  constructor() {
    this.states = new Map();
  }

  registerTask(taskId) {
    if (!this.states.has(taskId)) {
      this.states.set(taskId, {
        mode: "agent",
        reason: null,
        source: "system",
        updatedAt: nowIso(),
        waiters: []
      });
    }

    return snapshot(this.states.get(taskId));
  }

  unregisterTask(taskId) {
    const state = this.states.get(taskId);
    if (!state) {
      return;
    }

    for (const waiter of state.waiters) {
      waiter.reject(new ExecutionStoppedError("Execution finished."));
    }

    this.states.delete(taskId);
  }

  getState(taskId) {
    return snapshot(this.states.get(taskId) ?? null);
  }

  setMode(taskId, mode, { reason = null, source = "system" } = {}) {
    if (!this.states.has(taskId)) {
      this.registerTask(taskId);
    }
    const state = this.states.get(taskId);
    state.mode = mode;
    state.reason = reason;
    state.source = source;
    state.updatedAt = nowIso();

    if (mode === "agent") {
      for (const waiter of state.waiters.splice(0)) {
        waiter.resolve(snapshot(state));
      }
    }

    if (mode === "stopped") {
      for (const waiter of state.waiters.splice(0)) {
        waiter.reject(new ExecutionStoppedError(reason ?? "Execution stopped."));
      }
    }

    return snapshot(state);
  }

  async waitForAgent(taskId) {
    const state = this.states.get(taskId);
    if (!state || state.mode === "agent") {
      return this.getState(taskId);
    }

    if (state.mode === "stopped") {
      throw new ExecutionStoppedError(state.reason ?? "Execution stopped.");
    }

    await new Promise((resolve, reject) => {
      state.waiters.push({ resolve, reject });
    });

    return this.waitForAgent(taskId);
  }
}
