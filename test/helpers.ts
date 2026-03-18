import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { createServer as createAgentServer } from "../src/server.js";

const DEFAULT_TASK_WAIT_TIMEOUT_MS = Number.parseInt(process.env.AGENTOS_WAIT_TASK_TIMEOUT_MS ?? "", 10) || 60000;
const TASK_WAIT_INTERVAL_MS = 250;

async function closeHttpServer(server: http.Server) {
  const closePromise = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await closePromise;
}

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
      await closeHttpServer(server);
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
      await closeHttpServer(server);
    }
  };
}

export async function startMailFixtureServer({
  threadTitle = "Project update",
  unreadAriaLabel = null,
  messages = ["Customer: Can you send the latest project update?"]
}: {
  threadTitle?: string;
  unreadAriaLabel?: string | null;
  messages?: string[];
} = {}) {
  const state = {
    threadId: "mail-thread-1",
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
          id="mail-thread-link"
          href="/mail?thread=${encodeURIComponent(state.threadId)}"
          aria-label="${unreadAriaLabel ?? `Unread email: ${state.threadTitle}`}"
        >${state.threadTitle}</a>
      </li>
    `;
    const threadView = selectedThread
      ? `
        <section id="mail-thread-panel">
          <h2>Email: ${state.threadTitle}</h2>
          <div id="mail-thread-messages">
            ${state.messages.map((message) => `<p class="message-line">${message}</p>`).join("")}
          </div>
          <form method="POST" action="/mail/send?thread=${encodeURIComponent(state.threadId)}">
            <label for="reply-box">Reply</label>
            <textarea id="reply-box" name="message" placeholder="Reply to ${state.threadTitle}"></textarea>
            <button id="send-reply" type="submit" aria-label="Send reply">Send reply</button>
          </form>
          <p id="send-status">${
            state.sentReplies.at(-1)?.message ? `Last sent: ${state.sentReplies.at(-1)?.message}` : "No reply sent yet."
          }</p>
        </section>
      `
      : '<section id="mail-thread-panel"><p>Select an email to view its contents.</p></section>';

    return `<!doctype html>
      <html>
        <body>
          <main>
            <h1>Inbox</h1>
            <aside>
              <h2>Unread mail</h2>
              <ul id="mail-sidebar">${items}</ul>
            </aside>
            <section>
              <p id="mail-view-state">Selected: ${selected || "none"}</p>
              ${threadView}
            </section>
          </main>
        </body>
      </html>`;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/mail") {
      const selected = url.searchParams.get("thread") === state.threadId;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderPage(selected));
      return;
    }

    if (req.method === "POST" && url.pathname === "/mail/send") {
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
        location: `/mail?thread=${encodeURIComponent(state.threadId)}`
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
      await closeHttpServer(server);
    }
  };
}

export async function startBossFixtureServer({
  candidateName = "李雷",
  candidateRole = "产品经理",
  candidateLocation = "上海",
  candidateExperience = "5年经验",
  previewMessage = "候选人: 方便聊下这个岗位吗？"
}: {
  candidateName?: string;
  candidateRole?: string;
  candidateLocation?: string;
  candidateExperience?: string;
  previewMessage?: string;
} = {}) {
  const state = {
    candidateId: "candidate-li-lei",
    candidateName,
    candidateRole,
    candidateLocation,
    candidateExperience,
    previewMessage,
    viewedCandidateId: "",
    viewCount: 0,
    messages: [previewMessage],
    sentReplies: [] as Array<{ message: string; createdAt: string }>
  };

  const latestIncomingMessage = () =>
    state.messages
      .filter((message) => String(message).startsWith("候选人"))
      .at(-1) ?? state.messages[0] ?? "";

  const renderListPage = () => `<!doctype html>
    <html>
      <body>
        <main>
          <h1>BOSS直聘</h1>
          <section>
            <h2>新候选人</h2>
            <ul id="boss-candidate-list">
              <li>
                <a
                  id="boss-candidate-link"
                  href="/boss/candidate?id=${encodeURIComponent(state.candidateId)}"
                  aria-label="新候选人: ${state.candidateName} ${state.candidateRole}"
                >新候选人: ${state.candidateName} · ${state.candidateRole}</a>
                <p class="candidate-meta">${state.candidateExperience} · ${state.candidateLocation}</p>
                <p class="candidate-preview">${latestIncomingMessage()}</p>
              </li>
            </ul>
          </section>
        </main>
      </body>
    </html>`;

  const renderCandidatePage = () => `<!doctype html>
    <html>
      <body>
        <main>
          <h1>BOSS直聘</h1>
          <section id="candidate-detail">
            <h2>${state.candidateName}</h2>
            <p>${state.candidateRole}</p>
            <p>${state.candidateExperience}</p>
            <p>${state.candidateLocation}</p>
            <div id="boss-thread-messages">
              ${state.messages.map((message) => `<p class="message-line">${message}</p>`).join("")}
            </div>
            <form method="POST" action="/boss/send?id=${encodeURIComponent(state.candidateId)}">
              <label for="boss-reply-box">发送消息给${state.candidateName}</label>
              <textarea
                id="boss-reply-box"
                name="message"
                placeholder="发送消息给${state.candidateName}"
              ></textarea>
              <button id="boss-send" type="submit" aria-label="发送消息">发送</button>
            </form>
            <p id="boss-send-status">${
              state.sentReplies.at(-1)?.message ? `最近发送: ${state.sentReplies.at(-1)?.message}` : "暂无已发送消息"
            }</p>
            <button id="boss-chat" type="button">在线沟通</button>
            <button id="boss-resume" type="button">查看简历</button>
          </section>
        </main>
      </body>
    </html>`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/boss") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderListPage());
      return;
    }

    if (req.method === "GET" && url.pathname === "/boss/candidate") {
      if (url.searchParams.get("id") !== state.candidateId) {
        res.writeHead(404);
        res.end();
        return;
      }

      state.viewedCandidateId = state.candidateId;
      state.viewCount += 1;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderCandidatePage());
      return;
    }

    if (req.method === "POST" && url.pathname === "/boss/send") {
      if (url.searchParams.get("id") !== state.candidateId) {
        res.writeHead(404);
        res.end();
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const message = String(body.get("message") ?? "").trim();
      if (message) {
        state.sentReplies.push({ message, createdAt: new Date().toISOString() });
        state.messages.push(`招聘方: ${message}`);
      }
      res.writeHead(303, {
        location: `/boss/candidate?id=${encodeURIComponent(state.candidateId)}`
      });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(state));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/incoming-message") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const message = String(body.message ?? "").trim();
      if (message) {
        state.messages.push(message);
      }
      res.writeHead(204);
      res.end();
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
    async pushIncomingMessage(message: string) {
      await fetch(`http://127.0.0.1:${address.port}/api/incoming-message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message })
      });
    },
    async close() {
      await closeHttpServer(server);
    }
  };
}

