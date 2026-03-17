import { PolicyError, VerificationError } from "../errors.js";

const TARGET_ACTIONS = new Set(["clickTarget", "focusTarget", "typeIntoTarget", "waitForTarget", "extractFromTarget"]);

export class OperatorAgent {
  surfaceRegistry: any;
  traceStore: any;
  policyEngine: any;
  groundingEngine: any;
  constructor({ surfaceRegistry, traceStore, policyEngine, groundingEngine }) {
    this.surfaceRegistry = surfaceRegistry;
    this.traceStore = traceStore;
    this.policyEngine = policyEngine;
    this.groundingEngine = groundingEngine;
  }

  async #resolveTarget({ task, step, workspace, traceId, stepResults }) {
    if (!TARGET_ACTIONS.has(step.action) || step.params?.target) {
      return step;
    }

    const surface = this.surfaceRegistry.get(step.surface);
    const observation = await surface.observe({
      task,
      workspace,
      traceId,
      label: `ground-${step.id}`,
      recentActions: stepResults
    });

    const targetQuery =
      step.params?.targetQuery ??
      step.params?.targetText ??
      step.params?.field ??
      step.params?.label ??
      step.label;

    const grounded = this.groundingEngine.ground({
      taskId: task.id,
      traceId,
      action: step.action,
      goal: task.taskSpec.goal,
      targetQuery,
      worldState: observation
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

  async execute({ task, plan, workspace, traceId, controlGate = null }) {
    const outputs = {};
    const stepResults = [];

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
      const surface = this.surfaceRegistry.get(step.surface);
      if (!surface) {
        throw new Error(`Unknown surface: ${step.surface}`);
      }

      const stepPolicy = this.policyEngine.evaluateStep(task.taskSpec, step);
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
      let verification = null;
      if (step.expect) {
        verification = await surface.verify({
          task,
          step,
          workspace,
          traceId,
          expectation: step.expect
        });

        this.traceStore.log({
          traceId,
          taskId: task.id,
          role: "operator",
          type: verification.ok ? "step.verified" : "step.verification_failed",
          stepId: step.id,
          message: verification.ok ? `Verified ${step.label} in-line` : `Inline verification failed for ${step.label}`,
          payload: verification
        });

        if (!verification.ok) {
          throw new VerificationError(`Verification failed for ${step.label}`, verification);
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
