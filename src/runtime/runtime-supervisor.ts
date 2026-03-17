import { buildTeachRecording } from "./teach-recorder.js";
import { ExecutionStoppedError } from "./errors.js";
import type { TaskRecord, TaskSnapshot, TaskSpec } from "../types/runtime-schema.js";

interface RuntimeSupervisorOptions {
  controlPlane: any;
  store: any;
  traceStore: any;
  eventBus: any;
  executionController: any;
  workspaceManager: any;
  policyEngine: any;
  autonomy: any;
  planner: any;
  operator: any;
  verifier: any;
  recovery: any;
  memoryStore: any;
  watchScheduler: any;
  connectors: Array<{ start(): Promise<void>; stop?(): Promise<void> }>;
  surfaceRegistry: { shutdown(): Promise<void> };
}

export class RuntimeSupervisor {
  controlPlane: any;
  store: any;
  traceStore: any;
  eventBus: any;
  executionController: any;
  workspaceManager: any;
  policyEngine: any;
  autonomy: any;
  planner: any;
  operator: any;
  verifier: any;
  recovery: any;
  memoryStore: any;
  watchScheduler: any;
  connectors: Array<{ start(): Promise<void>; stop?(): Promise<void> }>;
  surfaceRegistry: { shutdown(): Promise<void> };
  queue: string[];
  running: boolean;

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
  }

  enqueue(taskId: string): void {
    this.queue.push(taskId);
    void this.drain();
  }

  async restoreRuntimeState() {
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
    error: Error;
    decision: { classification?: string; nextAction?: string };
  }) {
    this.controlPlane.controlTask(taskId, "request_takeover", {
      source: "recovery",
      reason: `Recovery requested takeover: ${error.message}`
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

    await this.waitForExecutionAccess({
      taskId,
      traceId,
      phase: "recovery"
    });
  }

  async drain() {
    if (this.running) {
      return;
    }

    this.running = true;
    while (this.queue.length) {
      const taskId = this.queue.shift();
      try {
        await this.runTask(taskId);
      } catch (error: any) {
        const task = this.store.updateTask(taskId, {
          status: "failed",
          error: error.message
        });
        this.eventBus.broadcast("task.updated", this.controlPlane.decorateTask(task));
      }
    }
    this.running = false;
  }

  async runTask(taskId: string) {
    let task = this.store.getTask(taskId) as TaskRecord | null;
    if (!task) {
      return;
    }

    this.executionController.registerTask(taskId);

    try {
      task = this.store.updateTask(taskId, { status: "planning" });
      const workspace = await this.workspaceManager.prepare(taskId, task.taskSpec);
      task = this.store.updateTask(taskId, { workspaceId: workspace.id });
      const trace = this.traceStore.start(taskId, []);
      task = this.store.updateTask(taskId, { traceId: trace.id });

      this.traceStore.log({
        traceId: trace.id,
        taskId,
        role: "sentinel",
        type: "task.accepted",
        message: "Sentinel accepted the task into the inbox.",
        payload: { workspaceId: workspace.id, preferredSurface: task.preferredSurface }
      });

      const evaluation = this.policyEngine.evaluateTask(task.taskSpec);
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

          let result;
          const controlGate = async ({ phase, step }: { phase: string; step?: { id?: string } | null }) =>
            this.waitForExecutionAccess({
              taskId,
              traceId: trace.id,
              phase,
              step
            });

          const taskSpec = task.taskSpec as TaskSpec;

          if (this.autonomy.isEnabled(taskSpec)) {
            this.store.updateTask(taskId, {
              plan: [{ id: "autonomy", label: "Autonomous loop", surface: task.preferredSurface, action: "autonomy" }],
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
            const plan = await this.planner.plan(task, trace.id);
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

          result = this.controlPlane.mergePersistedResult(taskId, result);
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

          const manualTeachSteps = Array.isArray((task.result as Record<string, unknown> | null)?.manualTeachSteps)
            ? ((task.result as Record<string, unknown>).manualTeachSteps as unknown[])
            : [];
          const manualCorrections = Array.isArray((task.result as Record<string, unknown> | null)?.manualCorrections)
            ? ((task.result as Record<string, unknown>).manualCorrections as unknown[])
            : [];
          if (task.triggerSource?.startsWith("watch:") && (manualTeachSteps.length || manualCorrections.length)) {
            this.controlPlane.saveTaskAsWatchRule(taskId, {
              watchRuleId: task.triggerSource.slice("watch:".length)
            });
          }

          return;
        } catch (error: any) {
          if (error instanceof ExecutionStoppedError) {
            task = this.store.updateTask(taskId, {
              status: "failed",
              error: error.message,
              result: this.controlPlane.mergePersistedResult(taskId, { details: error.details ?? null })
            });
            this.traceStore.finish(trace.id, task.status, error.message, task.result);
            this.eventBus.broadcast("task.updated", this.controlPlane.getTask(taskId));
            return;
          }

          const decision = this.recovery.handle({
            taskId,
            traceId: trace.id,
            attempt,
            error
          });

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
              continue;
            } catch (controlError: any) {
              task = this.store.updateTask(taskId, {
                status: "failed",
                error: controlError.message,
                result: this.controlPlane.mergePersistedResult(taskId, { details: controlError.details ?? null })
              });
              this.traceStore.finish(trace.id, task.status, controlError.message, task.result);
              this.eventBus.broadcast("task.updated", this.controlPlane.getTask(taskId));
              return;
            }
          }

          task = this.store.updateTask(taskId, {
            status: error.name === "PolicyError" || decision.decision === "takeover" ? "blocked" : "failed",
            error: error.message,
            result: this.controlPlane.mergePersistedResult(taskId, { details: error.details ?? null, recovery: decision })
          });
          this.traceStore.finish(trace.id, task.status, error.message, task.result);
          this.eventBus.broadcast("task.updated", this.controlPlane.getTask(taskId));
          return;
        }
      }
    } finally {
      this.executionController.unregisterTask(taskId);
    }
  }

  async shutdown() {
    await this.watchScheduler.stop();
    for (const connector of this.connectors) {
      await connector.stop();
    }
    await this.surfaceRegistry.shutdown();
    this.store.close();
  }
}
