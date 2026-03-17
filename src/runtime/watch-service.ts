import { normalizeWatchRule } from "./watch-rule-parser.js";
import { deriveWatchProfileFromExecution } from "./watch-profile.js";
import { buildWatchHealth, decorateWatchRule } from "./watch-presenters.js";
import type { AgentOsConfig } from "../config.js";
import type { EventBus } from "./event-bus.js";
import type { LivePackRegistry } from "./live-pack-registry.js";
import type { OpenAICompatibleModelClient } from "./model-client.js";
import type { ControlPlaneStore } from "./store.js";
import type { WatchScheduler } from "./watch-scheduler.js";
import type { ConnectorStatus, TaskSpec, TeachRecording, WatchHealth, WatchRule } from "../types/runtime-schema.js";
import type { WatchRuleInput } from "./watch-rule-parser.js";

interface WatchServiceOptions {
  store: ControlPlaneStore;
  modelClient: OpenAICompatibleModelClient;
  watchScheduler: WatchScheduler;
  eventBus: EventBus;
  livePackRegistry: LivePackRegistry;
  connectors: Array<{ status(): ConnectorStatus }>;
  config: AgentOsConfig;
}

interface SaveWatchRuleOptions {
  watchRuleId?: string | null;
  goal?: string | null;
  preferredSurface?: "browser" | "desktop" | null;
  workspaceName?: string | null;
  livePack?: string | null;
  appTarget?: string | null;
  skillName?: string | null;
  pollIntervalMs?: number | null;
  enabled?: boolean | null;
  triggerTexts?: string[];
}

export class WatchService {
  store: ControlPlaneStore;
  modelClient: OpenAICompatibleModelClient;
  watchScheduler: WatchScheduler;
  eventBus: EventBus;
  livePackRegistry: LivePackRegistry;
  connectors: Array<{ status(): ConnectorStatus }>;
  config: AgentOsConfig;

  constructor({
    store,
    modelClient,
    watchScheduler,
    eventBus,
    livePackRegistry,
    connectors,
    config
  }: WatchServiceOptions) {
    this.store = store;
    this.modelClient = modelClient;
    this.watchScheduler = watchScheduler;
    this.eventBus = eventBus;
    this.livePackRegistry = livePackRegistry;
    this.connectors = connectors;
    this.config = config;
  }

  decorate(rule: WatchRule | null): WatchRule | null {
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
    }: SaveWatchRuleOptions = {}
  ): WatchRule | null {
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
    const taskResult = task.result ?? {};
    const taskSpec = task.taskSpec as TaskSpec;
    const taskInputs = taskSpec.inputs ?? {};

    const watchProfile = deriveWatchProfileFromExecution({
      goal: task.goal,
      taskId,
      taskSpec: task.taskSpec,
      planSteps: task.plan ?? [],
      executionSteps: Array.isArray(taskResult.steps) ? taskResult.steps : [],
      manualTeachSteps: Array.isArray(taskResult.manualTeachSteps) ? taskResult.manualTeachSteps : [],
      manualCorrections: Array.isArray(taskResult.manualCorrections) ? taskResult.manualCorrections : [],
      result: task.result,
      teachRecording: (taskResult.teachRecording ?? null) as TeachRecording | null,
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
        preferredSurface:
          preferredSurface ??
          existingWatchRule?.preferredSurface ??
          (task.preferredSurface === "auto" ? "desktop" : task.preferredSurface),
        workspaceName: workspaceName ?? existingWatchRule?.workspaceName ?? taskSpec.workspaceName ?? null,
        livePack: livePack ?? existingWatchRule?.livePack ?? null,
        appTarget:
          appTarget ??
          existingWatchRule?.appTarget ??
          (typeof taskInputs.desktopApp === "string" ? taskInputs.desktopApp : null),
        skillName: skillName ?? existingWatchRule?.skillName ?? null,
        pollIntervalMs: pollIntervalMs ?? existingWatchRule?.pollIntervalMs ?? 15000,
        enabled: enabled ?? existingWatchRule?.enabled ?? true,
        watchProfile: {
          ...(existingWatchRule?.watchProfile ?? {}),
          ...watchProfile,
          executionMode: watchProfile.executionMode === "autonomous" ? "autonomous" : "planned"
        },
        taskInputs: {
          ...(existingWatchRule?.taskInputs ?? {}),
          ...taskInputs,
          watchTemplateLearnedFromTaskId: taskId
        },
        lastError: null,
        status: (enabled ?? existingWatchRule?.enabled ?? true) ? "watching" : "disabled"
      },
      {
        modelConfigured: this.modelClient.isConfigured()
      }
    );
    const watchRule = this.store.putWatchRule(normalized as unknown as Record<string, unknown>);
    this.watchScheduler.sync(watchRule);
    const decorated = this.decorate(watchRule);
    this.eventBus.broadcast(existingWatchRule ? "watch.learned" : "watch.created", decorated);
    return decorated;
  }

  list() {
    return this.store.listWatchRules().map((rule) => this.decorate(rule)).filter(Boolean);
  }

  get(watchRuleId: string): WatchRule | null {
    return this.decorate(this.store.getWatchRule(watchRuleId));
  }

  create(spec: WatchRuleInput): WatchRule | null {
    const normalized = normalizeWatchRule(spec, {
      modelConfigured: this.modelClient.isConfigured()
    });
    const watchRule = this.store.putWatchRule(normalized as unknown as Record<string, unknown>);
    this.watchScheduler.sync(watchRule);
    const decorated = this.decorate(watchRule);
    this.eventBus.broadcast("watch.created", decorated);
    return decorated;
  }

  update(watchRuleId: string, patch: Partial<WatchRuleInput> & { taskInputs?: Record<string, unknown> }) {
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
    const watchRule = this.store.putWatchRule(normalized as unknown as Record<string, unknown>);
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

  getHealth(watchRuleId: string): WatchHealth {
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
    const degraded = watches.filter((rule) => ["degraded", "backoff"].includes(rule.status));
    const pendingDrafts = drafts.filter((draft) => draft.status === "pending");
    const warnings: string[] = [];
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
