import { appendDaemonMarker } from "./daemon-state.js";
import { resolveConfig } from "./config.js";
import { createServer } from "./server.js";

const config = resolveConfig();
const app = await createServer();
const port = await app.listen();

async function shutdown(signal: string) {
  await app.close(`signal:${signal}`);
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("uncaughtException", (error) => {
  void appendDaemonMarker(config.daemonDir, "daemon.crash", {
    type: "uncaughtException",
    message: error.message
  }).finally(() => {
    console.error(error);
    process.exit(1);
  });
});
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  void appendDaemonMarker(config.daemonDir, "daemon.crash", {
    type: "unhandledRejection",
    message
  }).finally(() => {
    console.error(reason);
    process.exit(1);
  });
});

console.log(`AgentOS control plane listening on http://localhost:${port}`);
