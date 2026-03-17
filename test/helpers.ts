import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { createServer as createAgentServer } from "../src/server.js";

export async function createTempDir(prefix = "agentos-test-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function startFixtureServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <html>
          <body>
            <main>
              <h1>AgentOS Demo</h1>
              <form id="demo-form">
                <label for="name">Name</label>
                <input id="name" name="name" />
                <button id="submit" type="submit">Submit</button>
              </form>
              <a id="more-info" href="/next">More information</a>
              <p id="status">Waiting</p>
              <script>
                document.getElementById("demo-form").addEventListener("submit", (event) => {
                  event.preventDefault();
                  const value = document.getElementById("name").value;
                  document.getElementById("status").textContent = "Submitted: " + value;
                });
              </script>
            </main>
          </body>
        </html>`);
      return;
    }

    if (req.url === "/next") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <html>
          <body>
            <main>
              <h1>Next Page</h1>
              <p>You navigated successfully.</p>
            </main>
          </body>
        </html>`);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

export async function startAgentServer({ dataDir, ...overrides }) {
  const app = await createAgentServer({
    port: 0,
    dataDir,
    headless: true,
    ...overrides
  });
  const port = await app.listen();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    app,
    async close() {
      await app.close();
    }
  };
}

export async function waitForTask(baseUrl, taskId, matcher, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${baseUrl}/tasks/${taskId}`);
    const payload = await response.json();
    if (matcher(payload.task)) {
      return payload.task;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for task ${taskId}`);
}

export async function startModelServer(decide) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/chat/completions") {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const content = JSON.stringify(await decide(body));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });

  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
