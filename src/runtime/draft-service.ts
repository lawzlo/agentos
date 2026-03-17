import { decorateDraft } from "./watch-presenters.js";

export class DraftService {
  store: any;
  eventBus: any;
  createTask: any;
  getTask: any;
  getWatchRule: any;
  decorateWatchRule: any;

  constructor({
    store,
    eventBus,
    createTask,
    getTask,
    getWatchRule,
    decorateWatchRule
  }: Record<string, any>) {
    this.store = store;
    this.eventBus = eventBus;
    this.createTask = createTask;
    this.getTask = getTask;
    this.getWatchRule = getWatchRule;
    this.decorateWatchRule = decorateWatchRule;
  }

  decorate(draft: Record<string, any> | null) {
    return decorateDraft(draft, {
      getWatchRule: this.getWatchRule,
      getTask: this.getTask
    });
  }

  list(limit = 50) {
    return this.store.listDrafts(limit).map((draft: Record<string, any>) => this.decorate(draft));
  }

  get(draftId: string) {
    return this.decorate(this.store.getDraft(draftId));
  }

  create({
    watchRule = null,
    taskSpec,
    detection = {},
    riskDecision,
    replyText = null,
    summary = null,
    metadata = {}
  }: Record<string, any>) {
    const draft = this.store.createDraft({
      watchRuleId: watchRule?.id ?? null,
      livePack: watchRule?.livePack ?? null,
      status: "pending",
      summary,
      replyText,
      fingerprint: detection?.fingerprint ?? null,
      taskSpec,
      detection,
      riskDecision,
      metadata
    });
    const decorated = this.decorate(draft);
    this.eventBus.broadcast("draft.created", decorated);
    return decorated;
  }

  async approve(draftId: string) {
    const draft = this.store.getDraft(draftId);
    if (!draft) {
      throw new Error(`Draft not found: ${draftId}`);
    }
    if (draft.status !== "pending") {
      throw new Error("Only pending drafts can be approved.");
    }

    const task = await this.createTask(draft.taskSpec);
    const approved = this.store.updateDraft(draftId, {
      status: "approved",
      taskId: task.id,
      approvedAt: new Date().toISOString()
    });

    if (draft.watchRuleId) {
      const watchRule = this.store.getWatchRule(draft.watchRuleId);
      if (watchRule) {
        const updated = this.store.putWatchRule({
          ...watchRule,
          status: "watching",
          lastError: null,
          dedupeState: {
            ...(watchRule.dedupeState ?? {}),
            activeTaskId: task.id,
            activeDraftId: null,
            lastFingerprint: draft.fingerprint ?? watchRule.dedupeState?.lastFingerprint ?? null,
            lastSummary: draft.summary ?? watchRule.dedupeState?.lastSummary ?? null
          }
        });
        this.eventBus.broadcast("watch.updated", this.decorateWatchRule(updated));
      }
    }

    const decorated = this.decorate(approved);
    this.eventBus.broadcast("draft.approved", decorated);
    return decorated;
  }

  reject(draftId: string, reason: string | null = null) {
    const draft = this.store.getDraft(draftId);
    if (!draft) {
      throw new Error(`Draft not found: ${draftId}`);
    }
    if (draft.status !== "pending") {
      throw new Error("Only pending drafts can be rejected.");
    }

    const rejected = this.store.updateDraft(draftId, {
      status: "rejected",
      rejectedAt: new Date().toISOString(),
      metadata: {
        ...(draft.metadata ?? {}),
        rejectionReason: reason ?? null
      }
    });

    if (draft.watchRuleId) {
      const watchRule = this.store.getWatchRule(draft.watchRuleId);
      if (watchRule) {
        const updated = this.store.putWatchRule({
          ...watchRule,
          status: "watching",
          lastError: null,
          dedupeState: {
            ...(watchRule.dedupeState ?? {}),
            activeDraftId: null,
            activeTaskId: null,
            lastFingerprint: draft.fingerprint ?? watchRule.dedupeState?.lastFingerprint ?? null,
            lastSummary: draft.summary ?? watchRule.dedupeState?.lastSummary ?? null
          }
        });
        this.eventBus.broadcast("watch.updated", this.decorateWatchRule(updated));
      }
    }

    const decorated = this.decorate(rejected);
    this.eventBus.broadcast("draft.rejected", decorated);
    return decorated;
  }
}
