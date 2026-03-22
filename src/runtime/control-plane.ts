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
import { LivePackRegistry } from "./live-pack-registry.js";
import { WatchScheduler } from "./watch-scheduler.js";
import { AutomationJobService } from "./automation-job-service.js";
import { WatchService } from "./watch-service.js";
import { DraftService } from "./draft-service.js";
import { WatchExecutionService } from "./watch-execution-service.js";
import { RuntimeSupervisor } from "./runtime-supervisor.js";
import { LearningService } from "./learning-service.js";
import { withLivePackHealth } from "./live-pack-health.js";
import { getDaemonInstallStatus } from "../daemon-autostart.js";
import { createDiagnosticBundle } from "../diagnostics.js";
import { getRuntimeVersionInfo } from "../version.js";
import type { AgentOsConfig } from "../config.js";
import type {
  ConnectorStatus,
  DraftRecord,
  EventRecord,
  LivePackInfo,
  RiskGateDecision,
  RuntimeStep,
  SkillDefinition,
  TaskRecord,
  TaskSnapshot,
  TaskSpec,
  TeachRecording,
  TraceSnapshot,
  WatchDetection,
  WatchHealth,
  WatchRule
} from "../types/runtime-schema.js";
import type {
  DigestRecord,
  KnowledgeChunk,
  LearningSource,
  LearningStatus,
  MemoryEntitySnapshot,
  ProposalRecord
} from "../types/learning.js";
import type { AutomationJobRecord } from "../types/jobs.js";
import type {
  DaemonStartupRecovery,
  DaemonStatus,
  DoctorBundle,
  DoctorReport,
  NativeDiagnostics
} from "../types/system.js";
import type { RuntimeVersionInfo } from "../version.js";
import type { SidecarHealthResult, SidecarPermissionsResult } from "../types/native-sidecar.js";

type ControlPlaneConnector = FileInboxConnector;

interface WatchDraftInput {
  watchRule?: WatchRule | null;
  taskSpec: TaskSpec;
  detection?: Record<string, unknown>;
  riskDecision: RiskGateDecision;
  replyText?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown>;
}

interface IncomingEvent {
  id?: string;
  type?: string;
  source?: string;
  taskId?: string | null;
  payload?: Record<string, unknown> & {
    taskSpec?: TaskSpec;
  };
}

export class ControlPlane {
  config: AgentOsConfig;
  store: ControlPlaneStore;
  eventBus: EventBus;
  artifactStore: ArtifactStore;
  traceStore: TraceStore;
  workspaceManager: WorkspaceManager;
  memoryStore: MemoryStore;
  skillRegistry: SkillRegistry;
  executionController: ExecutionController;
  credentialVault: CredentialVault;
  policyEngine: PolicyEngine;
  modelClient: OpenAICompatibleModelClient;
  groundingEngine: GroundingEngine;
  surfaceRegistry: SurfaceRegistry;
  sentinel: SentinelAgent;
  planner: PlannerAgent;
  operator: OperatorAgent;
  verifier: VerifierAgent;
  recovery: RecoveryAgent;
  autonomy: AutonomyAgent;
  connectors: ControlPlaneConnector[];
  livePackRegistry: LivePackRegistry;
  watchScheduler: WatchScheduler;
  watchService: WatchService;
  draftService: DraftService;
  watchExecutionService: WatchExecutionService;
  runtimeSupervisor: RuntimeSupervisor;
  learningService: LearningService;
  automationJobService: AutomationJobService;
  startupRecovery: DaemonStartupRecovery | null;