export async function startDocsFilesFixtureServer() {
  const state = {
    uploadedFileName: "",
    uploadedFileContent: "",
    savedDocument: "Initial draft",
    googleDriveUploadedFileName: "",
    googleDriveUploadedFileContent: "",
    googleDocsDocument: "Google Docs draft",
    feishuDocsDocument: "飞书初稿"
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/docs") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <html>
          <body>
            <main>
              <h1>Docs and Files Workspace</h1>
              <a id="download-link" href="/files/report.txt" download>Download report</a>

              <section>
                <label for="upload-input">Upload file</label>
                <input id="upload-input" type="file" aria-label="Upload file" />
                <p id="upload-status">Uploaded: ${state.uploadedFileName || "none"}</p>
              </section>

              <section>
                <label for="doc-editor">Document editor</label>
                <textarea id="doc-editor" placeholder="Document editor">${state.savedDocument}</textarea>
                <button id="save-doc" type="button">Save document</button>
                <p id="doc-status">Saved: ${state.savedDocument}</p>
              </section>

              <script>
                const uploadInput = document.getElementById("upload-input");
                const uploadStatus = document.getElementById("upload-status");
                const docEditor = document.getElementById("doc-editor");
                const docStatus = document.getElementById("doc-status");
                const saveButton = document.getElementById("save-doc");

                uploadInput.addEventListener("change", async () => {
                  const file = uploadInput.files[0];
                  if (!file) {
                    uploadStatus.textContent = "Uploaded: none";
                    return;
                  }
                  const content = await file.text();
                  await fetch("/api/upload", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ name: file.name, content })
                  });
                  uploadStatus.textContent = "Uploaded: " + file.name;
                });

                saveButton.addEventListener("click", async () => {
                  await fetch("/api/document", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ text: docEditor.value })
                  });
                  docStatus.textContent = "Saved: " + docEditor.value;
                });
              </script>
            </main>
          </body>
        </html>`);
      return;
    }

    if (req.method === "GET" && url.pathname === "/google-drive") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <html>
          <body>
            <main>
              <h1>Google Drive</h1>
              <button id="drive-pending-item" type="button">Pending upload: Shared roadmap.pdf</button>
              <button id="drive-pending-download-item" type="button">Pending download: Shared report.txt</button>
              <a id="drive-download-link" href="/files/report.txt" download>Download shared file</a>
              <label for="drive-upload-input">Upload to Drive</label>
              <input id="drive-upload-input" type="file" aria-label="Upload to Drive" />
              <p id="drive-upload-status">Drive uploaded: ${state.googleDriveUploadedFileName || "none"}</p>
              <script>
                const uploadInput = document.getElementById("drive-upload-input");
                const uploadStatus = document.getElementById("drive-upload-status");
                uploadInput.addEventListener("change", async () => {
                  const file = uploadInput.files[0];
                  if (!file) {
                    uploadStatus.textContent = "Drive uploaded: none";
                    return;
                  }
                  const content = await file.text();
                  await fetch("/api/google-drive/upload", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ name: file.name, content })
                  });
                  uploadStatus.textContent = "Drive uploaded: " + file.name;
                });
              </script>
            </main>
          </body>
        </html>`);
      return;
    }

    if (req.method === "GET" && url.pathname === "/google-docs") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <html>
          <body>
            <main>
              <h1>Google Docs</h1>
              <button id="google-docs-pending-item" type="button">Needs update: Weekly brief</button>
              <label for="google-docs-editor">Google Docs editor</label>
              <textarea id="google-docs-editor" placeholder="Google Docs editor">${state.googleDocsDocument}</textarea>
              <button id="google-docs-save" type="button">Save Google Doc</button>
              <p id="google-docs-status">Saved in Google Docs: ${state.googleDocsDocument}</p>
              <script>
                const editor = document.getElementById("google-docs-editor");
                const status = document.getElementById("google-docs-status");
                document.getElementById("google-docs-save").addEventListener("click", async () => {
                  await fetch("/api/google-docs/save", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ text: editor.value })
                  });
                  status.textContent = "Saved in Google Docs: " + editor.value;
                });
              </script>
            </main>
          </body>
        </html>`);
      return;
    }

    if (req.method === "GET" && url.pathname === "/feishu-docs") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <html>
          <body>
            <main>
              <h1>Feishu Docs</h1>
              <button id="feishu-docs-pending-item" type="button">待处理文档: 项目周报</button>
              <label for="feishu-docs-editor">飞书文档编辑区</label>
              <textarea id="feishu-docs-editor" placeholder="飞书文档编辑区">${state.feishuDocsDocument}</textarea>
              <button id="feishu-docs-save" type="button">保存到飞书</button>
              <p id="feishu-docs-status">已保存到飞书: ${state.feishuDocsDocument}</p>
              <script>
                const editor = document.getElementById("feishu-docs-editor");
                const status = document.getElementById("feishu-docs-status");
                document.getElementById("feishu-docs-save").addEventListener("click", async () => {
                  await fetch("/api/feishu-docs/save", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ text: editor.value })
                  });
                  status.textContent = "已保存到飞书: " + editor.value;
                });
              </script>
            </main>
          </body>
        </html>`);
      return;
    }

    if (req.method === "GET" && url.pathname === "/files/report.txt") {
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'attachment; filename="report.txt"'
      });
      res.end("Quarterly report\nLine 2");
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/upload") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      state.uploadedFileName = String(body.name ?? "");
      state.uploadedFileContent = String(body.content ?? "");
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/google-drive/upload") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      state.googleDriveUploadedFileName = String(body.name ?? "");
      state.googleDriveUploadedFileContent = String(body.content ?? "");
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/document") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      state.savedDocument = String(body.text ?? "");
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/google-docs/save") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      state.googleDocsDocument = String(body.text ?? "");
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/feishu-docs/save") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      state.feishuDocsDocument = String(body.text ?? "");
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(state));
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
      await closeHttpServer(server);
    }
  };
}

export async function startAgentServer({ dataDir, ...overrides }) {
  const app = await createAgentServer({
    port: 0,
    dataDir,
    headless: true,
    ...(overrides.model
      ? {}
      : {
          model: {
            provider: "openai_compatible",
            baseUrl: "",
            apiKey: "",
            name: "",
            timeoutMs: 5000
          }
        }),
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

export async function waitForTask(baseUrl, taskId, matcher, timeoutMs = DEFAULT_TASK_WAIT_TIMEOUT_MS) {
  const started = Date.now();
  let lastTask = null;

  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${baseUrl}/tasks/${taskId}`);
    const payload = await response.json();
    if (!payload || !payload.task) {
      await new Promise((resolve) => setTimeout(resolve, TASK_WAIT_INTERVAL_MS));
      continue;
    }
    lastTask = payload.task;
    if (matcher(payload.task)) {
      return payload.task;
    }
    await new Promise((resolve) => setTimeout(resolve, TASK_WAIT_INTERVAL_MS));
  }

  throw new Error(
    `Timed out waiting for task ${taskId} after ${timeoutMs}ms (lastStatus=${lastTask?.status ?? "unknown"})`
  );
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
      await closeHttpServer(server);
    }
  };
}
