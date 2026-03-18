interface WatchRuleLike {
  id: string;
  enabled: boolean;
  pollIntervalMs: number;
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

  async removeAndWait(ruleId: string, timeoutMs = 5000): Promise<void> {
    const timer = this.timers.get(ruleId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(ruleId);
    }

    const started = Date.now();
    while (this.inFlight.has(ruleId)) {
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Timed out waiting for watch scan to finish for ${ruleId}`);
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
