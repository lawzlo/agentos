import { ControlPlaneStore } from "./store.js";
import { EventBus } from "./event-bus.js";
import { ArtifactStore } from "./artifact-store.js";
import { TraceStore } from "./trace-store.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { MemoryStore } from "./memory-store.js";
import { PolicyEngine } from "./policy-engine.js";
import { OpenAICompatibleModelClient } from "./model-client.js";
import { SurfaceRegistry } from "./surface-registry.js";
import { BrowserSurfaceAdapter } from "./adapters/browser-surface.js";
import { DesktopSurfaceAdapter } from "./adapters/desktop-surface.js";
import { SentinelAgent } from "./agents/sentinel.js";
import { PlannerAgent } from "./agents/planner.js";
import { OperatorAgent } from "./agents/operator.js";
import { VerifierAgent } from "./agents/verifier.js";
import { RecoveryAgent } from "./agents/recovery.js";
import { AutonomyAgent } from "./agents/autonomy.js";
import { CredentialVault } from "./credential-vault.js";
import { FileInboxConnector } from "./connectors/file-inbox.js";
import { GroundingEngine } from "./grounding-engine.js";
import { SkillRegistry } from "./skill-registry.js";
import { ExecutionController } from "./execution-controller.js";
import { ExecutionStoppedError } from "./errors.js";
import { LivePackRegistry } from "./live-pack-registry.js";
import { WatchScheduler } from "./watch-scheduler.js";
import { normalizeWatchRule } from "./watch-rule-parser.js";
import { deriveWatchProfileFromExecution, materializeWatchActionTemplate } from "./watch-profile.js";
import { buildTeachRecording } from "./teach-recorder.js";

export class ControlPlane {
  config: any;
  store: any;
  eventBus: any;
  artifactStore: any;
  traceStore: any;
  workspaceManager: any;
  memoryStore: any;
  skillRegistry: any;
  executionController: any;
  credentialVault: any;
  policyEngine: any;
  modelClient: any;
  groundingEngine: any;
  surfaceRegistry: any;
  sentinel: any;
  planner: any;
  operator: any;
  verifier: any;
  recovery: any;
  autonomy: any;
  connectors: any;
  livePackRegistry: any;
  watchScheduler: any;
  queue: any;
  running: any;
  constructor(config) {
    this.config = config;
    this.store = new ControlPlaneStore(config.dbPath);
    this.eventBus = new EventBus();
    this.artifactStore = new ArtifactStore(this.store);
    this.traceStore = new TraceStore(this.store, this.eventBus);
    this.workspaceManager = new WorkspaceManager(this.store, config.dataDir);
    this.memoryStore = new MemoryStore(this.store);
    this.skillRegistry = new SkillRegistry(this.store);
    this.executionController = new ExecutionController();
    this.credentialVault = new CredentialVault({
      store: this.store,
      masterKeyPath: config.masterKeyPath,
      envKey: process.env.AGENTOS_MASTER_KEY
    });
    this.policyEngine = new PolicyEngine();
    this.modelClient = new OpenAICompatibleModelClient(config.model);
    this.groundingEngine = new GroundingEngine({ traceStore: this.traceStore });
    this.surfaceRegistry = new SurfaceRegistry({
      browser: new BrowserSurfaceAdapter({
        artifactStore: this.artifactStore,
        browserExecutable: config.browserExecutable,
        headless: config.headless
      }),
      desktop: new DesktopSurfaceAdapter({
        artifactStore: this.artifactStore,
        dataDir: config.dataDir
      })
    });
    this.sentinel = new SentinelAgent();
    this.planner = new PlannerAgent({
      modelClient: this.modelClient,
      traceStore: this.traceStore,
      skillRegistry: this.skillRegistry
    });
    this.operator = new OperatorAgent({
      surfaceRegistry: this.surfaceRegistry,
      traceStore: this.traceStore,
      policyEngine: this.policyEngine,
      groundingEngine: this.groundingEngine
    });
    this.verifier = new VerifierAgent({
      surfaceRegistry: this.surfaceRegistry,
      traceStore: this.traceStore
    });
    this.recovery = new RecoveryAgent(this.traceStore);
    this.autonomy = new AutonomyAgent({
      modelClient: this.modelClient,
      surfaceRegistry: this.surfaceRegistry,
      traceStore: this.traceStore,
      policyEngine: this.policyEngine,
      groundingEngine: this.groundingEngine
    });
    this.connectors = [
      new FileInboxConnector({
        inboxDir: config.inboxDir,
        controlPlane: this
      })
    ];
    this.livePackRegistry = new LivePackRegistry({
      surfaceRegistry: this.surfaceRegistry,
      extraPacks: config.livePacks ?? {}
    });
    this.watchScheduler = new WatchScheduler({
      controlPlane: this,
      store: this.store,
      eventBus: this.eventBus,
      livePackRegistry: this.livePackRegistry
    });
    this.queue = [];
    this.running = false;
  }

