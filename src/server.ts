import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocketServer } from "ws";

import { resolveConfig } from "./config.js";
import { createControlPlane } from "./runtime/control-plane.js";
import { clearDaemonState, writeDaemonState } from "./daemon-state.js";
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
    listen() {
      return new Promise<number>((resolve, reject) => {
        server.listen(config.port, () => {
          const address = server.address();
          void controlPlane
            .start()
            .then(async () => {
              activePort = typeof address === "object" && address ? address.port : config.port;
              startedAt = new Date().toISOString();
              await writeDaemonState(config.daemonDir, {
                pid: process.pid,
                port: activePort,
                startedAt,
                dataDir: config.dataDir,
                platform: process.platform,
                baseUrl: `http://127.0.0.1:${activePort}`
              });
              resolve(activePort);
            })
            .catch(reject);
        });
      });
    },
    async close() {
      controlPlane.eventBus.off("broadcast", broadcast);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await clearDaemonState(config.daemonDir);
      await controlPlane.shutdown();
    }
  };
}
