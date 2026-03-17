import { createServer } from "./server.js";
const app = await createServer();
const port = await app.listen();
async function shutdown() {
    await app.close();
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(`AgentOS control plane listening on http://localhost:${port}`);
