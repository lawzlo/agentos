import fs from "node:fs/promises";
import path from "node:path";

import { SurfaceAdapter } from "../src/runtime/adapters/surface-adapter.js";
import { createWorldState } from "../src/runtime/world-state.js";
import type { ArtifactStore } from "../src/runtime/artifact-store.js";
import type { ArtifactReference, StepVerification, TaskRecord, WorkspaceRecord } from "../src/types/runtime-schema.js";

type TestBrowserPageKind =
  | "demo_root"
  | "demo_next"
  | "slack_list"
  | "slack_thread"
  | "mail_thread"
  | "docs"
  | "google_drive"
  | "google_docs"
  | "feishu_docs"
  | "generic";

interface TestBrowserState {
  currentUrl: string | null;
  pageKind: TestBrowserPageKind;
  title: string;
  formValue: string;
  statusText: string;
  replyDraft: string;
  threadTitle: string;
  threadId: string;
  unread: boolean;
  sentReplies: string[];
  slackMessages: string[];
  navigationCount: number;
  lastCapturePath: string | null;
  uploadedFileName: string;
  googleDriveUploadedFileName: string;
  savedDocument: string;
  googleDocsDocument: string;
  feishuDocsDocument: string;
}

function defaultTestBrowserState(): TestBrowserState {
  return {
    currentUrl: null,
    pageKind: "generic",
    title: "Browser",
    formValue: "",
    statusText: "Waiting",
    replyDraft: "",
    threadTitle: "Project update",
    threadId: "thread-1",
    unread: true,
    sentReplies: [],
    slackMessages: [],
    navigationCount: 0,
    lastCapturePath: null,
    uploadedFileName: "",
    googleDriveUploadedFileName: "",
    savedDocument: "",
    googleDocsDocument: "",
    feishuDocsDocument: ""
  };
}

function testBrowserBounds(x: number, y: number) {
  return { x, y, width: 120, height: 24, centerX: x + 60, centerY: y + 12 };
}

export class TestBrowserSurface extends SurfaceAdapter {
  artifactStore: ArtifactStore;
  stateByWorkspace: Map<string, TestBrowserState>;

  constructor(artifactStore: ArtifactStore) {
    super("browser");
    this.artifactStore = artifactStore;
    this.stateByWorkspace = new Map();
  }

