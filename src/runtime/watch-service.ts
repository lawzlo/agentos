import { normalizeWatchRule } from "./watch-rule-parser.js";
import { deriveWatchProfileFromExecution } from "./watch-profile.js";
import { buildWatchHealth, decorateWatchRule } from "./watch-presenters.js";

export class WatchService {
  store: any;
  modelClient: any;
  watchScheduler: any;
  eventBus: any;
  livePackRegistry: any;
  connectors: any[];
  config: any;

  constructor({
    store,
    modelClient,
    watchScheduler,
    eventBus,
    livePackRegistry,
    connectors,
    config
  }: Record<string, any>) {
    this.store = store;
    this.modelClient = modelClient;
    this.watchScheduler = watchScheduler;
    this.eventBus = eventBus;
    this.livePackRegistry = livePackRegistry;
    this.connectors = connectors;
    this.config = config;
  }

  decorate(rule: Record<string, any> | null) {
    return decorateWatchRule(rule);
  }

  saveTaskAsWatchRule(
    taskId: string,
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
    }: Record<string, any> = {}
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
    const decorated = this.decorate(watchRule);
    this.eventBus.broadcast(existingWatchRule ? "watch.learned" : "watch.created", decorated);
    return decorated;
  }

  list() {
    return this.store.listWatchRules().map((rule: Record<string, any>) => this.decorate(rule));
  }

  get(watchRuleId: string) {
    return this.decorate(this.store.getWatchRule(watchRuleId));
  }

  create(spec: Record<string, any>) {
    const normalized = normalizeWatchRule(spec, {
      modelConfigured: this.modelClient.isConfigured()
    });
    const watchRule = this.store.putWatchRule(normalized);
    this.watchScheduler.sync(watchRule);
    const decorated = this.decorate(watchRule);
    this.eventBus.broadcast("watch.created", decorated);
    return decorated;
  }

  update(watchRuleId: string, patch: Record<string, any>) {
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
    const decorated = this.decorate(watchRule);
    this.eventBus.broadcast("watch.updated", decorated);
    return decorated;
  }

  enable(watchRuleId: string) {
    return this.update(watchRuleId, {
      enabled: true,
      status: "watching",
      lastError: null
    });
  }

  disable(watchRuleId: string) {
    const watchRule = this.update(watchRuleId, {
      enabled: false,
      status: "disabled"
    });
    this.watchScheduler.remove(watchRuleId);
    return watchRule;
  }

  delete(watchRuleId: string) {
    const deleted = this.store.deleteWatchRule(watchRuleId);
    if (!deleted) {
      throw new Error(`Watch rule not found: ${watchRuleId}`);
    }
    this.watchScheduler.remove(watchRuleId);
    this.eventBus.broadcast("watch.deleted", { id: watchRuleId });
    return true;
  }

  getHealth(watchRuleId: string) {
    const watchRule = this.store.getWatchRule(watchRuleId);
    if (!watchRule) {
      throw new Error(`Watch rule not found: ${watchRuleId}`);
    }
    return buildWatchHealth(watchRule);
  }

  retry(watchRuleId: string) {
    const watchRule = this.store.getWatchRule(watchRuleId);
    if (!watchRule) {
      throw new Error(`Watch rule not found: ${watchRuleId}`);
    }

    const updated = this.store.putWatchRule({
      ...watchRule,
      status: watchRule.enabled ? "watching" : "disabled",
      lastError: null,
      dedupeState: {
        ...(watchRule.dedupeState ?? {}),
        failureCount: 0,
        retryAfter: null,
        backoffMs: 0,
        activeDraftId: null,
        activeTaskId: null,
        lastFingerprint: null,
        lastSummary: null,
        lastContext: []
      }
    });
    this.watchScheduler.sync(updated);
    const decorated = this.decorate(updated);
    this.eventBus.broadcast("watch.updated", decorated);
    this.eventBus.broadcast("watch.retry_requested", decorated);
    return decorated;
  }

  doctor() {
    const watches = this.store.listWatchRules();
    const drafts = this.store.listDrafts(200);
    const degraded = watches.filter((rule: Record<string, any>) => ["degraded", "backoff"].includes(rule.status));
    const pendingDrafts = drafts.filter((draft: Record<string, any>) => draft.status === "pending");
    const warnings = [];
    if (!this.config.browserExecutable) {
      warnings.push("No managed browser executable detected.");
    }
    if (!this.modelClient.isConfigured()) {
      warnings.push("Model client is not configured; live reply drafting uses heuristics.");
    }
    if (degraded.length) {
      warnings.push(`${degraded.length} watch rule(s) are in backoff or degraded state.`);
    }
    if (pendingDrafts.length) {
      warnings.push(`${pendingDrafts.length} pending draft(s) need approval or rejection.`);
    }

    return {
      ok: warnings.length === 0,
      warnings,
      browserExecutable: this.config.browserExecutable ?? null,
      modelConfigured: this.modelClient.isConfigured(),
      livePackCount: this.livePackRegistry.list().length,
      degradedWatchCount: degraded.length,
      pendingDraftCount: pendingDrafts.length,
      connectorCount: this.connectors.length
    };
  }
}
