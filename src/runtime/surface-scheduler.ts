import { createId, nowIso } from "./id.js";

export type SurfaceKey = "desktop-global" | "browser-main-session" | `browser-workspace:${string}`;
export type SurfaceHolderKind = "task_step" | "watch_scan" | "state_probe" | "debug_probe";
export type SurfacePriority = "task" | "probe" | "watch";
export type SurfaceWaitPolicy = "block" | "skip_if_busy" | "timeout";

export interface SurfaceLeaseRequest {
  surfaceKey: SurfaceKey;
  holderId: string;
  holderKind: SurfaceHolderKind;
  priority: SurfacePriority;
  waitPolicy: SurfaceWaitPolicy;
  timeoutMs?: number | null;
  taskId?: string | null;
  watchId?: string | null;
  workspaceKey?: string | null;
  reason: string;
}

export interface SurfaceLeaseHandle {
  id: string;
  surfaceKey: SurfaceKey;
  holderId: string;
  holderKind: SurfaceHolderKind;
  priority: SurfacePriority;
  taskId: string | null;
  watchId: string | null;
  workspaceKey: string | null;
  reason: string;
  acquiredAt: string;
}

export interface SurfaceLeaseHolderSnapshot {
  leaseId: string;
  holderId: string;
  holderKind: SurfaceHolderKind;
  priority: SurfacePriority;
  taskId: string | null;
  watchId: string | null;
  workspaceKey: string | null;
  reason: string;
  acquiredAt?: string | null;
  queuedAt?: string | null;
  waitPolicy?: SurfaceWaitPolicy | null;
  timeoutMs?: number | null;
}

export interface SurfaceLeaseSnapshot {
  surfaceKey: SurfaceKey;
  activeHolder: SurfaceLeaseHolderSnapshot | null;
  queue: SurfaceLeaseHolderSnapshot[];
  updatedAt: string;
}

interface PendingLeaseEntry {
  leaseId: string;
  request: SurfaceLeaseRequest;
  queuedAt: string;
  order: number;
  resolve: (handle: SurfaceLeaseHandle | null) => void;
  timeout: NodeJS.Timeout | null;
}

interface ActiveLeaseEntry {
  handle: SurfaceLeaseHandle;
}

interface SurfaceSlot {
  surfaceKey: SurfaceKey;
  active: ActiveLeaseEntry | null;
  queue: PendingLeaseEntry[];
  nextOrder: number;
  updatedAt: string;
}

const PRIORITY_ORDER: Record<SurfacePriority, number> = {
  task: 0,
  probe: 1,
  watch: 2
};

function comparePending(left: PendingLeaseEntry, right: PendingLeaseEntry): number {
  const priorityDelta = PRIORITY_ORDER[left.request.priority] - PRIORITY_ORDER[right.request.priority];
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  return left.order - right.order;
}

function snapshotFromActive(entry: ActiveLeaseEntry): SurfaceLeaseHolderSnapshot {
  return {
    leaseId: entry.handle.id,
    holderId: entry.handle.holderId,
    holderKind: entry.handle.holderKind,
    priority: entry.handle.priority,
    taskId: entry.handle.taskId,
    watchId: entry.handle.watchId,
    workspaceKey: entry.handle.workspaceKey,
    reason: entry.handle.reason,
    acquiredAt: entry.handle.acquiredAt,
    queuedAt: null,
    waitPolicy: null,
    timeoutMs: null
  };
}

function snapshotFromPending(entry: PendingLeaseEntry): SurfaceLeaseHolderSnapshot {
  return {
    leaseId: entry.leaseId,
    holderId: entry.request.holderId,
    holderKind: entry.request.holderKind,
    priority: entry.request.priority,
    taskId: entry.request.taskId ?? null,
    watchId: entry.request.watchId ?? null,
    workspaceKey: entry.request.workspaceKey ?? null,
    reason: entry.request.reason,
    acquiredAt: null,
    queuedAt: entry.queuedAt,
    waitPolicy: entry.request.waitPolicy,
    timeoutMs:
      Number.isFinite(Number(entry.request.timeoutMs)) && Number(entry.request.timeoutMs) > 0
        ? Number(entry.request.timeoutMs)
        : null
  };
}

export class SurfaceScheduler {
  slots: Map<SurfaceKey, SurfaceSlot>;

  constructor() {
    this.slots = new Map();
  }

