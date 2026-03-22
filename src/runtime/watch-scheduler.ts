interface WatchRuleLike {
  id: string;
  enabled: boolean;
  pollIntervalMs: number;
  dedupeState?: Record<string, unknown>;
}

interface WatchExecutionService {
  scan(ruleId: string): Promise<void>;
}

export class WatchScheduler {
  store: {
    listWatchRules(): WatchRuleLike[];
    getWatchRule(id: string): WatchRuleLike | null;
  };
  executionService: WatchExecutionService;
  running: boolean;
  timers: Map<string, NodeJS.Timeout>;
  inFlight: Set<string>;

  constructor({
    store,
    executionService
  }: {
    store: WatchScheduler["store"];
    executionService: WatchExecutionService;
  }) {
    this.store = store;
    this.executionService = executionService;
    this.running = false;
    this.timers = new Map();
    this.inFlight = new Set();
  }

  async start(): Promise<{ resumedWatchCount: number }> {
    this.running = true;
    let resumedWatchCount = 0;
    for (const rule of this.store.listWatchRules()) {
      if (rule.enabled) {
        resumedWatchCount += 1;
      }
      this.sync(rule);
    }
    return {
      resumedWatchCount
    };
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    const started = Date.now();
    while (this.inFlight.size > 0) {
      if (Date.now() - started >= 5000) {
        const sampleRuleId = this.inFlight.values().next().value as string | undefined;
        const sampleStage = sampleRuleId
          ? String(this.store.getWatchRule(sampleRuleId)?.dedupeState?.scanStage ?? "").trim() || "unknown"
          : "unknown";
        throw new Error(`Timed out waiting for watch scans to finish during shutdown (stage: ${sampleStage})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async removeAndWait(ruleId: string, timeoutMs = 5000): Promise<void> {
    const timer = this.timers.get(ruleId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(ruleId);
    }

    const started = Date.now();
    while (this.inFlight.has(ruleId)) {
      if (Date.now() - started >= timeoutMs) {
        const stage = String(this.store.getWatchRule(ruleId)?.dedupeState?.scanStage ?? "").trim() || "unknown";
        throw new Error(`Timed out waiting for watch scan to finish for ${ruleId} (stage: ${stage})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
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

    this.inFlight.add(ruleId);
    try {
      await this.executionService.scan(ruleId);
    } finally {
      this.inFlight.delete(ruleId);
    }
  }
}
