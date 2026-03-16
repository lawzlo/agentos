import { PlanningError } from "../errors.js";
import { normalizeStep } from "./planner.js";

const ALLOWED_ACTIONS = {
  browser: [
    "goto",
    "click",
    "type",
    "press",
    "wait",
    "waitFor",
    "extractText",
    "capture",
    "clickTarget",
    "focusTarget",
    "typeIntoTarget",
    "waitForTarget",
    "extractFromTarget",
    "scrollSurface"
  ],
  desktop: [
    "focusApp",
    "clickText",
    "typeText",
    "pressKey",
    "moveMouse",
    "clickAt",
    "scroll",
    "waitForText",
    "ocrScreen",
    "wait",
    "capture",
    "clickTarget",
    "focusTarget",
    "typeIntoTarget",
    "waitForTarget",
    "extractFromTarget",
    "scrollSurface"
  ]
};

const TARGET_ACTIONS = new Set(["clickTarget", "focusTarget", "typeIntoTarget", "waitForTarget", "extractFromTarget"]);

export class AutonomyAgent {
  constructor({ modelClient, surfaceRegistry, traceStore, policyEngine, groundingEngine }) {
    this.modelClient = modelClient;
    this.surfaceRegistry = surfaceRegistry;
    this.traceStore = traceStore;
    this.policyEngine = policyEngine;
    this.groundingEngine = groundingEngine;
  }

  isEnabled(taskSpec) {
    return taskSpec.executionMode === "autonomous" || taskSpec.autonomy?.enabled === true;
  }

  async execute({ task, workspace, traceId, controlGate = null }) {
    if (!this.modelClient.isConfigured()) {
      throw new PlanningError("Autonomous execution requires model configuration.");
    }

    let activeSurface = task.preferredSurface === "auto"
      ? task.taskSpec.autonomy?.surface ?? (task.taskSpec.inputs?.startUrl ? "browser" : "desktop")
      : task.preferredSurface;

    const maxSteps = Number(task.taskSpec.autonomy?.maxSteps ?? 8);
    const outputs = {};
    const stepResults = [];

    for (let attempt = 0; attempt < maxSteps; attempt += 1) {
      if (controlGate) {
        await controlGate({
          phase: "before_iteration",
          iteration: attempt,
          stepResults
        });
      }

      let surface = this.surfaceRegistry.get(activeSurface);
      if (!surface) {
        throw new PlanningError(`Unknown autonomous surface: ${activeSurface}`);
      }

      const observation = await surface.observe({
        task,
        workspace,
        traceId,
        label: `observe-${attempt + 1}`,
        recentActions: stepResults
      });

      this.traceStore.log({
        traceId,
        taskId: task.id,
        role: "autonomy",
        type: "autonomy.observed",
        message: `Captured ${activeSurface} observation.`,
        payload: {
          surface: activeSurface,
          summary: observation.summary ?? null,
          artifactPath: observation.capture?.path ?? null
        }
      });

      const decision = await this.modelClient.decideNextAction({
        taskSpec: task.taskSpec,
        preferredSurface: activeSurface,
        observation,
        previousSteps: stepResults.map((step) => ({
          label: step.label,
          action: step.action,
          surface: step.surface,
          result: step.result
        })),
        allowedActions: ALLOWED_ACTIONS[activeSurface] ?? []
      });

      this.traceStore.log({
        traceId,
        taskId: task.id,
        role: "autonomy",
        type: "autonomy.decision",
        message: decision.reason,
        payload: decision
      });

      if (decision.done) {
        return {
          outputs,
          stepResults,
          verification: {
            ok: true,
            confidence: 0.75,
            mode: "autonomous"
          },
          summary: decision.summary ?? decision.reason
        };
      }

      if (!decision.action) {
        throw new PlanningError("Autonomy model returned done=false without an action.", decision);
      }

      const step = normalizeStep(decision.action, attempt);
      if (controlGate) {
        await controlGate({
          phase: "before_step",
          step,
          stepResults
        });
      }

      const stepPolicy = this.policyEngine.evaluateStep(task.taskSpec, step);
      if (!stepPolicy.allowed) {
        throw new PlanningError(`Autonomy policy denied ${step.label}`, stepPolicy);
      }

      const previousSurface = activeSurface;
      activeSurface = step.surface;
      const stepSurface = this.surfaceRegistry.get(step.surface);
      if (!stepSurface) {
        throw new PlanningError(`Unknown autonomous step surface: ${step.surface}`);
      }

      let executableStep = step;
      if (TARGET_ACTIONS.has(step.action) && !step.params?.target) {
        let targetObservation = observation;
        if (step.surface !== previousSurface) {
          surface = this.surfaceRegistry.get(step.surface);
          targetObservation = await surface.observe({
            task,
            workspace,
            traceId,
            label: `observe-ground-${attempt + 1}`,
            recentActions: stepResults
          });
        }

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
          worldState: targetObservation
        });

        executableStep = {
          ...step,
          params: {
            ...step.params,
            targetQuery,
            target: grounded.target
          }
        };
      }

      const result = await stepSurface.act({
        task,
        step: executableStep,
        workspace,
        traceId,
        outputs
      });

      const checkpoint =
        executableStep.checkpoint === false
          ? null
          : await stepSurface.checkpoint({
              task,
              step: executableStep,
              workspace,
              traceId,
              label: `${executableStep.label} checkpoint`
            });

      if (executableStep.saveAs) {
        outputs[executableStep.saveAs] = result;
      }

      if (executableStep.expect) {
        const verification = await stepSurface.verify({
          task,
          step: executableStep,
          workspace,
          traceId,
          expectation: executableStep.expect
        });

        if (!verification.ok) {
          throw new PlanningError(`Autonomous expectation failed for ${executableStep.label}`, verification);
        }
      }

      stepResults.push({
        stepId: executableStep.id,
        label: executableStep.label,
        surface: executableStep.surface,
        action: executableStep.action,
        result,
        checkpoint
      });

      if (controlGate) {
        await controlGate({
          phase: "after_step",
          step: executableStep,
          stepResults
        });
      }
    }

    throw new PlanningError(`Autonomous execution reached the max step budget (${maxSteps}).`);
  }
}
