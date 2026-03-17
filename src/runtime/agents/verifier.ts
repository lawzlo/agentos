import { VerificationError } from "../errors.js";

export class VerifierAgent {
  surfaceRegistry: any;
  traceStore: any;
  constructor({ surfaceRegistry, traceStore }) {
    this.surfaceRegistry = surfaceRegistry;
    this.traceStore = traceStore;
  }

  async verify({ task, plan, execution, workspace, traceId }) {
    const checks = [];

    for (const step of plan) {
      if (!step.expect) {
        continue;
      }

      const existing = execution.stepResults?.find((entry) => entry.stepId === step.id)?.verification;
      if (existing) {
        checks.push({ stepId: step.id, ok: existing.ok, details: existing.details });

        this.traceStore.log({
          traceId,
          taskId: task.id,
          role: "verifier",
          type: existing.ok ? "verification.passed" : "verification.failed",
          stepId: step.id,
          message: existing.ok ? `Accepted inline verification for ${step.label}` : `Inline verification failed for ${step.label}`,
          payload: existing
        });

        if (!existing.ok) {
          throw new VerificationError(`Verification failed for ${step.label}`, existing);
        }

        continue;
      }

      const surface = this.surfaceRegistry.get(step.surface);
      const outcome = await surface.verify({
        task,
        step,
        workspace,
        traceId,
        expectation: step.expect
      });

      checks.push({ stepId: step.id, ok: outcome.ok, details: outcome.details });

      this.traceStore.log({
        traceId,
        taskId: task.id,
        role: "verifier",
        type: outcome.ok ? "verification.passed" : "verification.failed",
        stepId: step.id,
        message: outcome.ok ? `Verified ${step.label}` : `Verification failed for ${step.label}`,
        payload: outcome
      });

      if (!outcome.ok) {
        throw new VerificationError(`Verification failed for ${step.label}`, outcome);
      }
    }

    const summary = {
      ok: true,
      confidence: checks.length ? 0.9 : 0.65,
      checks,
      outputs: execution.outputs
    };

    this.traceStore.log({
      traceId,
      taskId: task.id,
      role: "verifier",
      type: "verification.summary",
      message: "Verifier accepted the execution result.",
      payload: summary
    });

    return summary;
  }
}
