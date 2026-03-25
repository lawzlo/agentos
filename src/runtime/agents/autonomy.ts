import { PlanningError } from "../errors.js";
import { normalizeStep } from "./planner.js";
import type { GroundingEngine } from "../grounding-engine.js";
import type { OpenAICompatibleModelClient } from "../model-client.js";
import type { PolicyEngine } from "../policy-engine.js";
import type { SurfaceCoordinator } from "../surface-coordinator.js";
import type { TraceStore } from "../trace-store.js";
import type {
  AutonomyExecutionResult,
  ExecutionStepResult,
  RuntimeStep,
  StepVerification,
  TaskRecord,
  TaskSpec,
  WorldState,
  WorkspaceRecord
} from "../../types/runtime-schema.js";

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

interface AutonomyDecision {
  done: boolean;
  reason: string;
  summary?: string | null;
  action?: RuntimeStep | null;
}

interface ControlGatePayload {
  phase: string;
  iteration?: number;
  step?: RuntimeStep | null;
  stepResults: ExecutionStepResult[];
}

interface AutonomySurface {
  observe(args: {
    task: TaskRecord;
    workspace: WorkspaceRecord;
    traceId: string;
    label: string;
    recentActions: ExecutionStepResult[];
  }): Promise<WorldState>;
  act(args: {
    task: TaskRecord;
    step: RuntimeStep;
    workspace: WorkspaceRecord;
    traceId: string;
    outputs: Record<string, unknown>;
  }): Promise<unknown>;
  checkpoint(args: {
    task: TaskRecord;
    step: RuntimeStep;
    workspace: WorkspaceRecord;
    traceId: string;
    label: string;
  }): Promise<Record<string, unknown> | null>;
  verify(args: {
    task: TaskRecord;
    step: RuntimeStep;
    workspace: WorkspaceRecord;
    traceId: string;
    expectation: Record<string, unknown>;
  }): Promise<StepVerification>;
}

interface AutonomyAgentOptions {
  modelClient: OpenAICompatibleModelClient;
  surfaceCoordinator: SurfaceCoordinator;
  traceStore: TraceStore;
  policyEngine: PolicyEngine;
  groundingEngine: GroundingEngine;
}

export class AutonomyAgent {
  modelClient: OpenAICompatibleModelClient;
  surfaceCoordinator: SurfaceCoordinator;
  traceStore: TraceStore;
  policyEngine: PolicyEngine;
  groundingEngine: GroundingEngine;
  constructor({ modelClient, surfaceCoordinator, traceStore, policyEngine, groundingEngine }: AutonomyAgentOptions) {
    this.modelClient = modelClient;
    this.surfaceCoordinator = surfaceCoordinator;
    this.traceStore = traceStore;
    this.policyEngine = policyEngine;
    this.groundingEngine = groundingEngine;
  }

  isEnabled(taskSpec: TaskSpec) {
    return taskSpec.executionMode === "autonomous" || taskSpec.autonomy?.enabled === true;
  }