  async start() {
    for (const connector of this.connectors) {
      await connector.start();
    }
    await this.#restoreRuntimeState();
    await this.watchScheduler.start();
  }

  #decorateTask(task) {
    if (!task) {
      return null;
    }

    return {
      ...task,
      trace: task.traceId ? this.traceStore.get(task.traceId) : null,
      artifacts: this.store.listArtifactsForTask(task.id),
      runtimeControl: this.executionController.getState(task.id)
    };
  }

  listTasks(limit = 50) {
    return this.store.listTasks(limit).map((task) => ({
      ...task,
      runtimeControl: this.executionController.getState(task.id)
    }));
  }

  getTask(taskId) {
    return this.#decorateTask(this.store.getTask(taskId));
  }

  getTrace(traceId) {
    return this.traceStore.get(traceId);
  }

  listEvents(limit = 50) {
    return this.store.listEvents(limit);
  }

  listConnectors() {
    return this.connectors.map((connector) => connector.status());
  }

  listLivePacks() {
    return this.livePackRegistry.list();
  }

  listSkills() {
    return this.skillRegistry.listSkills();
  }

  getSkill(name) {
    return this.skillRegistry.getSkill(name);
  }

  putSkill(skill) {
    return this.skillRegistry.putSkill(skill);
  }

  saveTaskAsSkill(taskId, name) {
    const task = this.store.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.status !== "completed") {
      throw new Error("Only completed tasks can be saved as skills.");
    }

    const skill = this.skillRegistry.saveExecutionAsSkill({
      name,
      surfaceScope: task.preferredSurface,
      goal: task.goal,
      result: task.result,
      taskId,
      taskSpec: task.taskSpec,
      planSteps: task.plan ?? [],
      executionSteps: task.result?.steps ?? [],
      manualCorrections: task.result?.manualCorrections ?? [],
      manualTeachSteps: task.result?.manualTeachSteps ?? [],
      teachRecording: task.result?.teachRecording ?? null
    });

    this.eventBus.broadcast("skill.saved", skill);
    return skill;
  }

  saveTaskAsWatchRule(
    taskId,
    {
      watchRuleId = null,
      goal = null,
      preferredSurface = null,
      workspaceName = null,
      livePack = null,
      appTarget = null,
      skillName = null,
      pollIntervalMs = null,
      enabled = null,
      triggerTexts = []
    } = {}
  ) {
    const task = this.store.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.status !== "completed") {
      throw new Error("Only completed tasks can be saved as watch profiles.");
    }

    const existingWatchRule =
      (watchRuleId ? this.store.getWatchRule(watchRuleId) : null) ??
      (task.triggerSource?.startsWith("watch:") ? this.store.getWatchRule(task.triggerSource.slice("watch:".length)) : null);

    const watchProfile = deriveWatchProfileFromExecution({
      goal: task.goal,
      taskId,
      taskSpec: task.taskSpec,
      planSteps: task.plan ?? [],
      executionSteps: task.result?.steps ?? [],
      manualTeachSteps: task.result?.manualTeachSteps ?? [],
      manualCorrections: task.result?.manualCorrections ?? [],
      result: task.result,
      teachRecording: task.result?.teachRecording ?? null,
      overrides: {
        triggerTexts: triggerTexts.length ? triggerTexts : existingWatchRule?.watchProfile?.triggerTexts ?? [],
        recoveryHints: existingWatchRule?.watchProfile?.recoveryHints ?? []
      }
    });

    const normalized = normalizeWatchRule(
      {
        ...(existingWatchRule ?? {}),
        id: existingWatchRule?.id ?? watchRuleId ?? undefined,
        goal: goal ?? existingWatchRule?.goal ?? task.goal,
        preferredSurface: preferredSurface ?? existingWatchRule?.preferredSurface ?? task.preferredSurface,
        workspaceName: workspaceName ?? existingWatchRule?.workspaceName ?? task.taskSpec.workspaceName ?? null,
        livePack: livePack ?? existingWatchRule?.livePack ?? null,
        appTarget: appTarget ?? existingWatchRule?.appTarget ?? task.taskSpec.inputs?.desktopApp ?? null,
        skillName: skillName ?? existingWatchRule?.skillName ?? null,
        pollIntervalMs: pollIntervalMs ?? existingWatchRule?.pollIntervalMs ?? 15000,
        enabled: enabled ?? existingWatchRule?.enabled ?? true,
        watchProfile: {
          ...(existingWatchRule?.watchProfile ?? {}),
          ...watchProfile
        },
        taskInputs: {
          ...(existingWatchRule?.taskInputs ?? {}),
          ...(task.taskSpec.inputs ?? {}),
          watchTemplateLearnedFromTaskId: taskId
        },
        lastError: null,
        status: (enabled ?? existingWatchRule?.enabled ?? true) ? "watching" : "disabled"
      },
      {
        modelConfigured: this.modelClient.isConfigured()
      }
    );
    const watchRule = this.store.putWatchRule(normalized);
    this.watchScheduler.sync(watchRule);
    this.eventBus.broadcast(existingWatchRule ? "watch.learned" : "watch.created", watchRule);
    return watchRule;
  }

  listWorkspaceProfiles() {
    return this.workspaceManager.listProfiles();
  }

  prepareWorkspaceProfile(name, metadata = {}) {
    return this.workspaceManager.prepareProfile(name, metadata);
  }

  listWatchRules() {
    return this.store.listWatchRules();
  }

  getWatchRule(watchRuleId) {
    return this.store.getWatchRule(watchRuleId);
  }

  createWatchRule(spec) {
    const normalized = normalizeWatchRule(spec, {
      modelConfigured: this.modelClient.isConfigured()
    });
    const watchRule = this.store.putWatchRule(normalized);
    this.watchScheduler.sync(watchRule);
    this.eventBus.broadcast("watch.created", watchRule);
    return watchRule;
  }

  updateWatchRule(watchRuleId, patch) {
    const existing = this.store.getWatchRule(watchRuleId);
    if (!existing) {
      throw new Error(`Watch rule not found: ${watchRuleId}`);
    }

    const normalized = normalizeWatchRule(
      {
        ...existing,
        ...patch,
        id: watchRuleId,
        taskInputs: patch.taskInputs ?? patch.inputs ?? existing.taskInputs
      },
      {
        modelConfigured: this.modelClient.isConfigured()
      }
    );
    const watchRule = this.store.putWatchRule(normalized);
    this.watchScheduler.sync(watchRule);
    this.eventBus.broadcast("watch.updated", watchRule);
    return watchRule;
  }

  enableWatchRule(watchRuleId) {
    return this.updateWatchRule(watchRuleId, {
      enabled: true,
      status: "watching",
      lastError: null
    });
  }

  disableWatchRule(watchRuleId) {
    const watchRule = this.updateWatchRule(watchRuleId, {
      enabled: false,
      status: "disabled"
    });
    this.watchScheduler.remove(watchRuleId);
    return watchRule;
  }

  deleteWatchRule(watchRuleId) {
    const deleted = this.store.deleteWatchRule(watchRuleId);
    if (!deleted) {
      throw new Error(`Watch rule not found: ${watchRuleId}`);
    }
    this.watchScheduler.remove(watchRuleId);
    this.eventBus.broadcast("watch.deleted", { id: watchRuleId });
    return true;
  }

  evaluatePolicy(taskSpec) {
    return this.policyEngine.evaluateTask(taskSpec);
  }

  listVaultSecrets(scope = "default") {
    return this.credentialVault.listSecrets(scope);
  }

  async putVaultSecret({ scope = "default", secretKey, value, metadata = {} }) {
    return this.credentialVault.putSecret(scope, secretKey, value, metadata);
  }

  async getVaultSecret(scope, secretKey) {
    return this.credentialVault.getSecret(scope, secretKey);
  }

  #mergePersistedResult(taskId, nextResult = {}) {
    const current = this.store.getTask(taskId);
    const manualCorrections = current?.result?.manualCorrections ?? [];
    const manualTeachSteps = current?.result?.manualTeachSteps ?? [];

    if (!manualCorrections.length && !manualTeachSteps.length) {
      return nextResult;
    }

    return {
      ...nextResult,
      ...(manualCorrections.length ? { manualCorrections } : {}),
      ...(manualTeachSteps.length ? { manualTeachSteps } : {})
    };
  }

  recordTaskCorrection(taskId, note, { source = "user", mode = null } = {}) {
    const trimmed = String(note ?? "").trim();
    if (!trimmed) {
      return this.getTask(taskId);
    }

    const task = this.store.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const correction = {
      note: trimmed,
      source,
      mode: mode ?? this.executionController.getState(taskId)?.mode ?? task.status,
      createdAt: new Date().toISOString()
    };

    const updated = this.store.updateTask(taskId, {
      result: {
        ...(task.result ?? {}),
        manualCorrections: [...(task.result?.manualCorrections ?? []), correction]
      }
    });

    if (task.traceId) {
      this.traceStore.log({
        traceId: task.traceId,
        taskId,
        role: source === "recovery" ? "recovery" : "operator",
        type: "takeover.note_recorded",
        message: `Recorded a manual correction note: ${trimmed}`,
        payload: correction
      });
    }

    const snapshot = this.#decorateTask(updated);
    this.eventBus.broadcast("task.updated", snapshot);
    return snapshot;
  }

  recordTaskTeachStep(taskId, step, { source = "user" } = {}) {
    const task = this.store.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (!step?.action) {
      throw new Error("teach step action is required");
    }

    const normalizedStep = {
      label: step.label ?? `Teach ${step.action}`,
      surface: step.surface ?? task.preferredSurface ?? "desktop",
      action: step.action,
      params: step.params ?? {},
      expect: step.expect ?? null,
      checkpoint: step.checkpoint ?? true
    };

    const updated = this.store.updateTask(taskId, {
      result: {
        ...(task.result ?? {}),
        manualTeachSteps: [...(task.result?.manualTeachSteps ?? []), normalizedStep]
      }
    });

    if (task.traceId) {
      this.traceStore.log({
        traceId: task.traceId,
        taskId,
        role: source === "recovery" ? "recovery" : "operator",
        type: "takeover.step_recorded",
        message: `Recorded a teach step: ${normalizedStep.label}`,
        payload: normalizedStep
      });
    }

    const snapshot = this.#decorateTask(updated);
    this.eventBus.broadcast("task.updated", snapshot);
    return snapshot;
  }

  controlTask(taskId, action, { source = "user", reason = null, note = null } = {}) {
    const task = this.store.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (["completed", "failed"].includes(task.status) && action !== "stop") {
      throw new Error("Only active tasks can be controlled.");
    }

    const transitions = {
      pause: {
        mode: "paused",
        status: "paused",
        type: "control.paused",
        message: "Execution paused. The agent will wait for resume."
      },
      resume: {
        mode: "agent",
        status: "running",
        type: "control.resumed",
        message: "Execution resumed under agent control."
      },
      request_takeover: {
        mode: "takeover",
        status: "takeover",
        type: "control.takeover_requested",
        message: "Manual takeover requested."
      },
      return_to_agent: {
        mode: "agent",
        status: "running",
        type: "control.returned",
        message: "Control returned to the agent."
      },
      stop: {
        mode: "stopped",
        status: "failed",
        type: "control.stopped",
        message: "Execution stopped."
      }
    };

    const transition =
      transitions[action] ??
      transitions[
        {
          takeover: "request_takeover",
          return: "return_to_agent"
        }[action]
      ];

    if (!transition) {
      throw new Error(`Unsupported control action: ${action}`);
    }

    if (note) {
      this.recordTaskCorrection(taskId, note, {
        source,
        mode: transition.mode
      });
    }

    const finalReason = reason ?? transition.message;
    this.executionController.setMode(taskId, transition.mode, {
      reason: finalReason,
      source
    });

    const updated = this.store.updateTask(taskId, {
      status: transition.status,
      error: action === "stop" ? finalReason : task.error
    });

    if (task.traceId) {
      this.traceStore.log({
        traceId: task.traceId,
        taskId,
        role: source === "recovery" ? "recovery" : "operator",
        type: transition.type,
        message: finalReason,
        payload: {
          action,
          source,
          mode: transition.mode
        }
      });
    }

    const snapshot = this.#decorateTask(updated);
    this.eventBus.broadcast("task.updated", snapshot);
    return snapshot;
  }

  async createTask(taskSpec) {
    const normalized = this.sentinel.normalize(taskSpec);
    const task = this.store.createTask(normalized);
    this.eventBus.broadcast("task.created", task);
    this.#enqueue(task.id);
    return task;
  }

  async previewTask(taskSpec) {
    const normalized = this.sentinel.normalize(taskSpec);
    const preview = await this.planner.preview(normalized);
    const evaluation = this.policyEngine.evaluateTask(normalized);

    return {
      taskSpec: normalized,
      plan: preview.steps,
      humanPlan: preview.humanPlan,
      summary: preview.summary,
      source: preview.source,
      evaluation
    };
  }

  async ingestEvent(event) {
    const stored = this.store.createEvent(event);
    this.eventBus.broadcast("event.created", stored);

    if (event.payload?.taskSpec) {
      const taskSpec = {
        ...this.sentinel.fromEvent(event),
        ...event.payload.taskSpec
      };
      const task = await this.createTask(taskSpec);
      const linked = this.store.attachEventTask(stored.id, task.id);
      return {
        event: {
          id: linked.id,
          type: linked.type,
          source: linked.source,
          taskId: linked.task_id,
          payload: JSON.parse(linked.payload),
          createdAt: linked.created_at
        },
        task
      };
    }

    return { event: stored, task: null };
  }

  async createTaskFromWatchRule(watchRule, detection = {}) {
    const detected = detection as Record<string, any>;
    const runtimeInputs = {
      ...(watchRule.taskInputs ?? {}),
      ...(detected.inputs ?? {}),
      watchRuleId: watchRule.id,
      watchSummary: detected.summary ?? null
    };
    const actionTemplate =
      !watchRule.skillName && watchRule.watchProfile?.actionTemplate?.length
        ? materializeWatchActionTemplate(
            watchRule.watchProfile.actionTemplate,
            runtimeInputs,
            watchRule.watchProfile?.metadata?.templateInputs ?? []
          )
        : null;

    const taskSpec =
      detected.taskSpec ??
      {
        goal: detected.goal ?? `${watchRule.goal}${detected.summary ? `\n\nTrigger context: ${detected.summary}` : ""}`,
        preferredSurface: watchRule.preferredSurface,
        workspaceName: watchRule.workspaceName ?? `${watchRule.livePack}-live`,
        skillName: watchRule.skillName ?? null,
        triggerSource: `watch:${watchRule.id}`,
        inputs: runtimeInputs,
        ...(actionTemplate?.length ? { steps: actionTemplate } : {}),
        executionMode:
          actionTemplate?.length
            ? "planned"
            : watchRule.watchProfile?.executionMode ??
              (watchRule.skillName ? "planned" : this.modelClient.isConfigured() ? "autonomous" : "planned")
      };

    return this.createTask(taskSpec);
  }

  #enqueue(taskId) {
    this.queue.push(taskId);
    void this.#drain();
  }

  async #restoreRuntimeState() {
    const queued = this.store.listTasksByStatuses(["queued"]);
    for (const task of queued) {
      this.#enqueue(task.id);
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
          this.#mergePersistedResult(task.id, { details: { reason: "daemon_restart" } })
        );
      }
      this.eventBus.broadcast("task.updated", this.getTask(task.id));
    }
  }

  async #waitForExecutionAccess({ taskId, traceId, phase, step = null }) {
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
      this.eventBus.broadcast("task.updated", this.getTask(taskId));
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
      this.eventBus.broadcast("task.updated", this.getTask(taskId));
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

  async #requestRecoveryTakeover({ taskId, traceId, error, decision }) {
    this.controlTask(taskId, "request_takeover", {
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

    await this.#waitForExecutionAccess({
      taskId,
      traceId,
      phase: "recovery"
    });
  }

  async #drain() {
    if (this.running) {
      return;
    }

    this.running = true;
    while (this.queue.length) {
      const taskId = this.queue.shift();
      try {
        await this.#runTask(taskId);
      } catch (error) {
        const task = this.store.updateTask(taskId, {
          status: "failed",
          error: error.message
        });
        this.eventBus.broadcast("task.updated", this.#decorateTask(task));
      }
    }
    this.running = false;
  }

  async #runTask(taskId) {
    let task = this.store.getTask(taskId);
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
          await this.#waitForExecutionAccess({
            taskId,
            traceId: trace.id,
            phase: "before_attempt"
          });

          task = this.store.updateTask(taskId, { status: "planning", error: null });
          this.eventBus.broadcast("task.updated", this.getTask(taskId));

          let result;
          const controlGate = async ({ phase, step }) =>
            this.#waitForExecutionAccess({
              taskId,
              traceId: trace.id,
              phase,
              step
            });

          if (this.autonomy.isEnabled(task.taskSpec)) {
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
                maxSteps: task.taskSpec.autonomy?.maxSteps ?? 8
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

            await this.#waitForExecutionAccess({
              taskId,
              traceId: trace.id,
              phase: "before_verify"
            });

            task = this.store.updateTask(taskId, { status: "verifying" });
            this.eventBus.broadcast("task.updated", this.getTask(taskId));

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

          result = this.#mergePersistedResult(taskId, result);
          result = {
            ...result,
            teachRecording: buildTeachRecording({
              goal: task.goal,
              taskSpec: task.taskSpec,
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
          this.eventBus.broadcast("task.updated", this.getTask(taskId));

          if (Object.keys(result.outputs ?? {}).length) {
            this.memoryStore.remember("task-outputs", taskId, result.outputs);
          }

          if (task.taskSpec.saveSkillAs) {
            this.saveTaskAsSkill(taskId, task.taskSpec.saveSkillAs);
          }

          if (task.taskSpec.saveWatchAs) {
            this.saveTaskAsWatchRule(taskId, task.taskSpec.saveWatchAs);
          }

          if (task.triggerSource?.startsWith("watch:") && (task.result?.manualTeachSteps?.length || task.result?.manualCorrections?.length)) {
            this.saveTaskAsWatchRule(taskId, {
              watchRuleId: task.triggerSource.slice("watch:".length)
            });
          }

          return;
        } catch (error) {
          if (error instanceof ExecutionStoppedError) {
            task = this.store.updateTask(taskId, {
              status: "failed",
              error: error.message,
              result: this.#mergePersistedResult(taskId, { details: error.details ?? null })
            });
            this.traceStore.finish(trace.id, task.status, error.message, task.result);
            this.eventBus.broadcast("task.updated", this.getTask(taskId));
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

          if ((decision.decision === "takeover" || (decision.decision === "retry" && attempt < maxAttempts - 1 && decision.classification !== "low_confidence"))) {
            try {
              await this.#requestRecoveryTakeover({
                taskId,
                traceId: trace.id,
                error,
                decision
              });
              continue;
            } catch (controlError) {
              task = this.store.updateTask(taskId, {
                status: "failed",
                error: controlError.message,
                result: this.#mergePersistedResult(taskId, { details: controlError.details ?? null })
              });
              this.traceStore.finish(trace.id, task.status, controlError.message, task.result);
              this.eventBus.broadcast("task.updated", this.getTask(taskId));
              return;
            }
          }

          task = this.store.updateTask(taskId, {
            status: error.name === "PolicyError" || decision.decision === "takeover" ? "blocked" : "failed",
            error: error.message,
            result: this.#mergePersistedResult(taskId, { details: error.details ?? null, recovery: decision })
          });
          this.traceStore.finish(trace.id, task.status, error.message, task.result);
          this.eventBus.broadcast("task.updated", this.getTask(taskId));
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

export function createControlPlane(config) {
  return new ControlPlane(config);
}