  constructor(config: AgentOsConfig) {
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
        dataDir: config.dataDir,
        visualModelClient: this.modelClient
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
      extraPacks: (config.livePacks ?? {}) as Record<string, import("./live-pack-registry.js").LivePack>
    });
    this.watchExecutionService = new WatchExecutionService({
      controlPlane: this,
      store: this.store,
      eventBus: this.eventBus,
      livePackRegistry: this.livePackRegistry
    });
    this.watchScheduler = new WatchScheduler({
      store: this.store,
      executionService: this.watchExecutionService
    });
    this.watchService = new WatchService({
      store: this.store,
      modelClient: this.modelClient,
      watchScheduler: this.watchScheduler,
      eventBus: this.eventBus,
      livePackRegistry: this.livePackRegistry,
      connectors: this.connectors,
      config
    });
    this.draftService = new DraftService({
      store: this.store,
      eventBus: this.eventBus,
      createTask: (taskSpec: TaskSpec) => this.createTask(taskSpec),
      getTask: (taskId: string) => this.getTask(taskId),
      getWatchRule: (watchRuleId: string) => this.watchService.get(watchRuleId),
      decorateWatchRule: (watchRule: WatchRule | null) => this.watchService.decorate(watchRule)
    });
    this.runtimeSupervisor = new RuntimeSupervisor({
      controlPlane: this,
      store: this.store,
      traceStore: this.traceStore,
      eventBus: this.eventBus,
      executionController: this.executionController,
      workspaceManager: this.workspaceManager,
      policyEngine: this.policyEngine,
      autonomy: this.autonomy,
      planner: this.planner,
      operator: this.operator,
      verifier: this.verifier,
      recovery: this.recovery,
      memoryStore: this.memoryStore,
      watchScheduler: this.watchScheduler,
      connectors: this.connectors,
      surfaceRegistry: this.surfaceRegistry
    });
    this.learningService = new LearningService({
      store: this.store,
      eventBus: this.eventBus,
      config,
      createTask: async (taskSpec: TaskSpec) => this.createTask(taskSpec)
    });
    this.automationJobService = new AutomationJobService({
      store: this.store,
      eventBus: this.eventBus,
      config,
      createTask: async (taskSpec: TaskSpec) => this.createTask(taskSpec),
      runDigest: async () => this.runDigest()
    });
    this.startupRecovery = null;
  }

  async start(): Promise<DaemonStartupRecovery> {
    await this.learningService.start();
    for (const connector of this.connectors) {
      await connector.start();
    }
    const taskRecovery = await this.runtimeSupervisor.restoreRuntimeState();
    const watchRecovery = await this.watchScheduler.start();
    const jobRecovery = await this.automationJobService.start();
    this.startupRecovery = {
      recoveredAt: new Date().toISOString(),
      requeuedTaskCount: taskRecovery.requeuedTaskCount,
      interruptedTaskCount: taskRecovery.interruptedTaskCount,
      resumedWatchCount: watchRecovery.resumedWatchCount,
      reconciledRunningJobCount: jobRecovery.reconciledRunningJobCount,
      dueJobCountAtStartup: jobRecovery.dueJobCountAtStartup
    };
    return this.startupRecovery;
  }

  decorateTask(task: TaskRecord | null): TaskSnapshot | null {
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
    return (this.store.listTasks(limit) as TaskRecord[]).map((task) => ({
      ...task,
      runtimeControl: this.executionController.getState(task.id)
    }));
  }

  getTask(taskId: string): TaskSnapshot | null {
    return this.decorateTask(this.store.getTask(taskId) as TaskRecord | null);
  }

  getTrace(traceId: string): TraceSnapshot | null {
    return this.traceStore.get(traceId);
  }

  listEvents(limit = 50) {
    return this.store.listEvents(limit);
  }

  listConnectors(): ConnectorStatus[] {
    return this.connectors.map((connector) => connector.status());
  }

  listLivePacks() {
    return this.livePackRegistry.list();
  }

  async listLivePackInfo(): Promise<LivePackInfo[]> {
    const native = await this.#collectNativeDiagnostics();
    return this.livePackRegistry.listInfo().map((pack) =>
      withLivePackHealth(pack, {
        config: this.config,
        native
      })
    );
  }

  listSkills(): SkillDefinition[] {
    return this.skillRegistry.listSkills();
  }

  getSkill(name: string): SkillDefinition | null {
    return this.skillRegistry.getSkill(name);
  }

  putSkill(skill: SkillDefinition): SkillDefinition {
    return this.skillRegistry.putSkill(skill);
  }

  saveTaskAsSkill(taskId: string, name: string): SkillDefinition {
    const task = this.store.getTask(taskId) as TaskRecord | null;
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
      executionSteps: Array.isArray(task.result?.steps) ? task.result.steps : [],
      manualCorrections: Array.isArray(task.result?.manualCorrections) ? task.result.manualCorrections : [],
      manualTeachSteps: Array.isArray(task.result?.manualTeachSteps) ? task.result.manualTeachSteps : [],
      teachRecording: (task.result?.teachRecording ?? null) as TeachRecording | null
    });

    this.eventBus.broadcast("skill.saved", skill);
    return skill;
  }

  saveTaskAsWatchRule(taskId: string, options: Record<string, unknown> = {}) {
    return this.watchService.saveTaskAsWatchRule(taskId, options);
  }

  listWorkspaceProfiles() {
    return this.workspaceManager.listProfiles();
  }

  prepareWorkspaceProfile(name: string, metadata: Record<string, unknown> = {}) {
    return this.workspaceManager.prepareProfile(name, metadata);
  }

  listWatchRules() {
    return this.watchService.list();
  }

  getWatchRule(watchRuleId) {
    return this.watchService.get(watchRuleId);
  }

  createWatchRule(spec) {
    return this.watchService.create(spec);
  }

  updateWatchRule(watchRuleId, patch) {
    return this.watchService.update(watchRuleId, patch);
  }

  enableWatchRule(watchRuleId) {
    return this.watchService.enable(watchRuleId);
  }

  disableWatchRule(watchRuleId) {
    return this.watchService.disable(watchRuleId);
  }

  async deleteWatchRule(watchRuleId) {
    return this.watchService.delete(watchRuleId);
  }

  getWatchHealth(watchRuleId: string): WatchHealth {
    return this.watchService.getHealth(watchRuleId);
  }

  retryWatchRule(watchRuleId) {
    return this.watchService.retry(watchRuleId);
  }

  listDrafts(limit = 50) {
    return this.draftService.list(limit);
  }

  getDraft(draftId: string) {
    return this.draftService.get(draftId);
  }

  createDraft({
    watchRule = null,
    taskSpec,
    detection = {},
    riskDecision,
    replyText = null,
    summary = null,
    metadata = {}
  }: WatchDraftInput) {
    return this.draftService.create({
      watchRule,
      taskSpec,
      detection,
      riskDecision,
      replyText,
      summary,
      metadata
    });
  }

  async approveDraft(draftId) {
    return this.draftService.approve(draftId);
  }

  rejectDraft(draftId, reason = null) {
    return this.draftService.reject(draftId, reason);
  }

  listReplyStylePreferences({
    livePack,
    preferredSurface = null,
    limit = 6
  }: {
    livePack: string;
    preferredSurface?: string | null;
    limit?: number;
  }): string[] {
    const keys = new Set(
      [livePack ? `reply-style:${livePack}` : null, preferredSurface ? `surface:${preferredSurface}` : null]
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean)
    );
    if (!keys.size) {
      return [];
    }

    const notes: string[] = [];
    const seen = new Set<string>();
    for (const entity of this.store.listMemoryEntities(200)) {
      if (entity.type !== "preference" || !keys.has(entity.key)) {
        continue;
      }

      const snapshot = this.store.getMemoryEntitySnapshot(entity.id);
      for (const fact of [...(snapshot?.facts ?? [])].reverse()) {
        if (fact.kind !== "manual-correction") {
          continue;
        }

        const candidates = Array.isArray((fact.value as { notes?: unknown[] } | null)?.notes)
          ? ((fact.value as { notes?: unknown[] }).notes ?? [])
          : [];
        for (const entry of candidates) {
          const note = String((entry as { note?: unknown } | null)?.note ?? "").trim();
          if (!note) {
            continue;
          }
          const dedupeKey = note.toLowerCase();
          if (seen.has(dedupeKey)) {
            continue;
          }
          seen.add(dedupeKey);
          notes.push(note);
          if (notes.length >= limit) {
            return notes;
          }
        }
      }
    }

    return notes;
  }

  getVersionInfo(): RuntimeVersionInfo {
    return getRuntimeVersionInfo();
  }

  async #collectNativeDiagnostics(): Promise<NativeDiagnostics> {
    const desktopSurface = this.surfaceRegistry.get("desktop");
    const bridge = (desktopSurface as { bridge?: Record<string, unknown> } | undefined)?.bridge as
      | {
          sidecarHealth?: () => Promise<SidecarHealthResult>;
          getPermissionsStatus?: () => Promise<SidecarPermissionsResult | null>;
        }
      | undefined;
    if (!bridge || typeof bridge.sidecarHealth !== "function") {
      return {
        available: false,
        compatible: false,
        reason: `Desktop automation is not available on ${process.platform}.`
      };
    }

    try {
      const health = (await bridge.sidecarHealth()) as SidecarHealthResult;
      const permissions =
        typeof bridge.getPermissionsStatus === "function"
          ? ((await bridge.getPermissionsStatus().catch(() => null)) as SidecarPermissionsResult | null)
          : null;
      const compatible =
        Number(health.nativeProtocolVersion ?? -1) ===
        this.getVersionInfo().nativeProtocolVersion;
      return {
        available: true,
        compatible,
        health,
        permissions
      };
    } catch (error) {
      return {
        available: false,
        compatible: false,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async doctor(): Promise<DoctorReport> {
    const base = this.watchService.doctor();
    const model = this.modelClient.describe();
    const version = this.getVersionInfo();
    const schemaVersion = this.store.getSchemaVersion();
    const native = await this.#collectNativeDiagnostics();
    const livePacks = this.livePackRegistry.listInfo().map((pack) =>
      withLivePackHealth(pack, {
        config: this.config,
        native
      })
    );
    const learning = this.learningService.status();
    const jobs = this.automationJobService.status();
    const install = await getDaemonInstallStatus();
    const watches = this.listWatchRules();
    const automationJobs = this.listAutomationJobs(200);
    const blockedLivePacks = livePacks.filter((pack) => pack.ready === false);
    const readyLivePackCount = livePacks.length - blockedLivePacks.length;
    const pendingProposalCount = learning.pendingProposalCount;
    const awaitingApprovalWatchCount = watches.filter((rule) => rule.status === "awaiting_approval").length;
    const backoffWatchCount = watches.filter((rule) => rule.status === "backoff").length;
    const recentErrors = [
      ...watches
        .filter((rule) => typeof rule.lastError === "string" && rule.lastError.trim())
        .map((rule) => ({
          id: rule.id,
          status: rule.status,
          message: String(rule.lastError ?? ""),
          updatedAt: rule.updatedAt
        })),
      ...automationJobs
        .filter((job) => typeof job.lastError === "string" && job.lastError.trim())
        .map((job) => ({
          id: job.id,
          status: job.status,
          message: String(job.lastError ?? ""),
          updatedAt: job.updatedAt
        }))
    ]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, 5);
    const warnings = [...base.warnings];

    if (schemaVersion !== version.storeSchemaVersion) {
      warnings.push(
        `Store schema version ${schemaVersion} does not match runtime expectation ${version.storeSchemaVersion}.`
      );
    }
    if (!native.available && process.platform !== "linux") {
      warnings.push(native.reason ?? "Native sidecar is not available.");
    }
    if (native.available && !native.compatible) {
      warnings.push(
        `Native sidecar protocol ${native.health?.nativeProtocolVersion ?? "unknown"} does not match runtime expectation ${version.nativeProtocolVersion}.`
      );
    }
    if (native.permissions && Object.values(native.permissions).some((value) => value === false)) {
      warnings.push("Desktop automation permissions are incomplete.");
    }
    if (install.supported && !install.installed) {
      warnings.push("Daemon auto-start is not installed.");
    }
    if (install.installed && install.loaded === false) {
      warnings.push("Daemon auto-start is installed but not loaded.");
    }
    if (blockedLivePacks.length) {
      warnings.push(
        `${blockedLivePacks.length} live pack(s) are blocked: ${blockedLivePacks.map((pack) => pack.name).join(", ")}.`
      );
    }
    if (jobs.degradedJobCount > 0) {
      warnings.push(`${jobs.degradedJobCount} automation job(s) are degraded.`);
    }

    return {
      ...base,
      ok:
        warnings.length === 0 &&
        schemaVersion === version.storeSchemaVersion &&
        (process.platform === "linux" || native.available) &&
        (!native.available || native.compatible),
      warnings,
      modelConfigured: model.configured,
      modelProvider: model.provider,
      modelProviderLabel: model.providerLabel,
      modelName: model.modelName,
      modelBaseUrl: model.baseUrl,
      modelTier: model.tier,
      learning,
      version,
      install,
      livePackCount: livePacks.length,
      readyLivePackCount,
      blockedLivePackCount: blockedLivePacks.length,
      pendingProposalCount,
      jobCount: jobs.jobCount,
      enabledJobCount: jobs.enabledJobCount,
      degradedJobCount: jobs.degradedJobCount,
      nextJobRunAt: jobs.nextRunAt,
      awaitingApprovalWatchCount,
      backoffWatchCount,
      recentErrors,
      store: {
        schemaVersion,
        compatible: schemaVersion === version.storeSchemaVersion
      },
      native
    };
  }

  async createDoctorBundle(daemon: DaemonStatus): Promise<DoctorBundle> {
    return createDiagnosticBundle({
      controlPlane: this,
      config: this.config,
      daemon
    }) as Promise<DoctorBundle>;
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

  mergePersistedResult(taskId: string, nextResult: Record<string, unknown> = {}) {
    const current = this.store.getTask(taskId);
    const manualCorrections = Array.isArray(current?.result?.manualCorrections) ? current.result.manualCorrections : [];
    const manualTeachSteps = Array.isArray(current?.result?.manualTeachSteps) ? current.result.manualTeachSteps : [];

    if (!manualCorrections.length && !manualTeachSteps.length) {
      return nextResult;
    }

    return {
      ...nextResult,
      ...(manualCorrections.length ? { manualCorrections } : {}),
      ...(manualTeachSteps.length ? { manualTeachSteps } : {})
    };
  }

  recordTaskCorrection(
    taskId: string,
    note: string,
    { source = "user", mode = null }: { source?: string; mode?: string | null } = {}
  ): TaskSnapshot | null {
    const trimmed = String(note ?? "").trim();
    if (!trimmed) {
      return this.getTask(taskId);
    }

    const task = this.store.getTask(taskId) as TaskRecord | null;
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
        manualCorrections: [
          ...(Array.isArray(task.result?.manualCorrections) ? task.result.manualCorrections : []),
          correction
        ]
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

    const snapshot = this.decorateTask(updated);
    this.eventBus.broadcast("task.updated", snapshot);
    return snapshot;
  }

  recordTaskTeachStep(
    taskId: string,
    step: RuntimeStep,
    { source = "user" }: { source?: string } = {}
  ): TaskSnapshot | null {
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
        manualTeachSteps: [
          ...(Array.isArray(task.result?.manualTeachSteps) ? task.result.manualTeachSteps : []),
          normalizedStep
        ]
      }
    }) as TaskRecord | null;

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

    const snapshot = this.decorateTask(updated);
    this.eventBus.broadcast("task.updated", snapshot);
    return snapshot;
  }

  controlTask(
    taskId: string,
    action: string,
    {
      source = "user",
      reason = null,
      note = null
    }: { source?: string; reason?: string | null; note?: string | null } = {}
  ): TaskSnapshot | null {
    const task = this.store.getTask(taskId) as TaskRecord | null;
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
    }) as TaskRecord | null;

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

    const snapshot = this.decorateTask(updated);
    this.eventBus.broadcast("task.updated", snapshot);
    return snapshot;
  }

  async createTask(taskSpec: TaskSpec): Promise<TaskRecord> {
    const normalized = this.sentinel.normalize(taskSpec);
    const task = this.store.createTask(normalized) as TaskRecord;
    this.eventBus.broadcast("task.created", task);
    this.runtimeSupervisor.enqueue(task.id);
    return task;
  }

  async previewTask(taskSpec: TaskSpec) {
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

  async ingestEvent(event: IncomingEvent) {
    const stored = this.store.createEvent(event as Record<string, unknown>);
    this.eventBus.broadcast("event.created", stored);

    if (event.payload?.taskSpec) {
      const taskSpec = {
        ...this.sentinel.fromEvent(event),
        ...event.payload.taskSpec
      };
      const task = await this.createTask(taskSpec);
      const linked = this.store.attachEventTask(stored.id, task.id) as {
        id: string;
        type: string;
        source: string;
        task_id: string | null;
        payload: string;
        created_at: string;
      };
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

  buildTaskSpecFromWatchRule(
    watchRule: WatchRule,
    detection: WatchDetection = {},
    overrides: Record<string, unknown> = {}
  ): TaskSpec {
    return this.watchExecutionService.buildTaskSpecFromWatchRule(watchRule, detection, overrides);
  }

  async draftWatchReply({
    watchRule,
    detection,
    pack
  }: {
    watchRule: WatchRule;
    detection: WatchDetection;
    pack: Parameters<WatchExecutionService["draftReply"]>[0]["pack"];
  }) {
    return this.watchExecutionService.draftReply({ watchRule, detection, pack });
  }

  async createTaskFromWatchRule(
    watchRule: WatchRule,
    detection: WatchDetection = {},
    options: Record<string, unknown> = {}
  ) {
    return this.watchExecutionService.createTaskFromWatchRule(watchRule, detection, options);
  }

  async shutdown() {
    await this.automationJobService.stop();
    await this.learningService.stop();
    await this.runtimeSupervisor.shutdown();
  }

  getStartupRecovery(): DaemonStartupRecovery | null {
    return this.startupRecovery;
  }

  getLearningStatus(): LearningStatus {
    return this.learningService.status();
  }

  listLearningSources(): LearningSource[] {
    return this.learningService.listSources();
  }

  searchMemory(query: string, limit = 20): KnowledgeChunk[] {
    return this.learningService.searchMemory(query, limit);
  }

  inspectMemoryEntity(entityId: string): MemoryEntitySnapshot | null {
    return this.learningService.inspectEntity(entityId);
  }

  listDigests(limit = 30): DigestRecord[] {
    return this.learningService.listDigests(limit);
  }

  async runDigest(): Promise<DigestRecord> {
    return this.learningService.runDigest();
  }

  listProposals(limit = 50): ProposalRecord[] {
    return this.learningService.listProposals(limit);
  }

  listAutomationJobs(limit = 100): AutomationJobRecord[] {
    return this.automationJobService.listJobs(limit);
  }

  getAutomationJob(jobId: string): AutomationJobRecord | null {
    return this.automationJobService.getJob(jobId);
  }

  createAutomationJob(input: Record<string, unknown>): AutomationJobRecord {
    return this.automationJobService.createJob({
      template: String(input.template ?? "") as AutomationJobRecord["template"],
      name: typeof input.name === "string" ? input.name : null,
      workspaceName: typeof input.workspaceName === "string" ? input.workspaceName : null,
      preferredSurface:
        input.preferredSurface === "browser" || input.preferredSurface === "desktop" || input.preferredSurface === "auto"
          ? input.preferredSurface
          : null,
      goal: typeof input.goal === "string" ? input.goal : null,
      inputs: input.inputs && typeof input.inputs === "object" ? (input.inputs as Record<string, unknown>) : null,
      enabled: typeof input.enabled === "boolean" ? input.enabled : true,
      hourOfDay: input.hourOfDay == null ? null : Number(input.hourOfDay),
      intervalMinutes: input.intervalMinutes == null ? null : Number(input.intervalMinutes)
    });
  }

  enableAutomationJob(jobId: string): AutomationJobRecord {
    return this.automationJobService.enableJob(jobId);
  }

  disableAutomationJob(jobId: string): AutomationJobRecord {
    return this.automationJobService.disableJob(jobId);
  }

  async runAutomationJob(jobId: string): Promise<AutomationJobRecord> {
    return this.automationJobService.runJobNow(jobId);
  }

  deleteAutomationJob(jobId: string): boolean {
    return this.automationJobService.deleteJob(jobId);
  }

  async acceptProposal(proposalId: string): Promise<{ proposal: ProposalRecord; taskId: string }> {
    return this.learningService.acceptProposal(proposalId);
  }

  rejectProposal(proposalId: string): ProposalRecord {
    return this.learningService.rejectProposal(proposalId);
  }
}

export function createControlPlane(config) {
  return new ControlPlane(config);
}
