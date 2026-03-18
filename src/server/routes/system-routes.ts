import { json } from "../http-utils.js";
import { getDaemonInstallStatus } from "../../daemon-autostart.js";
import { detectInstallSource } from "../../install-source.js";
import type { ApiRouteContext } from "../types.js";
import type { DaemonStatus } from "../../types/system.js";

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
  const daemon: DaemonStatus = {
    running: true,
    pid: process.pid,
    port: activePort,
    startedAt,
    dataDir: config.dataDir,
    installSource
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
    json(res, 200, {
      doctor: {
        ...(await controlPlane.doctor()),
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

  if (req.method === "GET" && url.pathname === "/daemon/status") {
    const watches = controlPlane.listWatchRules();
    const drafts = controlPlane.listDrafts(200);
    const proposals = controlPlane.listProposals(200);
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
        recentErrors: watches
          .filter((rule) => typeof rule.lastError === "string" && rule.lastError.trim())
          .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
          .slice(0, 5)
          .map((rule) => ({
            id: rule.id,
            status: rule.status,
            message: String(rule.lastError ?? ""),
            updatedAt: rule.updatedAt
          })),
        install
      }
    });
    return true;
  }

  return false;
}
