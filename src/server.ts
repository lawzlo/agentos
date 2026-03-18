import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocketServer } from "ws";

import { resolveConfig } from "./config.js";
import { createControlPlane } from "./runtime/control-plane.js";
import {
  appendDaemonMarker,
  buildDaemonLifecycle,
  clearDaemonState,
  inferDaemonPreviousExit,
  readDaemonRuntime,
  writeDaemonState
} from "./daemon-state.js";
import { dispatchApiRoute } from "./server/route-dispatcher.js";
import { serveStatic } from "./server/http-utils.js";

export async function createServer(overrides = {}) {
  const config = resolveConfig(overrides);
  const controlPlane = createControlPlane(config);
  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
  let startedAt = null;
  let activePort = config.port;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const handled = await dispatchApiRoute({
      req,
      res,
      url,
      controlPlane,
      config,
      activePort,
      startedAt
    });
    if (handled) {
      return;
    }

    await serveStatic(publicDir, req, res);
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: "bootstrap", payload: { tasks: controlPlane.listTasks(20) } }));
      wss.emit("connection", ws, req);
    });
  });

  const broadcast = ({ type, payload }) => {
    const message = JSON.stringify({ type, payload });
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(message);
      }
    }
  };

  controlPlane.eventBus.on("broadcast", broadcast);

  return {
    config,
    controlPlane,
    server,
    async listen() {
      const runtime = await readDaemonRuntime(config.daemonDir);
      if (runtime.running) {
        const runningPort = runtime.state?.port ? ` on port ${runtime.state.port}` : "";
        await appendDaemonMarker(config.daemonDir, "daemon.start_blocked", {
          pid: process.pid,
          existingPid: runtime.state?.pid ?? null,
          reason: "already_running"
        }).catch(() => {});
        throw new Error(`AgentOS daemon is already running with pid ${runtime.state?.pid}${runningPort}.`);
      }

      const previousExit = await inferDaemonPreviousExit(config.daemonDir, {
        staleState: runtime.staleState ?? null
      });

      return new Promise<number>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("error", onError);
          reject(error);
        };

        server.once("error", onError);
        server.listen(config.port, () => {
          server.off("error", onError);
          const address = server.address();
          void controlPlane
            .start()
            .then(async (startupRecovery) => {
              activePort = typeof address === "object" && address ? address.port : config.port;
              startedAt = new Date().toISOString();
              const version = controlPlane.getVersionInfo();
              const lifecycle = buildDaemonLifecycle({
                previousExit,
                startupRecovery
              });
              await writeDaemonState(config.daemonDir, {
                pid: process.pid,
                port: activePort,
                startedAt,
                dataDir: config.dataDir,
                platform: process.platform,
                baseUrl: `http://127.0.0.1:${activePort}`,
                appVersion: version.appVersion,
                runtimeProtocolVersion: version.runtimeProtocolVersion,
                nativeProtocolVersion: version.nativeProtocolVersion,
                storeSchemaVersion: version.storeSchemaVersion,
                installLayoutVersion: version.installLayoutVersion,
                lifecycle,
                startupRecovery
              });
              await appendDaemonMarker(config.daemonDir, "daemon.started", {
                pid: process.pid,
                port: activePort,
                appVersion: version.appVersion,
                startReason: lifecycle.lastStartReason,
                previousExitKind: lifecycle.previousExit.kind,
                startupRecovery
              });
              resolve(activePort);
            })
            .catch(reject);
        });
      });
    },
    async close(reason = "shutdown_request") {
      controlPlane.eventBus.off("broadcast", broadcast);
      for (const client of wss.clients) {
        client.terminate();
      }
      const wssClose = new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      const serverClose = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await Promise.all([serverClose, wssClose]);
      await appendDaemonMarker(config.daemonDir, "daemon.stopped", {
        pid: process.pid,
        reason
      }).catch(() => {});
      await clearDaemonState(config.daemonDir);
      await controlPlane.shutdown();
    }
  };
}
