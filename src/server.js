import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";
import { resolveConfig } from "./config.js";
import { createControlPlane } from "./runtime/control-plane.js";
import { clearDaemonState, writeDaemonState } from "./daemon-state.js";
const STATIC_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml"
};
function json(res, statusCode, payload) {
    res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
}
async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    if (!chunks.length) {
        return {};
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function serveStatic(publicDir, req, res) {
    const url = new URL(req.url, "http://localhost");
    const target = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.join(publicDir, target);
    try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) {
            json(res, 404, { error: "Not found" });
            return;
        }
        const extension = path.extname(filePath);
        res.writeHead(200, {
            "content-type": STATIC_CONTENT_TYPES[extension] ?? "application/octet-stream"
        });
        res.end(await fs.readFile(filePath));
    }
    catch {
        json(res, 404, { error: "Not found" });
    }
}
export async function createServer(overrides = {}) {
    const config = resolveConfig(overrides);
    const controlPlane = createControlPlane(config);
    const publicDir = path.join(process.cwd(), "public");
    let startedAt = null;
    let activePort = config.port;
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, "http://localhost");
        if (req.method === "GET" && url.pathname === "/health") {
            json(res, 200, {
                ok: true,
                platform: process.platform,
                browserExecutable: config.browserExecutable ?? null,
                modelConfigured: controlPlane.modelClient.isConfigured()
            });
            return;
        }
        if (req.method === "GET" && url.pathname === "/daemon/status") {
            json(res, 200, {
                daemon: {
                    running: true,
                    pid: process.pid,
                    port: activePort,
                    startedAt,
                    dataDir: config.dataDir,
                    connectorCount: controlPlane.listConnectors().length,
                    watchCount: controlPlane.listWatchRules().length,
                    enabledWatchCount: controlPlane.listWatchRules().filter((rule) => rule.enabled).length
                }
            });
            return;
        }
        if (req.method === "GET" && url.pathname === "/tasks") {
            json(res, 200, { tasks: controlPlane.listTasks(Number(url.searchParams.get("limit") ?? 50)) });
            return;
        }
        if (req.method === "POST" && url.pathname === "/tasks") {
            const task = await controlPlane.createTask(await readJsonBody(req));
            json(res, 202, { task });
            return;
        }
        if (req.method === "POST" && url.pathname === "/tasks/preview") {
            const preview = await controlPlane.previewTask(await readJsonBody(req));
            json(res, 200, { preview });
            return;
        }
        if (req.method === "POST" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/control")) {
            const taskId = url.pathname.split("/")[2];
            const body = await readJsonBody(req);
            if (!body.action) {
                json(res, 400, { error: "action is required" });
                return;
            }
            try {
                const task = controlPlane.controlTask(taskId, body.action, {
                    source: body.source ?? "user",
                    reason: body.reason ?? null,
                    note: body.note ?? null
                });
                json(res, 200, { task });
            }
            catch (error) {
                json(res, 400, { error: error.message });
            }
            return;
        }
        if (req.method === "POST" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/teach-steps")) {
            const taskId = url.pathname.split("/")[2];
            const body = await readJsonBody(req);
            try {
                const task = controlPlane.recordTaskTeachStep(taskId, body.step, {
                    source: body.source ?? "user"
                });
                json(res, 200, { task });
            }
            catch (error) {
                json(res, 400, { error: error.message });
            }
            return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/tasks/")) {
            const taskId = url.pathname.split("/")[2];
            const task = controlPlane.getTask(taskId);
            if (!task) {
                json(res, 404, { error: "Task not found" });
                return;
            }
            json(res, 200, { task });
            return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/traces/")) {
            const traceId = url.pathname.split("/")[2];
            const trace = controlPlane.getTrace(traceId);
            if (!trace) {
                json(res, 404, { error: "Trace not found" });
                return;
            }
            json(res, 200, { trace });
            return;
        }
        if (req.method === "GET" && url.pathname === "/events") {
            json(res, 200, { events: controlPlane.listEvents(Number(url.searchParams.get("limit") ?? 50)) });
            return;
        }
        if (req.method === "POST" && url.pathname === "/events") {
            const result = await controlPlane.ingestEvent(await readJsonBody(req));
            json(res, 202, result);
            return;
        }
        if (req.method === "POST" && url.pathname === "/policy/evaluate") {
            json(res, 200, { evaluation: controlPlane.evaluatePolicy(await readJsonBody(req)) });
            return;
        }
        if (req.method === "GET" && url.pathname === "/connectors") {
            json(res, 200, { connectors: controlPlane.listConnectors(), livePacks: controlPlane.listLivePacks() });
            return;
        }
        if (req.method === "GET" && url.pathname === "/watches") {
            json(res, 200, { watches: controlPlane.listWatchRules() });
            return;
        }
        if (req.method === "POST" && url.pathname === "/watches/from-task") {
            try {
                const body = await readJsonBody(req);
                if (!body.taskId) {
                    json(res, 400, { error: "taskId is required" });
                    return;
                }
                const watch = controlPlane.saveTaskAsWatchRule(body.taskId, body);
                json(res, 200, { watch });
            }
            catch (error) {
                json(res, 400, { error: error.message });
            }
            return;
        }
        if (req.method === "POST" && url.pathname === "/watches") {
            try {
                const watch = controlPlane.createWatchRule(await readJsonBody(req));
                json(res, 201, { watch });
            }
            catch (error) {
                json(res, 400, { error: error.message });
            }
            return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/watches/")) {
            const watchRuleId = url.pathname.split("/")[2];
            const watch = controlPlane.getWatchRule(watchRuleId);
            if (!watch) {
                json(res, 404, { error: "Watch rule not found" });
                return;
            }
            json(res, 200, { watch });
            return;
        }
        if (req.method === "POST" && url.pathname.startsWith("/watches/") && url.pathname.endsWith("/enable")) {
            const watchRuleId = url.pathname.split("/")[2];
            try {
                const watch = controlPlane.enableWatchRule(watchRuleId);
                json(res, 200, { watch });
            }
            catch (error) {
                json(res, 404, { error: error.message });
            }
            return;
        }
        if (req.method === "POST" && url.pathname.startsWith("/watches/") && url.pathname.endsWith("/disable")) {
            const watchRuleId = url.pathname.split("/")[2];
            try {
                const watch = controlPlane.disableWatchRule(watchRuleId);
                json(res, 200, { watch });
            }
            catch (error) {
                json(res, 404, { error: error.message });
            }
            return;
        }
        if (req.method === "DELETE" && url.pathname.startsWith("/watches/")) {
            const watchRuleId = url.pathname.split("/")[2];
            try {
                controlPlane.deleteWatchRule(watchRuleId);
                json(res, 200, { ok: true });
            }
            catch (error) {
                json(res, 404, { error: error.message });
            }
            return;
        }
        if (req.method === "GET" && url.pathname === "/skills") {
            json(res, 200, { skills: controlPlane.listSkills() });
            return;
        }
        if (req.method === "POST" && url.pathname === "/skills/from-task") {
            const body = await readJsonBody(req);
            if (!body.taskId || !body.name) {
                json(res, 400, { error: "taskId and name are required" });
                return;
            }
            const skill = controlPlane.saveTaskAsSkill(body.taskId, body.name);
            json(res, 200, { skill });
            return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/skills/")) {
            const name = decodeURIComponent(url.pathname.split("/")[2] ?? "");
            const skill = controlPlane.getSkill(name);
            if (!skill) {
                json(res, 404, { error: "Skill not found" });
                return;
            }
            json(res, 200, { skill });
            return;
        }
        if (req.method === "PUT" && url.pathname.startsWith("/skills/")) {
            const name = decodeURIComponent(url.pathname.split("/")[2] ?? "");
            const body = await readJsonBody(req);
            const skill = controlPlane.putSkill({ ...body, name });
            json(res, 200, { skill });
            return;
        }
        if (req.method === "GET" && url.pathname === "/workspace-profiles") {
            json(res, 200, { profiles: controlPlane.listWorkspaceProfiles() });
            return;
        }
        if (req.method === "PUT" && url.pathname.startsWith("/workspace-profiles/")) {
            const name = decodeURIComponent(url.pathname.split("/")[2] ?? "");
            const body = await readJsonBody(req);
            const profile = await controlPlane.prepareWorkspaceProfile(name, body.metadata ?? {});
            json(res, 200, { profile });
            return;
        }
        if (req.method === "GET" && url.pathname === "/vault/secrets") {
            json(res, 200, { secrets: controlPlane.listVaultSecrets(url.searchParams.get("scope") ?? "default") });
            return;
        }
        if (req.method === "PUT" && url.pathname.startsWith("/vault/secrets/")) {
            const secretKey = decodeURIComponent(url.pathname.split("/")[3] ?? "");
            const body = await readJsonBody(req);
            const secret = await controlPlane.putVaultSecret({
                scope: body.scope ?? "default",
                secretKey,
                value: body.value ?? "",
                metadata: body.metadata ?? {}
            });
            json(res, 200, { secret });
            return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/vault/secrets/")) {
            const secretKey = decodeURIComponent(url.pathname.split("/")[3] ?? "");
            const scope = url.searchParams.get("scope") ?? "default";
            const secret = await controlPlane.getVaultSecret(scope, secretKey);
            if (!secret) {
                json(res, 404, { error: "Secret not found" });
                return;
            }
            json(res, 200, { secret });
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
            return new Promise((resolve, reject) => {
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
            await new Promise((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
            await clearDaemonState(config.daemonDir);
            await controlPlane.shutdown();
        }
    };
}
