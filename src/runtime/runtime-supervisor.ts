import { buildTeachRecording } from "./teach-recorder.js";
import { ExecutionStoppedError, ExecutionYieldedError } from "./errors.js";
import type { AutonomyAgent } from "./agents/autonomy.js";
import type { OperatorAgent } from "./agents/operator.js";
import type { PlannerAgent } from "./agents/planner.js";
import type { RecoveryAgent } from "./agents/recovery.js";
import type { VerifierAgent } from "./agents/verifier.js";
import type { ControlPlane } from "./control-plane.js";
import type { EventBus } from "./event-bus.js";
import type { ExecutionController } from "./execution-controller.js";
import type { MemoryStore } from "./memory-store.js";
import type { PolicyEngine } from "./policy-engine.js";
import type { SurfaceRegistry } from "./surface-registry.js";
import type { ControlPlaneStore } from "./store.js";
import type { TraceStore } from "./trace-store.js";
import type { WatchScheduler } from "./watch-scheduler.js";
import type { WorkspaceManager } from "./workspace-manager.js";
import type {
  AutonomyExecutionResult,
  ExecutionStepResult,
  TaskRecord,
  TaskSnapshot,
  TaskSpec,
  VerificationSummary
} from "../types/runtime-schema.js";

interface RuntimeConnector {
  start(): Promise<void>;
  stop?(): Promise<void>;
}

interface RecoveryDecision {
  decision: string;
  classification?: string;
  nextAction?: string;
}

