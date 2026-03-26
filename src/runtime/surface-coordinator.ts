import type { EventBus } from "./event-bus.js";
import { SurfaceRegistry, type SurfaceName } from "./surface-registry.js";
import {
  SurfaceScheduler,
  type SurfaceHolderKind,
  type SurfaceKey,
  type SurfaceLeaseHandle,
  type SurfaceLeaseSnapshot,
  type SurfacePriority,
  type SurfaceWaitPolicy
} from "./surface-scheduler.js";
import type { SurfaceAdapter } from "./adapters/surface-adapter.js";

interface SurfaceCoordinatorOptions {
  surfaceRegistry: SurfaceRegistry;
  surfaceScheduler: SurfaceScheduler;
  eventBus?: EventBus | null;
}

interface SurfaceLeaseRequestLike {
  surface: SurfaceName;
  workspaceKey?: string | null;
  holderId: string;
  holderKind: SurfaceHolderKind;
  priority: SurfacePriority;
  waitPolicy: SurfaceWaitPolicy;
  timeoutMs?: number | null;
  taskId?: string | null;
  watchId?: string | null;
  reason: string;
}

export interface SurfaceSession {
  surface: SurfaceName;
  surfaceKey: SurfaceKey;
  adapter: SurfaceAdapter;
  surfaceRegistry: SurfaceRegistry;
  lease: SurfaceLeaseHandle;
}

class ScopedSurfaceRegistry extends SurfaceRegistry {
  constructor(surface: SurfaceName, adapter: SurfaceAdapter) {
    super({ [surface]: adapter });
  }

  override async shutdown(): Promise<void> {}
}

function normalizeWorkspaceKey(value: string | null | undefined): string {
  const normalized = String(value ?? "").trim().toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-");
  return normalized || "default";
}

export class SurfaceCoordinator {
  surfaceRegistry: SurfaceRegistry;
  surfaceScheduler: SurfaceScheduler;
  eventBus: EventBus | null;

  constructor({ surfaceRegistry, surfaceScheduler, eventBus = null }: SurfaceCoordinatorOptions) {
    this.surfaceRegistry = surfaceRegistry;
    this.surfaceScheduler = surfaceScheduler;
    this.eventBus = eventBus;
  }

  resolveSurfaceKey(surface: SurfaceName, workspaceKey: string | null | undefined = null): SurfaceKey {
    if (surface === "desktop") {
      return "desktop-global";
    }

    const browserAdapter = this.surfaceRegistry.get<SurfaceAdapter & { usesSharedSession?: () => boolean }>("browser");
    if (browserAdapter?.usesSharedSession?.()) {
      return "browser-main-session";
    }

    return `browser-workspace:${normalizeWorkspaceKey(workspaceKey)}`;
  }

  listSnapshots(): SurfaceLeaseSnapshot[] {
    return this.surfaceScheduler.listSnapshots();
  }

  getSnapshot(surfaceKey: SurfaceKey): SurfaceLeaseSnapshot | null {
    return this.surfaceScheduler.getSnapshot(surfaceKey);
  }

  async withTaskStepSurface<T>(
    request: Omit<SurfaceLeaseRequestLike, "holderKind" | "priority" | "waitPolicy">,
    fn: (session: SurfaceSession) => Promise<T>
  ): Promise<T> {
    const result = await this.#withSurfaceLease(
      {
        ...request,
        holderKind: "task_step",
        priority: "task",
        waitPolicy: "block"
      },
      fn
    );
    if (result == null) {
      throw new Error(`Failed to acquire task surface lease for ${request.surface}.`);
    }
    return result;
  }

  async withWatchScanSession<T>(
    request: Omit<SurfaceLeaseRequestLike, "holderKind" | "priority" | "waitPolicy">,
    fn: (session: SurfaceSession) => Promise<T>
  ): Promise<T | null> {
    return this.#withSurfaceLease(
      {
        ...request,
        holderKind: "watch_scan",
        priority: "watch",
        waitPolicy: "skip_if_busy"
      },
      fn
    );
  }

  async withProbeSurface<T>(
    request: Omit<SurfaceLeaseRequestLike, "holderKind" | "priority" | "waitPolicy">,
    fn: (session: SurfaceSession) => Promise<T>
  ): Promise<T | null> {
    return this.#withSurfaceLease(
      {
        ...request,
        holderKind: "state_probe",
        priority: "probe",
        waitPolicy: "timeout",
        timeoutMs: request.timeoutMs ?? 3000
      },
      fn
    );
  }

  async #withSurfaceLease<T>(request: SurfaceLeaseRequestLike, fn: (session: SurfaceSession) => Promise<T>): Promise<T | null> {
    const surfaceKey = this.resolveSurfaceKey(request.surface, request.workspaceKey);
    const adapter = this.surfaceRegistry.get<SurfaceAdapter>(request.surface);
    if (!adapter) {
      throw new Error(`Unknown surface: ${request.surface}`);
    }

    const beforeSnapshot = this.surfaceScheduler.getSnapshot(surfaceKey);
    if (beforeSnapshot?.activeHolder || beforeSnapshot?.queue.length) {
      this.#broadcast("surface.waiting", {
        surface: request.surface,
        surfaceKey,
        holderId: request.holderId,
        holderKind: request.holderKind,
        priority: request.priority,
        taskId: request.taskId ?? null,
        watchId: request.watchId ?? null,
        reason: request.reason,
        queueDepth: beforeSnapshot.queue.length
      });
    }

    const lease = await this.surfaceScheduler.acquire({
      surfaceKey,
      holderId: request.holderId,
      holderKind: request.holderKind,
      priority: request.priority,
      waitPolicy: request.waitPolicy,
      timeoutMs: request.timeoutMs ?? null,
      taskId: request.taskId ?? null,
      watchId: request.watchId ?? null,
      workspaceKey: request.workspaceKey ?? null,
      reason: request.reason
    });

    if (!lease) {
      const snapshot = this.surfaceScheduler.getSnapshot(surfaceKey);
      this.#broadcast(request.waitPolicy === "timeout" ? "surface.timeout" : "surface.skipped", {
        surface: request.surface,
        surfaceKey,
        holderId: request.holderId,
        holderKind: request.holderKind,
        priority: request.priority,
        taskId: request.taskId ?? null,
        watchId: request.watchId ?? null,
        reason: request.reason,
        snapshot
      });
      return null;
    }

    const session: SurfaceSession = {
      surface: request.surface,
      surfaceKey,
      adapter,
      surfaceRegistry: new ScopedSurfaceRegistry(request.surface, adapter),
      lease
    };

    this.#broadcast("surface.acquired", {
      surface: request.surface,
      surfaceKey,
      leaseId: lease.id,
      holderId: lease.holderId,
      holderKind: lease.holderKind,
      priority: lease.priority,
      taskId: lease.taskId,
      watchId: lease.watchId,
      reason: lease.reason
    });

    try {
      return await fn(session);
    } finally {
      await this.surfaceScheduler.release(lease);
      this.#broadcast("surface.released", {
        surface: request.surface,
        surfaceKey,
        leaseId: lease.id,
        holderId: lease.holderId,
        holderKind: lease.holderKind,
        priority: lease.priority,
        taskId: lease.taskId,
        watchId: lease.watchId,
        reason: lease.reason,
        snapshot: this.surfaceScheduler.getSnapshot(surfaceKey)
      });
    }
  }

  #broadcast(type: string, payload: Record<string, unknown>): void {
    this.eventBus?.broadcast(type, payload);
  }
}
