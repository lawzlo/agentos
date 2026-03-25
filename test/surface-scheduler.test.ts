import assert from "node:assert/strict";
import test from "node:test";

import { SurfaceScheduler, type SurfaceLeaseHandle } from "../src/runtime/surface-scheduler.js";

function request(overrides: Partial<Parameters<SurfaceScheduler["acquire"]>[0]> = {}) {
  return {
    surfaceKey: "desktop-global" as const,
    holderId: "holder",
    holderKind: "task_step" as const,
    priority: "task" as const,
    waitPolicy: "block" as const,
    reason: "test",
    ...overrides
  };
}

test("SurfaceScheduler grants queued leases by priority before FIFO", async () => {
  const scheduler = new SurfaceScheduler();
  const first = await scheduler.acquire(request({ holderId: "first" }));
  assert.ok(first);

  let watchGranted: SurfaceLeaseHandle | null = null;
  const watchPromise = scheduler.acquire(
    request({
      holderId: "watch",
      holderKind: "watch_scan",
      priority: "watch"
    })
  ).then((handle) => {
    watchGranted = handle;
    return handle;
  });

  const probePromise = scheduler.acquire(
    request({
      holderId: "probe",
      holderKind: "state_probe",
      priority: "probe"
    })
  );

  await scheduler.release(first!);
  const probe = await probePromise;
  assert.ok(probe);
  assert.equal(probe?.holderId, "probe");
  assert.equal(watchGranted, null);

  await scheduler.release(probe!);
  const watch = await watchPromise;
  assert.ok(watch);
  assert.equal(watch?.holderId, "watch");
});

test("SurfaceScheduler skips watch scans immediately when the surface is busy", async () => {
  const scheduler = new SurfaceScheduler();
  const first = await scheduler.acquire(request({ holderId: "first" }));
  assert.ok(first);

  const skipped = await scheduler.acquire(
    request({
      holderId: "watch",
      holderKind: "watch_scan",
      priority: "watch",
      waitPolicy: "skip_if_busy"
    })
  );

  assert.equal(skipped, null);
});

test("SurfaceScheduler times out probe requests instead of waiting forever", async () => {
  const scheduler = new SurfaceScheduler();
  const first = await scheduler.acquire(request({ holderId: "first" }));
  assert.ok(first);

  const started = Date.now();
  const timedOut = await scheduler.acquire(
    request({
      holderId: "probe",
      holderKind: "state_probe",
      priority: "probe",
      waitPolicy: "timeout",
      timeoutMs: 30
    })
  );

  assert.equal(timedOut, null);
  assert.ok(Date.now() - started >= 20);
});