  async acquire(request: SurfaceLeaseRequest): Promise<SurfaceLeaseHandle | null> {
    const slot = this.#getOrCreateSlot(request.surfaceKey);
    const busy = Boolean(slot.active) || slot.queue.length > 0;

    if (!busy) {
      return this.#grantImmediate(slot, request);
    }

    if (request.waitPolicy === "skip_if_busy") {
      return null;
    }

    const timeoutMs = Number(request.timeoutMs ?? 0);
    return new Promise<SurfaceLeaseHandle | null>((resolve) => {
      const leaseId = createId("surfacelease");
      const pending: PendingLeaseEntry = {
        leaseId,
        request,
        queuedAt: nowIso(),
        order: slot.nextOrder++,
        resolve,
        timeout: null
      };

      if (request.waitPolicy === "timeout" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        pending.timeout = setTimeout(() => {
          this.#dropPending(slot, pending.leaseId);
          resolve(null);
        }, timeoutMs);
      }

      slot.queue.push(pending);
      slot.queue.sort(comparePending);
      slot.updatedAt = nowIso();
      this.#dispatch(slot);
    });
  }

  async release(handle: SurfaceLeaseHandle): Promise<void> {
    const slot = this.slots.get(handle.surfaceKey);
    if (!slot?.active || slot.active.handle.id !== handle.id) {
      return;
    }

    slot.active = null;
    slot.updatedAt = nowIso();
    this.#dispatch(slot);
  }

  listSnapshots(): SurfaceLeaseSnapshot[] {
    return Array.from(this.slots.values()).map((slot) => this.#snapshotForSlot(slot));
  }

  getSnapshot(surfaceKey: SurfaceKey): SurfaceLeaseSnapshot | null {
    const slot = this.slots.get(surfaceKey);
    return slot ? this.#snapshotForSlot(slot) : null;
  }

  #getOrCreateSlot(surfaceKey: SurfaceKey): SurfaceSlot {
    const existing = this.slots.get(surfaceKey);
    if (existing) {
      return existing;
    }

    const slot: SurfaceSlot = {
      surfaceKey,
      active: null,
      queue: [],
      nextOrder: 0,
      updatedAt: nowIso()
    };
    this.slots.set(surfaceKey, slot);
    return slot;
  }

  #grantImmediate(slot: SurfaceSlot, request: SurfaceLeaseRequest): SurfaceLeaseHandle {
    const handle: SurfaceLeaseHandle = {
      id: createId("surfacelease"),
      surfaceKey: request.surfaceKey,
      holderId: request.holderId,
      holderKind: request.holderKind,
      priority: request.priority,
      taskId: request.taskId ?? null,
      watchId: request.watchId ?? null,
      workspaceKey: request.workspaceKey ?? null,
      reason: request.reason,
      acquiredAt: nowIso()
    };

    slot.active = { handle };
    slot.updatedAt = nowIso();
    return handle;
  }

  #dispatch(slot: SurfaceSlot): void {
    if (slot.active || slot.queue.length === 0) {
      return;
    }

    const next = slot.queue.shift();
    if (!next) {
      return;
    }

    if (next.timeout) {
      clearTimeout(next.timeout);
      next.timeout = null;
    }

    const handle: SurfaceLeaseHandle = {
      id: next.leaseId,
      surfaceKey: next.request.surfaceKey,
      holderId: next.request.holderId,
      holderKind: next.request.holderKind,
      priority: next.request.priority,
      taskId: next.request.taskId ?? null,
      watchId: next.request.watchId ?? null,
      workspaceKey: next.request.workspaceKey ?? null,
      reason: next.request.reason,
      acquiredAt: nowIso()
    };

    slot.active = { handle };
    slot.updatedAt = nowIso();
    next.resolve(handle);
  }

  #dropPending(slot: SurfaceSlot, leaseId: string): void {
    const index = slot.queue.findIndex((entry) => entry.leaseId === leaseId);
    if (index === -1) {
      return;
    }

    const [entry] = slot.queue.splice(index, 1);
    if (entry?.timeout) {
      clearTimeout(entry.timeout);
      entry.timeout = null;
    }
    slot.updatedAt = nowIso();
  }

  #snapshotForSlot(slot: SurfaceSlot): SurfaceLeaseSnapshot {
    return {
      surfaceKey: slot.surfaceKey,
      activeHolder: slot.active ? snapshotFromActive(slot.active) : null,
      queue: slot.queue.map((entry) => snapshotFromPending(entry)),
      updatedAt: slot.updatedAt
    };
  }
}
