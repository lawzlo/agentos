import { nowIso } from "./id.js";

interface WatchRuleLike {
  id: string;
  enabled: boolean;
  status: string;
  goal: string;
  livePack: string;
  pollIntervalMs: number;
  workspaceName?: string | null;
  appTarget?: string | null;
  preferredSurface?: string | null;
  dedupeState?: Record<string, unknown>;
  watchProfile?: Record<string, unknown>;
  lastObservedAt?: string | null;
  lastTriggeredAt?: string | null;
  lastError?: string | null;
}

interface TaskLike {
  id: string;
  status: string;
}

function isActiveTask(task?: TaskLike | null): boolean {
  if (!task) {
    return false;
  }

  return !["completed", "failed", "blocked", "interrupted"].includes(task.status);
}

export class WatchScheduler {
  controlPlane: any;
  store: any;
  eventBus: any;
  livePackRegistry: any;
  running: boolean;
  timers: Map<string, NodeJS.Timeout>;
  inFlight: Set<string>;

  constructor({
    controlPlane,
    store,
    eventBus,
    livePackRegistry
  }: {
    controlPlane: any;
    store: any;
    eventBus: any;
    livePackRegistry: any;
  }) {
    this.controlPlane = controlPlane;
    this.store = store;
    this.eventBus = eventBus;
    this.livePackRegistry = livePackRegistry;
    this.running = false;
    this.timers = new Map();
    this.inFlight = new Set();
  }

  async start(): Promise<void> {
    this.running = true;
    for (const rule of this.store.listWatchRules()) {
      this.sync(rule);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.inFlight.clear();
  }

  sync(rule: WatchRuleLike): void {
    const current = this.timers.get(rule.id);
    if (current) {
      clearInterval(current);
      this.timers.delete(rule.id);
    }

    if (!this.running || !rule.enabled) {
      return;
    }

    const timer = setInterval(() => {
      void this.scan(rule.id);
    }, rule.pollIntervalMs);
    this.timers.set(rule.id, timer);
    void this.scan(rule.id);
  }

  remove(ruleId: string): void {
    const current = this.timers.get(ruleId);
    if (current) {
      clearInterval(current);
      this.timers.delete(ruleId);
    }
  }

  async scan(ruleId: string): Promise<void> {
    if (this.inFlight.has(ruleId)) {
      return;
    }

    const rule = this.store.getWatchRule(ruleId) as WatchRuleLike | null;
    if (!rule || !rule.enabled) {
      return;
    }

    const pack = this.livePackRegistry.get(rule.livePack);
    if (!pack) {
      const degraded = this.store.putWatchRule({
        ...rule,
        status: "degraded",
        lastError: `Unknown live pack: ${rule.livePack}`
      });
      this.eventBus.broadcast("watch.updated", degraded);
      return;
    }

    this.inFlight.add(ruleId);

    try {
      const activeTaskId = String(rule.dedupeState?.activeTaskId ?? "") || null;
      const activeTask = activeTaskId ? this.store.getTask(activeTaskId) : null;
      if (isActiveTask(activeTask)) {
        const updated = this.store.putWatchRule({
          ...rule,
          lastObservedAt: nowIso(),
          lastError: null,
          status: "watching"
        });
        this.eventBus.broadcast("watch.updated", updated);
        return;
      }

      const workspaceName = rule.workspaceName ?? `${rule.livePack}-live`;
      const workspace = await this.controlPlane.workspaceManager.prepareProfile(workspaceName, {
        purpose: "live-watch",
        livePack: rule.livePack,
        appTarget: rule.appTarget ?? null
      });

      await pack.activate?.({
        rule,
        workspace,
        surfaceRegistry: this.controlPlane.surfaceRegistry,
        controlPlane: this.controlPlane
      });

      const worldState = pack.observeInbox
        ? await pack.observeInbox({
            rule,
            workspace,
            surfaceRegistry: this.controlPlane.surfaceRegistry,
            controlPlane: this.controlPlane
          })
        : null;

      const detection = await pack.detectNewItems?.({
        rule,
        worldState,
        dedupeState: rule.dedupeState ?? {},
        workspace,
        controlPlane: this.controlPlane
      });

      if (!detection) {
        const updated = this.store.putWatchRule({
          ...rule,
          lastObservedAt: nowIso(),
          lastError: null,
          status: "watching",
          dedupeState: {
            ...(rule.dedupeState ?? {}),
            failureCount: 0,
            activeTaskId: null
          }
        });
        this.eventBus.broadcast("watch.updated", updated);
        return;
      }

      const task = await this.controlPlane.createTaskFromWatchRule(rule, detection);
      const updated = this.store.putWatchRule({
        ...rule,
        lastObservedAt: nowIso(),
        lastTriggeredAt: nowIso(),
        lastError: null,
        status: "watching",
        dedupeState: {
          ...(rule.dedupeState ?? {}),
          lastFingerprint: detection.fingerprint ?? detection.summary ?? task.id,
          lastSummary: detection.summary ?? null,
          activeTaskId: task.id,
          failureCount: 0
        }
      });
      this.eventBus.broadcast("watch.triggered", {
        rule: updated,
        task
      });
      this.eventBus.broadcast("watch.updated", updated);
    } catch (error) {
      const current = this.store.getWatchRule(ruleId) as WatchRuleLike | null;
      const failureCount = Number(current?.dedupeState?.failureCount ?? 0) + 1;
      const updated = this.store.putWatchRule({
        ...(current ?? rule),
        lastObservedAt: nowIso(),
        lastError: error instanceof Error ? error.message : String(error),
        status: failureCount >= 2 ? "degraded" : "watching",
        dedupeState: {
          ...((current ?? rule).dedupeState ?? {}),
          failureCount
        }
      });
      this.eventBus.broadcast("watch.updated", updated);
      this.eventBus.broadcast("watch.error", {
        rule: updated,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.inFlight.delete(ruleId);
    }
  }
}