  #workspaceKey(workspace: WorkspaceRecord): string {
    return `${workspace.rootPath}::${workspace.profilePath}`;
  }

  #state(workspace: WorkspaceRecord): TestBrowserState {
    const key = this.#workspaceKey(workspace);
    const existing = this.stateByWorkspace.get(key);
    if (existing) {
      return existing;
    }
    const created = defaultTestBrowserState();
    this.stateByWorkspace.set(key, created);
    return created;
  }

  async #syncSlackState(state: TestBrowserState, baseUrl: string) {
    const response = await fetch(new URL("/api/state", baseUrl));
    const payload = await response.json();
    state.threadId = String(payload.threadId ?? "thread-1");
    state.threadTitle = String(payload.threadTitle ?? "Slack thread");
    state.replyDraft = String(payload.draftText ?? "");
    state.unread = Boolean(payload.unread);
    state.sentReplies = Array.isArray(payload.sentReplies)
      ? payload.sentReplies
          .map((entry: { message?: unknown } | null) => String(entry?.message ?? "").trim())
          .filter(Boolean)
      : [];
    state.slackMessages = Array.isArray(payload.messages)
      ? payload.messages.map((entry: unknown) => String(entry ?? "").trim()).filter(Boolean)
      : [];
  }

  async #applyUrl(state: TestBrowserState, url: string) {
    state.currentUrl = url;
    state.navigationCount += 1;
    const parsed = new URL(url);
    switch (parsed.pathname) {
      case "/next":
        state.pageKind = "demo_next";
        state.title = "Next Page";
        return;
      case "/mail":
        state.pageKind = "mail_thread";
        state.title = "Inbox";
        state.threadTitle = "Project update";
        return;
      case "/slack":
        await this.#syncSlackState(state, parsed.origin);
        state.pageKind = parsed.searchParams.get("thread") === state.threadId ? "slack_thread" : "slack_list";
        state.title = "Slack Test Workspace";
        return;
      case "/docs":
        state.pageKind = "docs";
        state.title = "Docs and Files Workspace";
        return;
      case "/google-drive":
        state.pageKind = "google_drive";
        state.title = "Google Drive";
        return;
      case "/google-docs":
        state.pageKind = "google_docs";
        state.title = "Google Docs";
        return;
      case "/feishu-docs":
        state.pageKind = "feishu_docs";
        state.title = "Feishu Docs";
        return;
      default:
        state.pageKind = "demo_root";
        state.title = "AgentOS Demo";
        state.formValue = "";
        state.statusText = "Waiting";
    }
  }

  #visibleText(state: TestBrowserState): string {
    switch (state.pageKind) {
      case "demo_next":
        return ["Next Page", "You navigated successfully."].join("\n");
      case "mail_thread":
        return [
          "Inbox",
          `Email: ${state.threadTitle}`,
          "Customer: Can you send the latest project update?",
          `Reply to ${state.threadTitle}`,
          state.replyDraft
        ]
          .filter(Boolean)
          .join("\n");
      case "slack_list":
        return [
          "Slack Test Workspace",
          state.unread ? `Unread thread: ${state.threadTitle}` : state.threadTitle,
          state.slackMessages.at(-1) ?? ""
        ]
          .filter(Boolean)
          .join("\n");
      case "slack_thread":
        return [
          "Slack Test Workspace",
          `Conversation: ${state.threadTitle}`,
          ...state.slackMessages,
          `Message ${state.threadTitle}`,
          state.replyDraft
        ]
          .filter(Boolean)
          .join("\n");
      case "docs":
        return [
          "Docs and Files Workspace",
          "Download report",
          "Upload file",
          `Uploaded: ${state.uploadedFileName || "none"}`,
          "Document editor",
          `Saved: ${state.savedDocument}`
        ].join("\n");
      case "google_drive":
        return [
          "Google Drive",
          "Pending upload: Shared roadmap.pdf",
          "Pending download: Shared report.txt",
          "Upload to Drive",
          "Download shared file",
          `Drive uploaded: ${state.googleDriveUploadedFileName || "none"}`
        ].join("\n");
      case "google_docs":
        return [
          "Google Docs",
          "Needs update: Weekly brief",
          "Google Docs editor",
          "Save Google Doc",
          `Saved in Google Docs: ${state.googleDocsDocument}`
        ].join("\n");
      case "feishu_docs":
        return [
          "Feishu Docs",
          "待处理文档: 项目周报",
          "飞书文档编辑区",
          "保存到飞书",
          `已保存到飞书: ${state.feishuDocsDocument}`
        ].join("\n");
      case "demo_root":
        return ["AgentOS Demo", "Name", "Submit", "More information", state.statusText].join("\n");
      default:
        return state.currentUrl ?? "Browser";
    }
  }

  #interactionCandidates(state: TestBrowserState) {
    switch (state.pageKind) {
      case "slack_list":
        return [
          {
            id: "slack-thread-link",
            surface: "browser",
            kind: "element",
            text: state.unread ? `Unread thread: ${state.threadTitle}` : state.threadTitle,
            role: "link",
            bounds: testBrowserBounds(160, 200),
            confidence: 0.95,
            sourceHints: { selector: "#thread-link" },
            isInteractive: true
          }
        ];
      case "slack_thread":
        return [
          {
            id: "slack-reply-box",
            surface: "browser",
            kind: "element",
            text: `Message ${state.threadTitle}`,
            role: "textbox",
            bounds: testBrowserBounds(160, 260),
            confidence: 0.95,
            sourceHints: { selector: "#reply-box" },
            isInteractive: true
          },
          {
            id: "slack-send-reply",
            surface: "browser",
            kind: "element",
            text: "Send reply",
            role: "button",
            bounds: testBrowserBounds(160, 320),
            confidence: 0.95,
            sourceHints: { selector: "#send-reply" },
            isInteractive: true
          }
        ];
      case "mail_thread":
        return [
          {
            id: "reply-box",
            surface: "browser",
            kind: "element",
            text: `Reply to ${state.threadTitle}`,
            role: "textbox",
            bounds: testBrowserBounds(160, 260),
            confidence: 0.9,
            sourceHints: { selector: "#reply-box" },
            isInteractive: true
          },
          {
            id: "send-reply",
            surface: "browser",
            kind: "element",
            text: "Send reply",
            role: "button",
            bounds: testBrowserBounds(160, 320),
            confidence: 0.9,
            sourceHints: { selector: "#send-reply" },
            isInteractive: true
          }
        ];
      case "docs":
        return [
          { id: "download-link", surface: "browser", kind: "element", text: "Download report", role: "link", bounds: testBrowserBounds(120, 160), confidence: 0.95, sourceHints: {}, isInteractive: true },
          { id: "upload-input", surface: "browser", kind: "element", text: "Upload file", role: "textbox", bounds: testBrowserBounds(120, 220), confidence: 0.95, sourceHints: {}, isInteractive: true },
          { id: "doc-editor", surface: "browser", kind: "element", text: "Document editor", role: "textbox", bounds: testBrowserBounds(120, 280), confidence: 0.95, sourceHints: {}, isInteractive: true },
          { id: "save-doc", surface: "browser", kind: "element", text: "Save document", role: "button", bounds: testBrowserBounds(120, 340), confidence: 0.95, sourceHints: {}, isInteractive: true }
        ];
      case "google_drive":
        return [
          { id: "drive-pending-upload", surface: "browser", kind: "element", text: "Pending upload: Shared roadmap.pdf", role: "button", bounds: testBrowserBounds(120, 140), confidence: 0.95, sourceHints: {}, isInteractive: true },
          { id: "drive-pending-download", surface: "browser", kind: "element", text: "Pending download: Shared report.txt", role: "button", bounds: testBrowserBounds(120, 180), confidence: 0.95, sourceHints: {}, isInteractive: true },
          { id: "drive-upload", surface: "browser", kind: "element", text: "Upload to Drive", role: "textbox", bounds: testBrowserBounds(120, 180), confidence: 0.95, sourceHints: {}, isInteractive: true },
          { id: "drive-download", surface: "browser", kind: "element", text: "Download shared file", role: "link", bounds: testBrowserBounds(120, 240), confidence: 0.95, sourceHints: {}, isInteractive: true }
        ];
      case "google_docs":
        return [
          { id: "google-docs-pending-item", surface: "browser", kind: "element", text: "Needs update: Weekly brief", role: "button", bounds: testBrowserBounds(120, 160), confidence: 0.95, sourceHints: {}, isInteractive: true },
          { id: "google-docs-editor", surface: "browser", kind: "element", text: "Google Docs editor", role: "textbox", bounds: testBrowserBounds(120, 220), confidence: 0.95, sourceHints: {}, isInteractive: true },
          { id: "google-docs-save", surface: "browser", kind: "element", text: "Save Google Doc", role: "button", bounds: testBrowserBounds(120, 280), confidence: 0.95, sourceHints: {}, isInteractive: true }
        ];
      case "feishu_docs":
        return [
          { id: "feishu-docs-pending-item", surface: "browser", kind: "element", text: "待处理文档: 项目周报", role: "button", bounds: testBrowserBounds(120, 160), confidence: 0.95, sourceHints: {}, isInteractive: true },
          { id: "feishu-docs-editor", surface: "browser", kind: "element", text: "飞书文档编辑区", role: "textbox", bounds: testBrowserBounds(120, 220), confidence: 0.95, sourceHints: {}, isInteractive: true },
          { id: "feishu-docs-save", surface: "browser", kind: "element", text: "保存到飞书", role: "button", bounds: testBrowserBounds(120, 280), confidence: 0.95, sourceHints: {}, isInteractive: true }
        ];
      case "demo_root":
        return [
          { id: "name-input", surface: "browser", kind: "element", text: "Name", role: "textbox", bounds: testBrowserBounds(120, 180), confidence: 0.95, sourceHints: { selector: "#name" }, isInteractive: true },
          { id: "submit-button", surface: "browser", kind: "element", text: "Submit", role: "button", bounds: testBrowserBounds(120, 240), confidence: 0.95, sourceHints: { selector: "#submit" }, isInteractive: true },
          { id: "more-info", surface: "browser", kind: "element", text: "More information", role: "link", bounds: testBrowserBounds(120, 300), confidence: 0.95, sourceHints: { selector: "#more-info" }, isInteractive: true }
        ];
      default:
        return [];
    }
  }

  async #postJson(baseUrl: string, pathname: string, payload: Record<string, unknown>) {
    await fetch(new URL(pathname, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
  }

  async #downloadToWorkspace(state: TestBrowserState, workspace: WorkspaceRecord, fileName: string) {
    if (!state.currentUrl) {
      throw new Error("No browser page is open for download.");
    }
    const response = await fetch(new URL("/files/report.txt", state.currentUrl));
    const content = await response.text();
    await fs.mkdir(workspace.downloadsPath, { recursive: true });
    const targetPath = path.join(workspace.downloadsPath, fileName);
    await fs.writeFile(targetPath, content, "utf8");
    return { fileName, path: targetPath };
  }

  async capture({ task, workspace, traceId, label = "browser-capture" }: { task: TaskRecord; workspace: WorkspaceRecord; traceId: string | null; label?: string; }): Promise<ArtifactReference> {
    const state = this.#state(workspace);
    const artifact = await this.artifactStore.writeText({
      workspace,
      taskId: task.id,
      traceId,
      kind: "screenshot",
      label,
      content: JSON.stringify({ url: state.currentUrl, pageKind: state.pageKind, title: state.title, visibleText: this.#visibleText(state) }, null, 2)
    });
    state.lastCapturePath = artifact.path;
    return artifact;
  }

  async discover({ workspace }: { workspace: WorkspaceRecord }) {
    const state = this.#state(workspace);
    return { title: state.title, url: state.currentUrl };
  }

  async observe({ task, workspace, traceId }: { task: TaskRecord; workspace: WorkspaceRecord; traceId: string | null; }) {
    const state = this.#state(workspace);
    return createWorldState({
      surface: "browser",
      workspaceId: workspace.id,
      appContext: { title: state.title, url: state.currentUrl },
      capture: state.lastCapturePath ? { id: "capture", taskId: task.id, traceId, kind: "screenshot", label: "browser-capture", path: state.lastCapturePath, metadata: {}, createdAt: new Date().toISOString() } : null,
      screenTextBlocks: [],
      interactionCandidates: this.#interactionCandidates(state),
      visibleText: this.#visibleText(state),
      recentActions: [],
      summary: state.title
    });
  }

  async focus() {
    return { focused: true, appName: "Google Chrome" };
  }

  async act({ task, workspace, traceId, step }: { task: TaskRecord; workspace: WorkspaceRecord; traceId: string | null; step: { action: string; params?: Record<string, unknown>; label?: string } }) {
    const state = this.#state(workspace);
    const params = step.params ?? {};
    const query = String(params.targetQuery ?? params.text ?? params.textContent ?? "").toLowerCase();

    switch (step.action) {
      case "goto":
      case "navigate":
      case "open_url":
      case "openUrl": {
        const url = String(params.url ?? "").trim();
        if (!url) {
          throw new Error("Browser navigation requires a URL.");
        }
        await this.#applyUrl(state, url);
        return { url, title: state.title };
      }
      case "type": {
        if (String(params.selector ?? "").trim() === "#name") {
          state.formValue = String(params.text ?? "");
          return { typed: state.formValue };
        }
        return { typed: String(params.text ?? "") };
      }
      case "typeIntoTarget": {
        const text = String(params.text ?? "");
        if (query.includes("name")) {
          state.formValue = text;
          return { typed: state.formValue };
        }
        if (query.includes("reply")) {
          state.replyDraft = params.clear === false ? `${state.replyDraft}${text}` : text;
          if (state.pageKind === "slack_thread" && state.currentUrl) {
            await this.#postJson(state.currentUrl, "/api/slack/draft", { message: state.replyDraft });
            await this.#syncSlackState(state, new URL(state.currentUrl).origin);
          }
          return { typed: state.replyDraft };
        }
        if (query.includes("message")) {
          state.replyDraft = params.clear === false ? `${state.replyDraft}${text}` : text;
          if (state.pageKind === "slack_thread" && state.currentUrl) {
            await this.#postJson(state.currentUrl, "/api/slack/draft", { message: state.replyDraft });
            await this.#syncSlackState(state, new URL(state.currentUrl).origin);
          }
          return { typed: state.replyDraft };
        }
        if (query.includes("document editor")) {
          state.savedDocument = text;
          return { typed: state.savedDocument };
        }
        if (query.includes("google docs editor")) {
          state.googleDocsDocument = text;
          return { typed: state.googleDocsDocument };
        }
        if (query.includes("飞书文档编辑区")) {
          state.feishuDocsDocument = text;
          return { typed: state.feishuDocsDocument };
        }
        return { typed: text };
      }
      case "click": {
        const selector = String(params.selector ?? "");
        if (selector === "#submit") {
          state.statusText = `Submitted: ${state.formValue}`;
          return { clicked: true };
        }
        if (selector === "a" && query.includes("more information") && state.currentUrl) {
          await this.#applyUrl(state, new URL("/next", state.currentUrl).toString());
          return { clicked: true, url: state.currentUrl };
        }
        return { clicked: true };
      }
      case "clickTarget": {
        if ((query.includes(state.threadTitle.toLowerCase()) || query.includes("unread thread")) && state.currentUrl) {
          const nextUrl = new URL(state.currentUrl);
          nextUrl.pathname = "/slack";
          nextUrl.searchParams.set("thread", state.threadId);
          await this.#applyUrl(state, nextUrl.toString());
          return { clicked: true, url: state.currentUrl };
        }
        if (query.includes("submit")) {
          state.statusText = `Submitted: ${state.formValue}`;
          return { clicked: true };
        }
        if (query.includes("more information") && state.currentUrl) {
          await this.#applyUrl(state, new URL("/next", state.currentUrl).toString());
          return { clicked: true, url: state.currentUrl };
        }
        if (query.includes("send") && state.pageKind === "slack_thread" && state.currentUrl) {
          const body = new URLSearchParams();
          body.set("message", state.replyDraft);
          await fetch(new URL(`/slack/send?thread=${encodeURIComponent(state.threadId)}`, state.currentUrl), {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: body.toString(),
            redirect: "manual"
          });
          await this.#syncSlackState(state, new URL(state.currentUrl).origin);
          return { clicked: true };
        }
        if (query.includes("save document") && state.currentUrl) {
          await this.#postJson(state.currentUrl, "/api/document", { text: state.savedDocument });
          return { clicked: true };
        }
        if (query.includes("save google doc") && state.currentUrl) {
          await this.#postJson(state.currentUrl, "/api/google-docs/save", { text: state.googleDocsDocument });
          return { clicked: true };
        }
        if (query.includes("保存到飞书") && state.currentUrl) {
          await this.#postJson(state.currentUrl, "/api/feishu-docs/save", { text: state.feishuDocsDocument });
          return { clicked: true };
        }
        return { clicked: true };
      }
      case "download": {
        const fileName = String(params.fileName ?? "downloaded-file").trim() || "downloaded-file";
        return await this.#downloadToWorkspace(state, workspace, fileName);
      }
      case "upload": {
        if (!state.currentUrl) {
          throw new Error("No browser page is open for upload.");
        }
        const filePath = path.isAbsolute(String(params.path ?? "")) ? String(params.path) : path.resolve(workspace.rootPath, String(params.path ?? ""));
        const content = await fs.readFile(filePath, "utf8");
        const fileName = path.basename(filePath);
        if (state.pageKind === "docs") {
          state.uploadedFileName = fileName;
          await this.#postJson(state.currentUrl, "/api/upload", { name: fileName, content });
          return { fileName, path: filePath };
        }
        if (state.pageKind === "google_drive") {
          state.googleDriveUploadedFileName = fileName;
          await this.#postJson(state.currentUrl, "/api/google-drive/upload", { name: fileName, content });
          return { fileName, path: filePath };
        }
        throw new Error(`Upload is not supported on mock page ${state.pageKind}.`);
      }
      case "wait": {
        const ms = Number(params.ms ?? 0);
        if (Number.isFinite(ms) && ms > 0) {
          await new Promise((resolve) => setTimeout(resolve, ms));
        }
        return { ok: true };
      }
      case "waitFor":
      case "waitForLoad":
        return { ok: true };
      case "waitForTarget":
        return {
          ok: this.#interactionCandidates(state).some((candidate) =>
            String(candidate.text ?? "").toLowerCase().includes(query)
          )
        };
      case "extractText":
        if (String(params.selector ?? "").trim() === "#status") {
          return { text: state.statusText };
        }
        return { text: this.#visibleText(state) };
      case "screenshot":
        return await this.capture({ task, workspace, traceId, label: String(params.label ?? step.label ?? "browser-capture") });
      default:
        throw new Error(`Unsupported mock browser action: ${step.action}`);
    }
  }

  async verify({ workspace, expectation = {} }: { workspace: WorkspaceRecord; expectation?: Record<string, unknown>; }): Promise<StepVerification> {
    const state = this.#state(workspace);
    const details: Record<string, unknown> = {};

    if (typeof expectation.urlIncludes === "string") {
      details.url = state.currentUrl;
      if (!String(state.currentUrl ?? "").includes(expectation.urlIncludes)) {
        return { ok: false, details };
      }
    }
    if (typeof expectation.textVisible === "string") {
      const visible = this.#visibleText(state).includes(expectation.textVisible);
      details.textVisible = visible;
      if (!visible) {
        return { ok: false, details };
      }
    }
    if (expectation.selectorText && typeof expectation.selectorText === "object") {
      const selectorText = expectation.selectorText as { selector?: string; equals?: string };
      if (selectorText.selector === "#status") {
        details.selectorText = state.statusText;
        if (String(selectorText.equals ?? "") !== state.statusText) {
          return { ok: false, details };
        }
      }
    }
    if (expectation.navigationOccurred === true) {
      details.navigationCount = state.navigationCount;
      if (state.navigationCount < 2) {
        return { ok: false, details };
      }
    }
    if (typeof expectation.readyState === "string") {
      details.readyState = "complete";
      if (expectation.readyState !== "complete") {
        return { ok: false, details };
      }
    }
    if (expectation.fileSaved === true) {
      details.fileSaved = Boolean(state.lastCapturePath);
      if (!state.lastCapturePath) {
        return { ok: false, details };
      }
    }
    return { ok: true, details };
  }
}