  async execute({
    task,
    workspace,
    traceId,
    controlGate = null
  }: {
    task: TaskRecord;
    workspace: WorkspaceRecord;
    traceId: string;
    controlGate?: ((payload: ControlGatePayload) => Promise<void>) | null;
  }): Promise<AutonomyExecutionResult> {
    if (!this.modelClient.isConfigured()) {
      throw new PlanningError("Autonomous execution requires model configuration.");
    }

    const taskSpec = task.taskSpec as TaskSpec;
    const autonomy = taskSpec.autonomy ?? {};
    let activeSurface: "browser" | "desktop" = task.preferredSurface === "auto"
      ? autonomy.surface ?? (taskSpec.inputs?.startUrl ? "browser" : "desktop")
      : task.preferredSurface;

    const maxSteps = Number(autonomy.maxSteps ?? 8);
    const outputs: Record<string, unknown> = {};
    const stepResults: ExecutionStepResult[] = [];

    for (let attempt = 0; attempt < maxSteps; attempt += 1) {
      if (controlGate) {
        await controlGate({
          phase: "before_iteration",
          iteration: attempt,
          stepResults
        });
      }

      const observation = await this.surfaceCoordinator.withTaskStepSurface(
        {
          surface: activeSurface,
          workspaceKey: workspace.id,
          holderId: `task:${task.id}:autonomy:${attempt + 1}:observe`,
          taskId: task.id,
          reason: `autonomy observe ${activeSurface}`
        },
        async ({ adapter }) =>
          (adapter as AutonomySurface).observe({
            task,
            workspace,
            traceId,
            label: `observe-${attempt + 1}`,
            recentActions: stepResults
          })
      );

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

      const decision = (await this.modelClient.decideNextAction({
        taskSpec,
        preferredSurface: activeSurface,
        observation,
        previousSteps: stepResults.map((step) => ({
          label: step.label,
          action: step.action,
          surface: step.surface,
          result: step.result
        })),
        allowedActions: ALLOWED_ACTIONS[activeSurface] ?? []
      })) as AutonomyDecision;

      this.traceStore.log({
        traceId,
        taskId: task.id,
        role: "autonomy",
        type: "autonomy.decision",
        message: decision.reason,
        payload: { ...decision }
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
        throw new PlanningError("Autonomy model returned done=false without an action.", { ...decision });
      }

      const step = normalizeStep(decision.action, attempt);
      if (controlGate) {
        await controlGate({
          phase: "before_step",
          step,
          stepResults
        });
      }

      const stepPolicy = this.policyEngine.evaluateStep(taskSpec, step);
      if (!stepPolicy.allowed) {
        throw new PlanningError(`Autonomy policy denied ${step.label}`, stepPolicy);
      }

      const previousSurface = activeSurface;
      activeSurface = step.surface;
      if (!step.surface) {
        throw new PlanningError(`Unknown autonomous step surface: ${step.surface}`);
      }

      let executableStep = step;
      if (TARGET_ACTIONS.has(step.action) && !step.params?.target) {
        let targetObservation = observation;
        if (step.surface !== previousSurface) {
          targetObservation = await this.surfaceCoordinator.withTaskStepSurface(
            {
              surface: step.surface,
              workspaceKey: workspace.id,
              holderId: `task:${task.id}:autonomy:${attempt + 1}:ground`,
              taskId: task.id,
              reason: `autonomy ground ${step.surface}`
            },
            async ({ adapter }) =>
              (adapter as AutonomySurface).observe({
                task,
                workspace,
                traceId,
                label: `observe-ground-${attempt + 1}`,
                recentActions: stepResults
              })
          );
        }

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

      const execution = await this.surfaceCoordinator.withTaskStepSurface(
        {
          surface: executableStep.surface,
          workspaceKey: workspace.id,
          holderId: `task:${task.id}:autonomy:${attempt + 1}:step:${executableStep.id}`,
          taskId: task.id,
          reason: executableStep.label ?? executableStep.action
        },
        async ({ adapter }) => {
          const stepSurface = adapter as AutonomySurface;
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

          let verification: StepVerification | null = null;
          if (executableStep.expect) {
            verification = await stepSurface.verify({
              task,
              step: executableStep,
              workspace,
              traceId,
              expectation: executableStep.expect
            });

            if (!verification.ok) {
              throw new PlanningError(`Autonomous expectation failed for ${executableStep.label}`, { ...verification });
            }
          }

          return { result, checkpoint, verification };
        }
      );

      if (executableStep.saveAs) {
        outputs[executableStep.saveAs] = execution.result;
      }

      stepResults.push({
        stepId: executableStep.id,
        label: executableStep.label,
        surface: executableStep.surface,
        action: executableStep.action,
        result: execution.result,
        checkpoint: execution.checkpoint,
        verification: execution.verification
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
