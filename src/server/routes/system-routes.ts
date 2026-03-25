import { json, readJsonBody } from "../http-utils.js";
import { getDaemonInstallStatus } from "../../daemon-autostart.js";
import { readDaemonState } from "../../daemon-state.js";
import { detectInstallSource } from "../../install-source.js";
import { collectSurfaceState, type SurfaceStateRequest } from "../../../bin/commands/state-command.js";
import type { ApiRouteContext } from "../types.js";
import type { DaemonLifecycle, DaemonStatus, DoctorReport } from "../../types/system.js";

function hasStartupRecoveryWork(lifecycle: DaemonLifecycle | null | undefined): boolean {
  if (!lifecycle) {
    return false;
  }

  return (
    lifecycle.startupRecovery.requeuedTaskCount > 0 ||
    lifecycle.startupRecovery.interruptedTaskCount > 0 ||
    lifecycle.startupRecovery.reconciledRunningJobCount > 0
  );
}

function daemonLifecycleWarnings(lifecycle: DaemonLifecycle | null | undefined): string[] {
  if (!lifecycle) {
    return [];
  }

  if (lifecycle.previousExit.kind === "crash" || lifecycle.previousExit.kind === "stale_runtime") {
    return [
      lifecycle.previousExit.reason
        ? `The previous daemon session exited unexpectedly: ${lifecycle.previousExit.reason}`
        : "The previous daemon session exited unexpectedly."
    ];
  }

  return [];
}

function mergeDoctorLifecycle(
  doctor: DoctorReport,
  lifecycle: DaemonLifecycle | null
): DoctorReport {
  const warnings = Array.from(new Set([...doctor.warnings, ...daemonLifecycleWarnings(lifecycle)]));
  return {
    ...doctor,
    ok: doctor.ok && warnings.length === 0,
    warnings,
    lifecycle,
    startupRecovery: lifecycle?.startupRecovery ?? null
  };
}

export async function handleSystemRoutes({
  req,
  res,
  url,
  controlPlane,
  config,
  activePort,
  startedAt
}: ApiRouteContext): Promise<boolean> {
  const installSource = await detectInstallSource();
  const daemonState = await readDaemonState(config.daemonDir);
  const lifecycle = daemonState?.lifecycle ?? null;
  const daemon: DaemonStatus = {
    running: true,
    pid: process.pid,
    port: activePort,
    startedAt,
    dataDir: config.dataDir,
    installSource,
    license: controlPlane.getLicenseState(),
    lifecycle,
    startupRecovery: lifecycle?.startupRecovery ?? null
  };

  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, {
      ok: true,
      platform: process.platform,
      browserExecutable: config.browserExecutable ?? null,
      modelConfigured: controlPlane.modelClient.isConfigured()
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/doctor") {
    const doctor = mergeDoctorLifecycle(await controlPlane.doctor(), lifecycle);
    json(res, 200, {
      doctor: {
        ...doctor,
        daemon
      }
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/doctor/bundle") {
    const bundle = await controlPlane.createDoctorBundle(daemon);
    json(res, 200, {
      bundle
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/version") {
    json(res, 200, {
      version: controlPlane.getVersionInfo()
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/surfaces") {
    json(res, 200, {
      surfaces: controlPlane.surfaceCoordinator.listSnapshots()
    });
    return true;
  }

  if (req.method === "GET" && url.pathname.startsWith("/surfaces/")) {
    const surfaceKey = decodeURIComponent(url.pathname.slice("/surfaces/".length));
    const surface = controlPlane.surfaceCoordinator.getSnapshot(surfaceKey as never);
    if (!surface) {
      json(res, 404, { error: "Surface not found" });
      return true;
    }
    json(res, 200, { surface });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/surface/state") {
    const request = await readJsonBody<SurfaceStateRequest>(req);
    const result = await controlPlane.surfaceCoordinator.withProbeSurface(
      {
        surface: request.surface,
        workspaceKey: request.workspaceName,
        holderId: `state:${request.surface}:${request.packName ?? request.appName ?? request.workspaceName}`,
        reason: `state probe ${request.packName ?? request.appName ?? request.surface}`,
        timeoutMs: 3000
      },
      async () =>
        collectSurfaceState(request, {
          browserAdapter: request.surface === "browser"
            ? (controlPlane.surfaceRegistry.get("browser") as never)
            : undefined
        })
    );

    if (!result) {
      const surfaceKey = controlPlane.surfaceCoordinator.resolveSurfaceKey(request.surface, request.workspaceName);
      json(res, 200, {
        busy: true,
        surfaceKey,
        lease: controlPlane.surfaceCoordinator.getSnapshot(surfaceKey)
      });
      return true;
    }

    const surfaceKey = controlPlane.surfaceCoordinator.resolveSurfaceKey(request.surface, request.workspaceName);
    json(res, 200, {
      report: result,
      surfaceKey,
      lease: controlPlane.surfaceCoordinator.getSnapshot(surfaceKey)
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/daemon/status") {
    const watches = controlPlane.listWatchRules();
    const drafts = controlPlane.listDrafts(200);
    const proposals = controlPlane.listProposals(200);
    const jobs = controlPlane.listAutomationJobs(200);
    const livePacks = await controlPlane.listLivePackInfo();
    const install = await getDaemonInstallStatus();
    json(res, 200, {
      daemon: {
        ...daemon,
        connectorCount: controlPlane.listConnectors().length,
        livePackCount: livePacks.length,
        readyLivePackCount: livePacks.filter((pack) => pack.ready !== false).length,
        blockedLivePackCount: livePacks.filter((pack) => pack.ready === false).length,
        watchCount: watches.length,
        enabledWatchCount: watches.filter((rule) => rule.enabled).length,
        degradedWatchCount: watches.filter((rule) => ["degraded", "backoff"].includes(rule.status)).length,
        pendingDraftCount: drafts.filter((draft) => draft.status === "pending").length,
        pendingProposalCount: proposals.filter((proposal) => proposal.status === "pending").length,
        jobCount: jobs.length,
        enabledJobCount: jobs.filter((job) => job.enabled).length,
        degradedJobCount: jobs.filter((job) => job.status === "degraded").length,
        nextJobRunAt:
          jobs
            .filter((job) => job.enabled && typeof job.nextRunAt === "string")
            .map((job) => String(job.nextRunAt))
            .sort()[0] ?? null,
        recentErrors: [
          ...watches
            .filter((rule) => typeof rule.lastError === "string" && rule.lastError.trim())
            .map((rule) => ({
              id: rule.id,
              status: rule.status,
              message: String(rule.lastError ?? ""),
              updatedAt: rule.updatedAt
            })),
          ...jobs
            .filter((job) => typeof job.lastError === "string" && job.lastError.trim())
            .map((job) => ({
              id: job.id,
              status: job.status,
              message: String(job.lastError ?? ""),
              updatedAt: job.updatedAt
            }))
        ]
          .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
          .slice(0, 5),
        install,
        lifecycle,
        startupRecovery: lifecycle?.startupRecovery ?? null,
        recoveryAttentionRequired:
          hasStartupRecoveryWork(lifecycle) ||
          lifecycle?.previousExit.kind === "crash" ||
          lifecycle?.previousExit.kind === "stale_runtime"
      }
    });
    return true;
  }

  return false;
}