type RuntimeResult = Record<string, unknown> & {
  verification?: VerificationSummary | AutonomyExecutionResult["verification"];
  outputs?: Record<string, unknown>;
  steps?: ExecutionStepResult[];
  summary?: string | null;
  manualTeachSteps?: unknown[];
  manualCorrections?: unknown[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorName(error: unknown): string | null {
  return error instanceof Error ? error.name : null;
}

function errorDetails(error: unknown): Record<string, unknown> | null {
  if (error && typeof error === "object" && "details" in error) {
    const details = (error as { details?: unknown }).details;
    if (details && typeof details === "object") {
      return details as Record<string, unknown>;
    }
  }

  return null;
}

interface RuntimeSupervisorOptions {
  controlPlane: Pick<
    ControlPlane,
    "mergePersistedResult" | "getTask" | "decorateTask" | "controlTask" | "saveTaskAsSkill" | "saveTaskAsWatchRule"
  >;
  store: Pick<ControlPlaneStore, "listTasksByStatuses" | "updateTask" | "getTask" | "updateTrace" | "close">;
  traceStore: TraceStore;
  eventBus: EventBus;
  executionController: ExecutionController;
  workspaceManager: WorkspaceManager;
  policyEngine: PolicyEngine;
  autonomy: AutonomyAgent;
  planner: PlannerAgent;
  operator: OperatorAgent;
  verifier: VerifierAgent;
  recovery: RecoveryAgent;
  memoryStore: MemoryStore;
  watchScheduler: WatchScheduler;
  connectors: RuntimeConnector[];
  surfaceRegistry: SurfaceRegistry;
}

export class RuntimeSupervisor {
  controlPlane: RuntimeSupervisorOptions["controlPlane"];
  store: RuntimeSupervisorOptions["store"];
  traceStore: TraceStore;
  eventBus: EventBus;
  executionController: ExecutionController;
  workspaceManager: WorkspaceManager;
  policyEngine: PolicyEngine;
  autonomy: AutonomyAgent;
  planner: PlannerAgent;
  operator: OperatorAgent;
  verifier: VerifierAgent;
  recovery: RecoveryAgent;
  memoryStore: MemoryStore;
  watchScheduler: WatchScheduler;
  connectors: RuntimeConnector[];
  surfaceRegistry: SurfaceRegistry;
  queue: string[];
  running: boolean;
  drainPromise: Promise<void> | null;
  acceptingNewTasks: boolean;

  constructor({
    controlPlane,
    store,
    traceStore,
    eventBus,
    executionController,
    workspaceManager,
    policyEngine,
    autonomy,
    planner,
    operator,
    verifier,
    recovery,
    memoryStore,
    watchScheduler,
    connectors,
    surfaceRegistry
  }: RuntimeSupervisorOptions) {
    this.controlPlane = controlPlane;
    this.store = store;
    this.traceStore = traceStore;
    this.eventBus = eventBus;
    this.executionController = executionController;
    this.workspaceManager = workspaceManager;
    this.policyEngine = policyEngine;
    this.autonomy = autonomy;
    this.planner = planner;
    this.operator = operator;
    this.verifier = verifier;
    this.recovery = recovery;
    this.memoryStore = memoryStore;
    this.watchScheduler = watchScheduler;
    this.connectors = connectors;
    this.surfaceRegistry = surfaceRegistry;
    this.queue = [];
    this.running = false;
    this.drainPromise = null;
    this.acceptingNewTasks = true;
  }

  enqueue(taskId: string): void {
    if (!this.acceptingNewTasks) {
      return;
    }
    if (!this.queue.includes(taskId)) {
      this.queue.push(taskId);
    }
    this.scheduleDrain();
  }

  ensureQueuedTask(taskId: string): void {
    if (!this.acceptingNewTasks) {
      return;
    }
    const task = this.store.getTask(taskId);
    if (!task || task.status !== "queued") {
      return;
    }
    if (!this.queue.includes(taskId)) {
      this.queue.push(taskId);
    }
    this.scheduleDrain();
  }

  scheduleDrain(): void {
    if (this.drainPromise) {
      if (this.running) {
        return;
      }
      this.drainPromise = null;
    }

    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = null;
      if (this.queue.length && this.acceptingNewTasks) {
        this.scheduleDrain();
      }
    });
  }

  async restoreRuntimeState(): Promise<{
    requeuedTaskCount: number;
    interruptedTaskCount: number;
  }> {
    const queued = this.store.listTasksByStatuses(["queued"]);
    for (const task of queued) {
      this.enqueue(task.id);
    }

    const interrupted = this.store.listTasksByStatuses(["planning", "running", "verifying", "paused", "takeover"]);
    for (const task of interrupted) {
      const updated = this.store.updateTask(task.id, {
        status: "interrupted",
        error: "Daemon restarted before task completion."
      });
      if (updated?.traceId) {
        this.traceStore.finish(
          updated.traceId,
          "interrupted",
          "Daemon restarted before task completion.",
          this.controlPlane.mergePersistedResult(task.id, { details: { reason: "daemon_restart" } })
        );
      }
      this.eventBus.broadcast("task.updated", this.controlPlane.getTask(task.id));
    }

    return {
      requeuedTaskCount: queued.length,
      interruptedTaskCount: interrupted.length
    };
  }

  async waitForExecutionAccess({
    taskId,
    traceId,
    phase,
    step = null
  }: {
    taskId: string;
    traceId: string;
    phase: string;
    step?: { id?: string } | null;
  }) {
    const control = this.executionController.getState(taskId);
    if (!control || control.mode === "agent") {
      return;
    }

    const waitingTask = this.store.getTask(taskId);
    const waitingStatus = control.mode === "takeover" ? "takeover" : "paused";
    if (waitingTask && waitingTask.status !== waitingStatus) {
      this.store.updateTask(taskId, {
        status: waitingStatus,
        error: control.mode === "takeover" ? control.reason : waitingTask.error
      });
      this.eventBus.broadcast("task.updated", this.controlPlane.getTask(taskId));
    }

    this.traceStore.log({
      traceId,
      taskId,
      role: "operator",
      type: "control.waiting",
      stepId: step?.id ?? null,
      message: `Execution is waiting in ${control.mode} mode.`,
      payload: {
        phase,
        mode: control.mode,
        source: control.source,
        reason: control.reason
      }
    });

    if (control.mode === "takeover") {
      throw new ExecutionYieldedError(control.reason ?? "Execution yielded for manual takeover.", {
        phase,
        source: control.source
      });
    }

    await this.executionController.waitForAgent(taskId);

    const current = this.store.getTask(taskId);
    if (current && !["completed", "failed"].includes(current.status)) {
      this.store.updateTask(taskId, {
        status: "running",
        error: null
      });
      this.eventBus.broadcast("task.updated", this.controlPlane.getTask(taskId));
    }

    this.traceStore.log({
      traceId,
      taskId,
      role: "operator",
      type: "control.released",
      stepId: step?.id ?? null,
      message: "Execution resumed after manual control.",
      payload: { phase }
    });
  }

  async requestRecoveryTakeover({
    taskId,
    traceId,
    error,
    decision
  }: {
    taskId: string;
    traceId: string;
    error: unknown;
    decision: { classification?: string; nextAction?: string };
  }) {
    this.controlPlane.controlTask(taskId, "request_takeover", {
      source: "recovery",
      reason: `Recovery requested takeover: ${errorMessage(error)}`
    });

    this.traceStore.log({
      traceId,
      taskId,
      role: "recovery",
      type: "recovery.takeover_requested",
      message: "Recovery handed the task over for manual correction.",
      payload: {
        classification: decision.classification,
        nextAction: decision.nextAction
      }
    });
  }

  async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.queue.length) {
        const taskId = this.queue.shift();
        try {
          await this.runTask(taskId);
        } catch (error: unknown) {
          const task = this.store.updateTask(taskId, {
            status: "failed",
            error: errorMessage(error)
          });
          this.eventBus.broadcast("task.updated", this.controlPlane.decorateTask(task));
        }
      }
    } finally {
      this.running = false;
    }
  }

  async waitForIdle(timeoutMs = 5000): Promise<void> {
    const started = Date.now();
    while (this.queue.length > 0 || this.drainPromise) {
      if (!this.drainPromise && this.queue.length) {
        this.scheduleDrain();
        continue;
      }

      const activeDrain = this.drainPromise;
      if (!activeDrain) {
        continue;
      }

      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) {
        throw new Error("Timed out waiting for queued tasks to finish during shutdown");
      }

      await Promise.race([
        activeDrain,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            reject(new Error("Timed out waiting for queued tasks to finish during shutdown"));
          }, remaining);
          activeDrain.finally(() => clearTimeout(timer)).catch(() => clearTimeout(timer));
        })
      ]);
    }
  }

  async runTask(taskId: string): Promise<void> {
    let task = this.store.getTask(taskId);
    if (!task) {
      return;
    }

    this.executionController.registerTask(taskId);

    try {
      task = this.store.updateTask(taskId, { status: "planning" });
      const initialTaskSpec = task.taskSpec as TaskSpec;
      const workspace = await this.workspaceManager.prepare(taskId, initialTaskSpec);
      task = this.store.updateTask(taskId, { workspaceId: workspace.id });
      const existingTrace = task.traceId ? this.traceStore.get(task.traceId) : null;
      const trace =
        existingTrace && !existingTrace.endedAt ? existingTrace : this.traceStore.start(taskId, []);
      if (task.traceId !== trace.id) {
        task = this.store.updateTask(taskId, { traceId: trace.id });
      }

      this.traceStore.log({
        traceId: trace.id,
        taskId,
        role: "sentinel",
        type: "task.accepted",
        message: "Sentinel accepted the task into the inbox.",
        payload: { workspaceId: workspace.id, preferredSurface: task.preferredSurface }
      });

      const evaluation = this.policyEngine.evaluateTask(initialTaskSpec);
      this.traceStore.log({
        traceId: trace.id,
        taskId,
        role: "sentinel",
        type: "policy.evaluated",
        message: "Policy baseline evaluated for the task.",
        payload: evaluation
      });

      const maxAttempts = 3;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          await this.waitForExecutionAccess({
            taskId,
            traceId: trace.id,
            phase: "before_attempt"
          });

          task = this.store.updateTask(taskId, { status: "planning", error: null });
          this.eventBus.broadcast("task.updated", this.controlPlane.getTask(taskId));

          let result: RuntimeResult;
          const controlGate = async ({ phase, step }: { phase: string; step?: { id?: string } | null }) =>
            this.waitForExecutionAccess({
              taskId,
              traceId: trace.id,
              phase,
              step
            });

          const taskSpec = task.taskSpec as TaskSpec;

          if (this.autonomy.isEnabled(taskSpec)) {
            const autonomySurface = task.preferredSurface === "auto" ? "browser" : task.preferredSurface;
            this.store.updateTask(taskId, {
              plan: [{ id: "autonomy", label: "Autonomous loop", surface: autonomySurface, action: "autonomy" }],
              status: "running"
            });
            this.traceStore.log({
              traceId: trace.id,
              taskId,
              role: "planner",
              type: "plan.locked",
              message: "Planner delegated the task to the autonomy loop.",
              payload: {
                executionMode: "autonomous",
                maxSteps: taskSpec.autonomy?.maxSteps ?? 8
              }
            });

            const execution = await this.autonomy.execute({
              task: this.store.getTask(taskId),
              workspace,
              traceId: trace.id,
              controlGate
            });

            result = {
              verification: execution.verification,
              outputs: execution.outputs,
              steps: execution.stepResults,
              summary: execution.summary
            };
          } else {
            const plan = await this.planner.plan({ ...task, taskSpec }, trace.id);
            this.store.updateTask(taskId, { plan, status: "running" });
            this.store.updateTrace(trace.id, { plan });

            this.traceStore.log({
              traceId: trace.id,
              taskId,
              role: "planner",
              type: "plan.locked",
              message: "Planner locked the execution plan.",
              payload: { stepCount: plan.length }
            });

            const execution = await this.operator.execute({
              task: this.store.getTask(taskId),
              plan,
              workspace,
              traceId: trace.id,
              controlGate
            });

            await this.waitForExecutionAccess({
              taskId,
              traceId: trace.id,
              phase: "before_verify"
            });

            task = this.store.updateTask(taskId, { status: "verifying" });
            this.eventBus.broadcast("task.updated", this.controlPlane.getTask(taskId));

            const verification = await this.verifier.verify({
              task: this.store.getTask(taskId),
              plan,
              execution,
              workspace,
              traceId: trace.id
            });

            result = {
              verification,
              outputs: execution.outputs,
              steps: execution.stepResults
            };
          }

          result = this.controlPlane.mergePersistedResult(taskId, result) as RuntimeResult;
          result = {
            ...result,
            teachRecording: buildTeachRecording({
              goal: task.goal,
                  taskSpec,
              planSteps: this.store.getTask(taskId)?.plan ?? [],
              executionSteps: result.steps ?? [],
              manualTeachSteps: result.manualTeachSteps ?? [],
              manualCorrections: result.manualCorrections ?? [],
              result
            })
          };

          task = this.store.updateTask(taskId, {
            status: "completed",
            result,
            error: null
          });
          this.traceStore.finish(trace.id, "completed", "Task completed successfully.", result);
          this.eventBus.broadcast("task.updated", this.controlPlane.getTask(taskId));

          if (Object.keys(result.outputs ?? {}).length) {
            this.memoryStore.remember("task-outputs", taskId, result.outputs);
          }

          if (taskSpec.saveSkillAs) {
            this.controlPlane.saveTaskAsSkill(taskId, taskSpec.saveSkillAs);
          }

          if (taskSpec.saveWatchAs) {
            this.controlPlane.saveTaskAsWatchRule(taskId, taskSpec.saveWatchAs);
          }

          const manualTeachSteps = Array.isArray(task.result?.manualTeachSteps) ? task.result.manualTeachSteps : [];
          const manualCorrections = Array.isArray(task.result?.manualCorrections) ? task.result.manualCorrections : [];
          if (task.triggerSource?.startsWith("watch:") && (manualTeachSteps.length || manualCorrections.length)) {
            this.controlPlane.saveTaskAsWatchRule(taskId, {
              watchRuleId: task.triggerSource.slice("watch:".length)
            });
          }

          return;
        } catch (error: unknown) {
          if (error instanceof ExecutionStoppedError) {
            task = this.store.updateTask(taskId, {
              status: "failed",
              error: error.message,
              result: this.controlPlane.mergePersistedResult(taskId, { details: errorDetails(error) })
            });
            this.traceStore.finish(trace.id, task.status, error.message, task.result);
            this.eventBus.broadcast("task.updated", this.controlPlane.getTask(taskId));
            return;
          }

          if (error instanceof ExecutionYieldedError) {
            task = this.store.updateTask(taskId, {
              status: "takeover",
              error: error.message,
              result: this.controlPlane.mergePersistedResult(taskId, {
                details: errorDetails(error)
              })
            });
            this.eventBus.broadcast("task.updated", this.controlPlane.getTask(taskId));
            return;
          }

          const decision = this.recovery.handle({
            taskId,
            traceId: trace.id,
            attempt,
            error
          }) as RecoveryDecision;

          if (decision.decision === "retry" && attempt < 1) {
            this.traceStore.log({
              traceId: trace.id,
              taskId,
              role: "recovery",
              type: "recovery.retrying",
              message: "Recovery requested a single retry.",
              payload: {
                attempt: attempt + 1,
                nextAction: decision.nextAction
              }
            });

            if (decision.nextAction === "wait_and_retry") {
              await new Promise((resolve) => setTimeout(resolve, 300));
            }
            continue;
          }

          if (
            decision.decision === "takeover" ||
            (decision.decision === "retry" && attempt < maxAttempts - 1 && decision.classification !== "low_confidence")
          ) {
            try {
              await this.requestRecoveryTakeover({
                taskId,
                traceId: trace.id,
                error,
                decision
              });
              task = this.store.updateTask(taskId, {
                status: "takeover",
                error: errorMessage(error),
                result: this.controlPlane.mergePersistedResult(taskId, {
                  details: errorDetails(error),
                  recovery: decision
                })
              });
              this.eventBus.broadcast("task.updated", this.controlPlane.getTask(taskId));
              return;
            } catch (controlError: unknown) {
              task = this.store.updateTask(taskId, {
                status: "failed",
                error: errorMessage(controlError),
                result: this.controlPlane.mergePersistedResult(taskId, { details: errorDetails(controlError) })
              });
              this.traceStore.finish(trace.id, task.status, errorMessage(controlError), task.result);
              this.eventBus.broadcast("task.updated", this.controlPlane.getTask(taskId));
              return;
            }
          }

          task = this.store.updateTask(taskId, {
            status: errorName(error) === "PolicyError" || decision.decision === "takeover" ? "blocked" : "failed",
            error: errorMessage(error),
            result: this.controlPlane.mergePersistedResult(taskId, {
              details: errorDetails(error),
              recovery: decision
            })
          });
          this.traceStore.finish(trace.id, task.status, errorMessage(error), task.result);
          this.eventBus.broadcast("task.updated", this.controlPlane.getTask(taskId));
          return;
        }
      }
    } finally {
      this.executionController.unregisterTask(taskId);
    }
  }

  async shutdown() {
    this.acceptingNewTasks = false;
    await this.watchScheduler.stop();
    await this.waitForIdle();
    for (const connector of this.connectors) {
      await connector.stop();
    }
    await this.surfaceRegistry.shutdown();
    this.store.close();
  }
}
