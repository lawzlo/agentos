import { decorateDraft } from "./watch-presenters.js";
import { recordReplyApprovalGrant, replyApprovalWindowMs, resolveReplyPolicy } from "./reply-policy.js";
import type { EventBus } from "./event-bus.js";
import type { ControlPlaneStore } from "./store.js";
import type { DecoratedDraftRecord } from "./watch-presenters.js";
import type {
  DraftRecord,
  RiskGateDecision,
  TaskSnapshot,
  TaskSpec,
  WatchRule
} from "../types/runtime-schema.js";

interface DraftCreateInput {
  watchRule?: WatchRule | null;
  taskSpec: TaskSpec;
  detection?: Record<string, unknown>;
  riskDecision: RiskGateDecision;
  replyText?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown>;
}

interface DraftServiceOptions {
  store: ControlPlaneStore;
  eventBus: EventBus;
  createTask: (taskSpec: TaskSpec) => Promise<{ id: string }>;
  getTask: (taskId: string) => TaskSnapshot | null;
  getWatchRule: (watchRuleId: string) => WatchRule | null;
  decorateWatchRule: (watchRule: WatchRule | null) => WatchRule | null;
}

export class DraftService {
  store: ControlPlaneStore;
  eventBus: EventBus;
  createTask: DraftServiceOptions["createTask"];
  getTask: DraftServiceOptions["getTask"];
  getWatchRule: DraftServiceOptions["getWatchRule"];
  decorateWatchRule: DraftServiceOptions["decorateWatchRule"];

  constructor({
    store,
    eventBus,
    createTask,
    getTask,
    getWatchRule,
    decorateWatchRule
  }: DraftServiceOptions) {
    this.store = store;
    this.eventBus = eventBus;
    this.createTask = createTask;
    this.getTask = getTask;
    this.getWatchRule = getWatchRule;
    this.decorateWatchRule = decorateWatchRule;
  }

  decorate(draft: DraftRecord | null): DecoratedDraftRecord | null {
    return decorateDraft(draft, {
      getWatchRule: this.getWatchRule,
      getTask: this.getTask
    });
  }

  list(limit = 50): DecoratedDraftRecord[] {
    return this.store.listDrafts(limit).map((draft) => this.decorate(draft)).filter(Boolean) as DecoratedDraftRecord[];
  }

  get(draftId: string): DecoratedDraftRecord | null {
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
  }: DraftCreateInput): DecoratedDraftRecord {
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
    if (!decorated) {
      throw new Error("Draft decoration failed after creation.");
    }
    this.eventBus.broadcast("draft.created", decorated);
    return decorated;
  }

  async approve(draftId: string): Promise<DecoratedDraftRecord | null> {
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
        const replyPolicy = resolveReplyPolicy({
          watchRule,
          taskSpec: draft.taskSpec,
          livePack: draft.livePack ?? watchRule.livePack
        });
        const replyThreadKey = String(draft.metadata?.replyThreadKey ?? "").trim();
        const dedupeState =
          replyPolicy === "approve_once_then_auto" && replyThreadKey
            ? recordReplyApprovalGrant(
                {
                  ...(watchRule.dedupeState ?? {}),
                  activeTaskId: task.id,
                  activeDraftId: null,
                  lastFingerprint: draft.fingerprint ?? watchRule.dedupeState?.lastFingerprint ?? null,
                  lastSummary: draft.summary ?? watchRule.dedupeState?.lastSummary ?? null
                },
                replyThreadKey,
                Date.now() + replyApprovalWindowMs(watchRule.watchProfile?.governance)
              )
            : {
                ...(watchRule.dedupeState ?? {}),
                activeTaskId: task.id,
                activeDraftId: null,
                lastFingerprint: draft.fingerprint ?? watchRule.dedupeState?.lastFingerprint ?? null,
                lastSummary: draft.summary ?? watchRule.dedupeState?.lastSummary ?? null
              };
        const updated = this.store.putWatchRule({
          ...watchRule,
          status: "watching",
          lastError: null,
          dedupeState
        });
        this.eventBus.broadcast("watch.updated", this.decorateWatchRule(updated));
      }
    }

    const decorated = this.decorate(approved);
    this.eventBus.broadcast("draft.approved", decorated);
    return decorated;
  }

  reject(draftId: string, reason: string | null = null): DecoratedDraftRecord | null {
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
