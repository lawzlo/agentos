const state = globalThis.__agentosStagehandStubState ?? {
  instances: []
};

globalThis.__agentosStagehandStubState = state;

export class Stagehand {
  constructor(args) {
    this.args = args;
    state.instances.push({
      args,
      calls: []
    });
    this.record = state.instances[state.instances.length - 1];
  }

  async init() {
    this.record.calls.push({ method: "init" });
  }

  async close() {
    this.record.calls.push({ method: "close" });
  }

  async act(instruction, options = {}) {
    this.record.calls.push({ method: "act", instruction, options });
    return { ok: true, instruction };
  }

  async observe(instruction, options = {}) {
    this.record.calls.push({ method: "observe", instruction, options });
    return [{ action: "stub-action", instruction }];
  }

  async extract(instruction, schema, options = {}) {
    this.record.calls.push({ method: "extract", instruction, schema, options });
    return { extracted: true, instruction };
  }

  agent() {
    this.record.calls.push({ method: "agent" });
    return {
      execute: async (input) => {
        this.record.calls.push({ method: "agent.execute", input });
        return { completed: true, instruction: input.instruction };
      }
    };
  }
}
