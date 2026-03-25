import { VerificationError } from "../errors.js";
import type { SurfaceCoordinator } from "../surface-coordinator.js";
import type { TraceStore } from "../trace-store.js";
import type {
  ExecutionSummary,
  RuntimeStep,
  StepVerification,
  TaskRecord,
  VerificationCheck,
  VerificationSummary,
  WorkspaceRecord
} from "../../types/runtime-schema.js";

interface VerifierSurface {
  verify(args: {
    task: TaskRecord;
    step: RuntimeStep;
    workspace: WorkspaceRecord;
    traceId: string;
    expectation: Record<string, unknown>;
  }): Promise<StepVerification>;
}

interface VerifierAgentOptions {
  surfaceCoordinator: SurfaceCoordinator;
  traceStore: TraceStore;
}

export class VerifierAgent {
  surfaceCoordinator: SurfaceCoordinator;
  traceStore: TraceStore;
  constructor({ surfaceCoordinator, traceStore }: VerifierAgentOptions) {
    this.surfaceCoordinator = surfaceCoordinator;
    this.traceStore = traceStore;
  }

  async verify({
    task,
    plan,
    execution,
    workspace,
    traceId
  }: {
    task: TaskRecord;
    plan: RuntimeStep[];
    execution: ExecutionSummary;
    workspace: WorkspaceRecord;
    traceId: string;
  }): Promise<VerificationSummary> {
    const checks: VerificationCheck[] = [];

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
          payload: { ...existing }
        });

        if (!existing.ok) {
          throw new VerificationError(`Verification failed for ${step.label}`, { ...existing });
        }

        continue;
      }

      if (!step.surface) {
        throw new VerificationError(`Unknown verifier surface: ${step.surface}`, { stepId: step.id });
      }
      const outcome = await this.surfaceCoordinator.withTaskStepSurface(
        {
          surface: step.surface,
          workspaceKey: workspace.id,
          holderId: `task:${task.id}:verify:${step.id}`,
          taskId: task.id,
          reason: `verify ${step.label ?? step.action}`
        },
        async ({ adapter }) =>
          (adapter as VerifierSurface).verify({
            task,
            step,
            workspace,
            traceId,
            expectation: step.expect
          })
      );

      checks.push({ stepId: step.id, ok: outcome.ok, details: outcome.details });

      this.traceStore.log({
        traceId,
        taskId: task.id,
        role: "verifier",
        type: outcome.ok ? "verification.passed" : "verification.failed",
        stepId: step.id,
        message: outcome.ok ? `Verified ${step.label}` : `Verification failed for ${step.label}`,
        payload: { ...outcome }
      });

      if (!outcome.ok) {
        throw new VerificationError(`Verification failed for ${step.label}`, { ...outcome });
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
