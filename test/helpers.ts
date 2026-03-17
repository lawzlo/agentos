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

export async function startSlackFixtureServer({
  threadTitle = "Acme renewal",
  unreadAriaLabel = null,
  messages = ["Customer: Can you share pricing for the renewal?"]
}: {
  threadTitle?: string;
  unreadAriaLabel?: string | null;
  messages?: string[];
} = {}) {
  const state = {
    threadId: "thread-acme",
    threadTitle,
    unread: true,
    messages: [...messages],
    sentReplies: [] as Array<{ message: string; createdAt: string }>
  };

  const renderPage = (selectedThread = false) => {
    const selected = selectedThread ? state.threadId : "";
    const items = `
      <li>
        <a
          id="thread-link"
          href="/slack?thread=${encodeURIComponent(state.threadId)}"
          aria-label="${unreadAriaLabel ?? `Unread thread: ${state.threadTitle}`}"
        >${state.threadTitle}</a>
      </li>
    `;
    const threadView = selectedThread
      ? `
        <section id="thread-panel">
          <h2>Conversation: ${state.threadTitle}</h2>
          <div id="thread-messages">
            ${state.messages.map((message) => `<p class="message-line">${message}</p>`).join("")}
          </div>
          <form method="POST" action="/slack/send?thread=${encodeURIComponent(state.threadId)}">
            <label for="reply-box">Message</label>
            <textarea id="reply-box" name="message" placeholder="Message ${state.threadTitle}"></textarea>
            <button id="send-reply" type="submit" aria-label="Send reply">Send</button>
          </form>
          <p id="send-status">${
            state.sentReplies.at(-1)?.message ? `Last sent: ${state.sentReplies.at(-1)?.message}` : "No reply sent yet."
          }</p>
        </section>
      `
      : '<section id="thread-panel"><p>Select a thread to view messages.</p></section>';

    return `<!doctype html>
      <html>
        <body>
          <main>
            <h1>Slack Test Workspace</h1>
            <aside>
              <h2>Unread threads</h2>
              <ul id="slack-sidebar">${items}</ul>
            </aside>
            <section>
              <p id="slack-view-state">Selected: ${selected || "none"}</p>
              ${threadView}
            </section>
          </main>
        </body>
      </html>`;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/slack") {
      const selected = url.searchParams.get("thread") === state.threadId;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderPage(selected));
      return;
    }

    if (req.method === "POST" && url.pathname === "/slack/send") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const message = String(body.get("message") ?? "").trim();
      if (message) {
        state.sentReplies.push({ message, createdAt: new Date().toISOString() });
        state.messages.push(`AgentOS: ${message}`);
        state.unread = false;
      }
      res.writeHead(303, {
        location: `/slack?thread=${encodeURIComponent(state.threadId)}`
      });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          threadId: state.threadId,
          threadTitle: state.threadTitle,
          unread: state.unread,
          messages: state.messages,
          sentReplies: state.sentReplies
        })
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    async getState() {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/state`);
      return response.json();
    },
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
