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
        ...controlPlane.doctor(),
        daemon: {
          pid: process.pid,
          port: activePort,
          startedAt,
          dataDir: config.dataDir
        }
      }
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/daemon/status") {
    const watches = controlPlane.listWatchRules();
    json(res, 200, {
      daemon: {
        running: true,
        pid: process.pid,
        port: activePort,
        startedAt,
        dataDir: config.dataDir,
        connectorCount: controlPlane.listConnectors().length,
        watchCount: watches.length,
        enabledWatchCount: watches.filter((rule: Record<string, any>) => rule.enabled).length
      }
    });
    return true;
  }

  return false;
}
