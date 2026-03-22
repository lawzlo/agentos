import { PolicyError, VerificationError } from "../errors.js";
import type { PolicyEngine } from "../policy-engine.js";
import type { SurfaceRegistry } from "../surface-registry.js";
import type { TraceStore } from "../trace-store.js";
import type { GroundingEngine } from "../grounding-engine.js";
import type {
  ExecutionStepResult,
  ExecutionSummary,
  RuntimeStep,
  StepVerification,
  TaskRecord,
  TaskSpec,
  WorldState,
  WorkspaceRecord
} from "../../types/runtime-schema.js";

const TARGET_ACTIONS = new Set([
  "clickTarget",
  "focusTarget",
  "typeIntoTarget",
  "waitForTarget",
  "extractFromTarget",
  "download",
  "upload"
]);

interface ControlGatePayload {
  phase: string;
  step?: RuntimeStep | null;
  stepResults: ExecutionStepResult[];
}

interface ExecutableSurface {
  observe(args: {
    task: TaskRecord;
    workspace: WorkspaceRecord;
    traceId: string;
    label: string;
    recentActions: ExecutionStepResult[];
  }): Promise<unknown>;
  act(args: {
    task: TaskRecord;
    step: RuntimeStep;
    workspace: WorkspaceRecord;
    traceId: string;
    outputs: Record<string, unknown>;
  }): Promise<unknown>;
  verify(args: {
    task: TaskRecord;
    step: RuntimeStep;
    workspace: WorkspaceRecord;
    traceId: string;
    expectation: Record<string, unknown>;
  }): Promise<StepVerification>;
  checkpoint(args: {
    task: TaskRecord;
    step: RuntimeStep;
    workspace: WorkspaceRecord;
    traceId: string;
    label: string;
  }): Promise<Record<string, unknown> | null>;
}

interface OperatorAgentOptions {
  surfaceRegistry: SurfaceRegistry;
  traceStore: TraceStore;
  policyEngine: PolicyEngine;
  groundingEngine: GroundingEngine;
}

export class OperatorAgent {
  surfaceRegistry: SurfaceRegistry;
  traceStore: TraceStore;
  policyEngine: PolicyEngine;
  groundingEngine: GroundingEngine;
  constructor({ surfaceRegistry, traceStore, policyEngine, groundingEngine }: OperatorAgentOptions) {
    this.surfaceRegistry = surfaceRegistry;
    this.traceStore = traceStore;
    this.policyEngine = policyEngine;
    this.groundingEngine = groundingEngine;
  }

