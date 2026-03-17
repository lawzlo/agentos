import { json } from "../http-utils.js";

export async function handleSystemRoutes({
  req,
  res,
  url,
  controlPlane,
  config,
  activePort,
  startedAt
}: Record<string, any>) {
  const daemon = {
    pid: process.pid,
    port: activePort,
    startedAt,
    dataDir: config.dataDir
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
    json(res, 200, {
      daemon: {
        running: true,
        ...daemon,
        connectorCount: controlPlane.listConnectors().length,
        watchCount: watches.length,
        enabledWatchCount: watches.filter((rule: Record<string, any>) => rule.enabled).length
      }
    });
    return true;
  }

  return false;
}