  async #waitForInlineVerification({
    surface,
    task,
    step,
    workspace,
    traceId,
    initialVerification
  }: {
    surface: ExecutableSurface;
    task: TaskRecord;
    step: RuntimeStep;
    workspace: WorkspaceRecord;
    traceId: string;
    initialVerification: StepVerification;
  }): Promise<StepVerification> {
    const timeoutMs = Math.max(0, Number(step.params?.timeoutMs ?? 0));
    const pollMs = Math.max(50, Number(step.params?.pollMs ?? 400));
    if (step.action !== "wait" || !step.expect || initialVerification.ok || timeoutMs <= 0) {
      return initialVerification;
    }

    const started = Date.now();
    let verification = initialVerification;
    while (!verification.ok && Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      verification = await surface.verify({
        task,
        step,
        workspace,
        traceId,
        expectation: step.expect
      });
      if (verification.ok) {
        return verification;
      }
    }

    return verification;
  }

  async #resolveTarget({
    task,
    step,
    workspace,
    traceId,
    stepResults
  }: {
    task: TaskRecord;
    step: RuntimeStep;
    workspace: WorkspaceRecord;
    traceId: string;
    stepResults: ExecutionStepResult[];
  }): Promise<RuntimeStep> {
    if (!TARGET_ACTIONS.has(step.action) || step.params?.target) {
      return step;
    }

    const surface = this.surfaceRegistry.get<ExecutableSurface>(step.surface);
    const observation = await surface.observe({
      task,
      workspace,
      traceId,
      label: `ground-${step.id}`,
      recentActions: stepResults
    });

    const taskSpec = task.taskSpec as TaskSpec;
    const targetQuery = String(
      step.params?.targetQuery ??
        step.params?.targetText ??
        step.params?.field ??
        step.params?.label ??
        step.label ??
        ""
    );

    const grounded = this.groundingEngine.ground({
      taskId: task.id,
      traceId,
      action: step.action,
      goal: taskSpec.goal,
      targetQuery,
      worldState: observation as WorldState
    });

    this.traceStore.log({
      traceId,
      taskId: task.id,
      role: "operator",
      type: "target.grounded",
      stepId: step.id,
      message: `Resolved target for ${step.label}.`,
      payload: {
        targetQuery,
        targetId: grounded.targetId,
        confidence: grounded.confidence,
        resolutionMode: grounded.resolutionMode
      }
    });

    return {
      ...step,
      params: {
        ...step.params,
        targetQuery,
        target: grounded.target
      }
    };
  }

  async execute({
    task,
    plan,
    workspace,
    traceId,
    controlGate = null
  }: {
    task: TaskRecord;
    plan: RuntimeStep[];
    workspace: WorkspaceRecord;
    traceId: string;
    controlGate?: ((payload: ControlGatePayload) => Promise<void>) | null;
  }): Promise<ExecutionSummary> {
    const outputs: Record<string, unknown> = {};
    const stepResults: ExecutionStepResult[] = [];
    const taskSpec = task.taskSpec as TaskSpec;

    for (const rawStep of plan) {
      if (controlGate) {
        await controlGate({
          phase: "before_step",
          step: rawStep,
          stepResults
        });
      }

      const step = await this.#resolveTarget({
        task,
        step: rawStep,
        workspace,
        traceId,
        stepResults
      });
      const surface = this.surfaceRegistry.get<ExecutableSurface>(step.surface);
      if (!surface) {
        throw new Error(`Unknown surface: ${step.surface}`);
      }

      const stepPolicy = this.policyEngine.evaluateStep(taskSpec, step);
      if (!stepPolicy.allowed) {
        throw new PolicyError(`Policy denied step ${step.label}`, {
          step,
          reasons: stepPolicy.reasons
        });
      }

      this.traceStore.log({
        traceId,
        taskId: task.id,
        role: "operator",
        type: "step.started",
        stepId: step.id,
        message: `Starting ${step.label}`,
        payload: { action: step.action, surface: step.surface, params: step.params }
      });

      const result = await surface.act({ task, step, workspace, traceId, outputs });
      let verification: StepVerification | null = null;
      if (step.expect) {
        verification = await surface.verify({
          task,
          step,
          workspace,
          traceId,
          expectation: step.expect
        });
        verification = await this.#waitForInlineVerification({
          surface,
          task,
          step,
          workspace,
          traceId,
          initialVerification: verification
        });

        this.traceStore.log({
          traceId,
          taskId: task.id,
          role: "operator",
          type: verification.ok ? "step.verified" : "step.verification_failed",
          stepId: step.id,
          message: verification.ok ? `Verified ${step.label} in-line` : `Inline verification failed for ${step.label}`,
          payload: { ...verification }
        });

        if (!verification.ok) {
          throw new VerificationError(`Verification failed for ${step.label}`, { ...verification });
        }
      }
      const checkpoint =
        step.checkpoint === false
          ? null
          : await surface.checkpoint({
              task,
              step,
              workspace,
              traceId,
              label: `${step.label} checkpoint`
            });

      if (step.saveAs) {
        outputs[step.saveAs] = result;
      }

      stepResults.push({
        stepId: step.id,
        label: step.label,
        surface: step.surface,
        action: step.action,
        result,
        checkpoint,
        verification
      });

      this.traceStore.log({
        traceId,
        taskId: task.id,
        role: "operator",
        type: "step.completed",
        stepId: step.id,
        message: `Completed ${step.label}`,
        payload: { result, checkpoint }
      });

      if (controlGate) {
        await controlGate({
          phase: "after_step",
          step,
          stepResults
        });
      }
    }

    return { outputs, stepResults };
  }
}
