import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";

import { SurfaceAdapter } from "./surface-adapter.js";
import { RecoverableError } from "../errors.js";
import { createInteractionCandidate, createWorldState, summarizeRecentActions } from "../world-state.js";
import { createStagehandRuntime, type StagehandRuntime } from "../stagehand-runtime.js";
import { cloneChromeProfileToWorkspace, resolveChromeProfileSource } from "../chrome-profile-utils.js";
import type { ArtifactStore } from "../artifact-store.js";
import type { WorkspaceRecord } from "../../types/runtime-schema.js";
import type { AgentModelConfig, BrowserMode } from "../../config.js";
import type {
  BrowserBlocker,
  BrowserExecutionInput,
  BrowserExecutionResult
} from "../../types/runtime-schema.js";

function escapeSelectorValue(value) {
  return String(value ?? "").replaceAll("\\", "\\\\").replaceAll("\"", '\\"');
}

function inferRole(entry) {
  const tag = String(entry.tag ?? "").toLowerCase();
  const type = String(entry.type ?? "").toLowerCase();
  if (tag === "button" || type === "submit" || entry.sourceHints?.ariaLabel) {
    return "button";
  }
  if (["input", "textarea", "select"].includes(tag)) {
    return "textbox";
  }
  if (tag === "a") {
    return "link";
  }
  return tag || "element";
}

function isBrowserLoadingStub(value: unknown): boolean {
  const normalized = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return true;
  }

  return /^(加载中，请稍候|loading)$/iu.test(normalized);
}

function summarizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function inferElementText(entry: HTMLElement): string {
  return summarizeText(
    entry.innerText
    || entry.textContent
    || entry.getAttribute("aria-label")
    || entry.getAttribute("placeholder")
    || entry.getAttribute("title")
    || entry.getAttribute("value")
    || ""
  );
}

function detectBrowserBlockers({
  url,
  title,
  visibleText
}: {
  url: string;
  title: string;
  visibleText: string;
}): BrowserBlocker[] {
  const haystack = `${title}\n${visibleText}`.trim();
  const normalizedUrl = String(url ?? "").trim().toLowerCase();

  if (
    /verify|captcha|slider|security|challenge/iu.test(normalizedUrl)
    || /(滑块|验证|captcha|security check|verification required|human verification)/iu.test(haystack)
  ) {
    return [
      {
        kind: "verification_required",
        detail: "The current browser page requires verification before automation can continue.",
        suggestedAction: "Complete the verification in the existing browser tab, then retry."
      }
    ];
  }

  if (
    /(sign in|log in|login|登录|扫码登录|账号登录|欢迎回来)/iu.test(haystack)
    && !/(logout|sign out|退出登录)/iu.test(haystack)
  ) {
    return [
      {
        kind: "signin_required",
        detail: "The current browser page appears to require sign-in.",
        suggestedAction: "Finish sign-in in the existing browser tab, then retry."
      }
    ];
  }

  if (!summarizeText(haystack)) {
    return [
      {
        kind: "page_unavailable",
        detail: "The current browser page does not expose visible text or interactive content yet.",
        suggestedAction: "Wait for the page to finish loading or bring the intended tab to the foreground."
      }
    ];
  }

  return [];
}

function buildCandidateKey(candidate: Record<string, unknown>): string {
  const bounds = (candidate.bounds ?? {}) as { centerX?: number; centerY?: number };
  return [
    String(candidate.text ?? "").trim().toLowerCase(),
    String(candidate.role ?? "").trim().toLowerCase(),
    Math.round(Number(bounds.centerX ?? 0)),
    Math.round(Number(bounds.centerY ?? 0)),
    String(((candidate.sourceHints ?? {}) as Record<string, unknown>).source ?? "").trim().toLowerCase()
  ].join("|");
}

async function locateElement(page, params) {
  if (params.selector) {
    return page.locator(params.selector).first();
  }

  if (params.text) {
    return page.getByText(params.text, { exact: params.exact ?? false }).first();
  }

  throw new Error("Browser action requires params.selector or params.text");
}

function resolveWorkspacePath(workspace: WorkspaceRecord, targetPath: unknown): string {
  const raw = String(targetPath ?? "").trim();
  if (!raw) {
    throw new Error("File path is required.");
  }

  return path.isAbsolute(raw) ? raw : path.resolve(workspace.rootPath, raw);
}

function waitForMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port) {
          reject(new Error("Could not allocate a free port."));
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForCdpUrl(port: number, timeoutMs = 30000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        const payload = await response.json() as { webSocketDebuggerUrl?: string };
        if (typeof payload.webSocketDebuggerUrl === "string" && payload.webSocketDebuggerUrl) {
          return payload.webSocketDebuggerUrl;
        }
      }
    } catch (error) {
      lastError = error;
    }
    await waitForMs(250);
  }

  throw new Error(`Chrome remote debugging did not become ready on port ${port}: ${String(lastError ?? "timeout")}`);
}

async function resolveBrowserCdpEndpoint(endpoint: string, timeoutMs = 10000): Promise<string> {
  const normalized = String(endpoint ?? "").trim();
  if (!normalized) {
    throw new Error(
      "No browser CDP endpoint configured. Start Chrome with --remote-debugging-port and set AGENTOS_BROWSER_CDP_URL."
    );
  }

  if (/^wss?:\/\//iu.test(normalized)) {
    return normalized;
  }

  const target = normalized.replace(/\/$/u, "");
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${target}/json/version`);
      if (response.ok) {
        const payload = (await response.json()) as { webSocketDebuggerUrl?: string };
        if (typeof payload.webSocketDebuggerUrl === "string" && payload.webSocketDebuggerUrl) {
          return payload.webSocketDebuggerUrl;
        }
      }
    } catch (error) {
      lastError = error;
    }
    await waitForMs(250);
  }

  throw new Error(
    `Browser CDP endpoint did not become ready at ${target}: ${String(lastError ?? "timeout")}`
  );
}

interface BrowserRuntimeSession {
  browser: Browser;
  context: BrowserContext;
  process: ChildProcess | null;
  cdpUrl: string;
  page: Page | null;
  stagehand: StagehandRuntime | null;
  mode: BrowserMode;
}

export class BrowserSurfaceAdapter extends SurfaceAdapter {
  artifactStore: ArtifactStore;
  browserMode: BrowserMode;
  browserExecutable: string | null;
  browserCdpUrl: string | null;
  modelConfig: AgentModelConfig;
  headless: boolean;
  runtimes: Map<string, BrowserRuntimeSession>;
  launchProfiles: Map<string, { userDataDir: string; profileDirectory: string }>;
  constructor({
    artifactStore,
    browserMode,
    browserExecutable,
    browserCdpUrl,
    modelConfig,
    headless
  }: {
    artifactStore: ArtifactStore;
    browserMode: BrowserMode;
    browserExecutable: string | null;
    browserCdpUrl?: string | null;
    modelConfig: AgentModelConfig;
    headless: boolean;
  }) {
    super("browser");
    this.artifactStore = artifactStore;
    this.browserMode = browserMode;
    this.browserExecutable = browserExecutable;
    this.browserCdpUrl = String(browserCdpUrl ?? "").trim() || null;
    this.modelConfig = modelConfig;
    this.headless = headless;
    this.runtimes = new Map();
    this.launchProfiles = new Map();
  }

  usesSharedSession(): boolean {
    return this.browserMode === "attach_existing";
  }

  #contextKey(workspace: WorkspaceRecord): string {
    return workspace.rootPath || workspace.profilePath || workspace.id;
  }

  async #prepareLaunchProfile(workspace: WorkspaceRecord): Promise<{ userDataDir: string; profileDirectory: string }> {
    const contextKey = this.#contextKey(workspace);
    if (this.launchProfiles.has(contextKey)) {
      return this.launchProfiles.get(contextKey)!;
    }

    const explicitProfilePath = String(workspace.profilePath ?? "").trim();
    const sourceProfile = await resolveChromeProfileSource(explicitProfilePath || null);
    await fs.mkdir(workspace.scratchPath, { recursive: true });
    const targetUserDataDir = await fs.mkdtemp(path.join(workspace.scratchPath, "managed-browser-profile-"));

    let launchProfile = {
      userDataDir: targetUserDataDir,
      profileDirectory: "Default"
    };

    if (sourceProfile) {
      launchProfile = await cloneChromeProfileToWorkspace({
        source: sourceProfile,
        targetUserDataDir
      });
    } else {
      await fs.mkdir(targetUserDataDir, { recursive: true });
    }

    this.launchProfiles.set(contextKey, launchProfile);
    return launchProfile;
  }

  async #getRuntime(workspace: WorkspaceRecord): Promise<BrowserRuntimeSession> {
    const contextKey = this.#contextKey(workspace);
    if (this.runtimes.has(contextKey)) {
      return this.runtimes.get(contextKey)!;
    }

    if (this.browserMode === "attach_existing") {
      const cdpUrl = await resolveBrowserCdpEndpoint(this.browserCdpUrl ?? "");
      const browser = await chromium.connectOverCDP(cdpUrl);
      const context = browser.contexts()[0];
      if (!context) {
        throw new Error("Attached Chrome did not expose a persistent browser context over CDP.");
      }
      const runtime = {
        browser,
        context,
        process: null,
        cdpUrl,
        page: null,
        stagehand: null,
        mode: "attach_existing" as const
      };
      this.runtimes.set(contextKey, runtime);
      return runtime;
    }

    if (!this.browserExecutable) {
      throw new Error("No managed browser executable detected. Set AGENTOS_BROWSER_EXECUTABLE.");
    }

    const launchProfile = await this.#prepareLaunchProfile(workspace);
    const debugPort = await getFreePort();
    const args = [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${launchProfile.userDataDir}`,
      `--profile-directory=${launchProfile.profileDirectory}`,
      `--window-size=1440,960`,
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled"
    ];
    if (this.headless) {
      args.push("--headless=new");
    }

    const chromeProcess = spawn(this.browserExecutable, args, {
      stdio: "ignore"
    });
    const cdpUrl = await waitForCdpUrl(debugPort);
    const browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => null);
      chromeProcess.kill("SIGKILL");
      throw new Error("Chrome did not expose a persistent browser context over CDP.");
    }
    await context.addInitScript(() => {
      Object.defineProperty(window.navigator, "webdriver", {
        get: () => undefined
      });
    });

    const runtime = {
      browser,
      context,
      process: chromeProcess,
      cdpUrl,
      page: null,
      stagehand: null,
      mode: "managed_profile" as const
    };
    this.runtimes.set(contextKey, runtime);
    return runtime;
  }

  async #getContext(workspace: WorkspaceRecord): Promise<BrowserContext> {
    const runtime = await this.#getRuntime(workspace);
    return runtime.context;
  }

  async #getStagehandRuntime(workspace: WorkspaceRecord): Promise<StagehandRuntime> {
    const runtime = await this.#getRuntime(workspace);
    if (!runtime.stagehand) {
      runtime.stagehand = await createStagehandRuntime({
        cdpUrl: runtime.cdpUrl,
        modelConfig: this.modelConfig
      });
    }
    return runtime.stagehand;
  }

  async #page(workspace: WorkspaceRecord): Promise<Page> {
    const runtime = await this.#getRuntime(workspace);
    if (runtime.page && !runtime.page.isClosed()) {
      return runtime.page;
    }

    if (runtime.mode === "attach_existing") {
      const existingPages = runtime.context
        .pages()
        .filter((page) => !page.isClosed())
        .filter((page) => !/^chrome-extension:|^devtools:|^chrome:\/\//iu.test(page.url() || ""));
      const preferredPage =
        existingPages.find((page) => page.url() && page.url() !== "about:blank")
        ?? existingPages.at(-1)
        ?? null;
      if (!preferredPage) {
        throw new Error(
          "No attachable Chrome page is open in the existing browser session. Open the target site in your main Chrome window and retry."
        );
      }
      runtime.page = preferredPage;
      return preferredPage;
    }

    const page = await runtime.context.newPage();
    runtime.page = page;
    return page;
  }

  async #readPageText(page: Page): Promise<string> {
    await page.waitForLoadState("domcontentloaded").catch(() => null);
    let pageText = await page.locator("body").innerText().catch(() => "");
    if (!isBrowserLoadingStub(pageText)) {
      return pageText;
    }

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await page.waitForLoadState("networkidle", { timeout: 1000 }).catch(() => null);
      await page.waitForTimeout(500);
      pageText = await page.locator("body").innerText().catch(() => pageText);
      if (!isBrowserLoadingStub(pageText)) {
        return pageText;
      }
    }

    return pageText;
  }

  async #collectCandidates(page: Page) {
    const rawCandidates = await page.evaluate(() => {
      const visible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity || "1") > 0
          && rect.width > 0
          && rect.height > 0
        );
      };

      const selectorFor = (element: HTMLElement | null): string | null => {
        if (!element) {
          return null;
        }
        const id = element.getAttribute("id");
        if (id) {
          return `#${window.CSS?.escape ? window.CSS.escape(id) : id}`;
        }
        const placeholder = element.getAttribute("placeholder");
        if (placeholder) {
          return `${element.tagName.toLowerCase()}[placeholder="${placeholder.replaceAll("\"", "\\\"")}"]`;
        }
        const name = element.getAttribute("name");
        if (name) {
          return `${element.tagName.toLowerCase()}[name="${name.replaceAll("\"", "\\\"")}"]`;
        }
        const ariaLabel = element.getAttribute("aria-label");
        if (ariaLabel) {
          return `${element.tagName.toLowerCase()}[aria-label="${ariaLabel.replaceAll("\"", "\\\"")}"]`;
        }
        return element.tagName.toLowerCase();
      };

      const boundsFor = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          centerX: rect.x + rect.width / 2,
          centerY: rect.y + rect.height / 2
        };
      };

      const summarize = (value: unknown) => String(value ?? "").replace(/\s+/gu, " ").trim();
      const selectors = [
        "button",
        "a[href]",
        "input",
        "textarea",
        "select",
        "[role='button']",
        "[role='textbox']",
        "[role='listitem']",
        "[role='tab']",
        "[contenteditable='true']",
        "h1, h2, h3",
        "li"
      ];
      const nodes = Array.from(document.querySelectorAll(selectors.join(","))).filter((node) => visible(node)).slice(0, 160);
      return nodes.map((node) => {
        const element = node as HTMLElement;
        const text = summarize(
          element.innerText
          || element.textContent
          || element.getAttribute("aria-label")
          || element.getAttribute("placeholder")
          || element.getAttribute("title")
          || element.getAttribute("value")
          || ""
        ).slice(0, 240);
        return {
          text,
          tag: element.tagName.toLowerCase(),
          type: element.getAttribute("type"),
          role: element.getAttribute("role"),
          bounds: boundsFor(element),
          isInteractive:
            element.matches("button, a[href], input, textarea, select, [role='button'], [role='textbox'], [contenteditable='true'], [role='tab']"),
          sourceHints: {
            selector: selectorFor(element),
            tag: element.tagName.toLowerCase(),
            type: element.getAttribute("type"),
            name: element.getAttribute("name"),
            placeholder: element.getAttribute("placeholder"),
            ariaLabel: element.getAttribute("aria-label"),
            title: element.getAttribute("title"),
            href: element.getAttribute("href")
          }
        };
      });
    }).catch(() => []);

    const genericCandidates = rawCandidates
      .filter((candidate) => candidate.text || candidate.isInteractive)
      .map((candidate, index) =>
        createInteractionCandidate(
          {
            ...candidate,
            id: `browser-candidate-${index + 1}`,
            kind: candidate.isInteractive ? "element" : "text",
            role: candidate.role || inferRole(candidate),
            confidence: candidate.isInteractive ? 0.74 : 0.52,
            isInteractive: Boolean(candidate.isInteractive)
          },
          index,
          "browser"
        )
      );

    const deduped = new Map<string, Record<string, unknown>>();
    for (const candidate of genericCandidates) {
      const key = buildCandidateKey(candidate as Record<string, unknown>);
      if (!deduped.has(key)) {
        deduped.set(key, candidate as Record<string, unknown>);
      }
    }

    return [...deduped.values()];
  }

  async #resolveLocatorFromTarget(
    page: Page,
    target: Record<string, unknown> | null | undefined
  ): Promise<Locator | null> {
    const targetText = typeof target?.text === "string" ? target.text : "";
    const hints = (target?.sourceHints ?? {}) as {
      selector?: string;
      dataId?: string;
      ariaLabel?: string;
      placeholder?: string;
      name?: string;
      title?: string;
      tag?: string;
      href?: string;
    };
    const locators = [];

    if (targetText) {
      locators.push(page.getByText(targetText, { exact: true }).first());
      locators.push(page.getByText(targetText, { exact: false }).first());
    }

    if (typeof hints.selector === "string" && hints.selector.trim()) {
      locators.unshift(page.locator(hints.selector).first());
    }

    if (typeof hints.dataId === "string" && hints.dataId.trim()) {
      locators.unshift(page.locator(`.geek-item[data-id="${escapeSelectorValue(hints.dataId)}"]`).first());
    }

    if (hints.ariaLabel) {
      locators.push(page.getByLabel(hints.ariaLabel, { exact: true }).first());
      locators.push(page.locator(`[aria-label="${escapeSelectorValue(hints.ariaLabel)}"]`).first());
    }

    if (hints.placeholder) {
      locators.push(page.getByPlaceholder(hints.placeholder, { exact: true }).first());
    }

    if (hints.name) {
      locators.push(page.locator(`[name="${escapeSelectorValue(hints.name)}"]`).first());
    }

    if (hints.title) {
      locators.push(page.locator(`[title="${escapeSelectorValue(hints.title)}"]`).first());
    }

    if (hints.tag === "a" && hints.href) {
      locators.push(page.locator(`a[href="${escapeSelectorValue(hints.href)}"]`).first());
    }

    for (const locator of locators) {
      const count = await locator.count().catch(() => 0);
      if (count > 0) {
        return locator;
      }
    }

    return null;
  }

  async #resolveLocatorFromTargetQuery(page: Page, targetQuery: unknown): Promise<Locator | null> {
    const query = String(targetQuery ?? "").trim();
    if (!query) {
      return null;
    }

    const locators = [
      page.getByText(query, { exact: true }).first(),
      page.getByText(query, { exact: false }).first(),
      page.getByLabel(query, { exact: true }).first(),
      page.getByPlaceholder(query, { exact: true }).first()
    ];

    for (const locator of locators) {
      const count = await locator.count().catch(() => 0);
      if (count > 0) {
        return locator;
      }
    }

    return null;
  }

  async #clickByBounds(page: Page, bounds?: { centerX?: number; centerY?: number } | null) {
    if (!bounds) {
      return false;
    }

    await page.mouse.click(bounds.centerX, bounds.centerY);
    return true;
  }

  async #locatorForAction(page: Page, params: Record<string, unknown>): Promise<Locator | null> {
    if (params.target) {
      return this.#resolveLocatorFromTarget(page, params.target as Record<string, unknown>);
    }

    if (params.selector || params.text) {
      return locateElement(page, params);
    }

    return null;
  }

  async #hasVisibleOrEditableText(page: Page, text: string): Promise<{
    textVisible: boolean;
    inputValueVisible: boolean;
  }> {
    const textVisible = await page.getByText(text, { exact: false }).first().isVisible().catch(() => false);
    if (textVisible) {
      return {
        textVisible: true,
        inputValueVisible: false
      };
    }

    const inputValueVisible = await page
      .locator("input, textarea, [contenteditable='true']")
      .evaluateAll((nodes, expected) => {
        const needle = String(expected ?? "");
        return nodes.some((node) => {
          if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
            return node.value.includes(needle);
          }

          if (node instanceof HTMLElement && node.isContentEditable) {
            return (node.innerText || node.textContent || "").includes(needle);
          }

          return false;
        });
      }, text)
      .catch(() => false);

    return {
      textVisible: false,
      inputValueVisible
    };
  }

  #normalizeBrowserExecutionInput(params: Record<string, unknown>): BrowserExecutionInput {
    return {
      instruction: String(params.instruction ?? "").trim(),
      ...(typeof params.startUrl === "string" && params.startUrl.trim() ? { startUrl: params.startUrl.trim() } : {}),
      ...(Array.isArray(params.actions) ? { actions: params.actions.map((entry) => String(entry ?? "").trim()).filter(Boolean) } : {}),
      ...(typeof params.successCriteria === "string" && params.successCriteria.trim()
        ? { successCriteria: params.successCriteria.trim() }
        : {}),
      ...(params.verificationSchema && typeof params.verificationSchema === "object"
        ? { verificationSchema: params.verificationSchema as Record<string, unknown> }
        : {}),
      maxSteps: Math.max(1, Number(params.maxSteps ?? 3)),
      timeoutMs: Math.max(1000, Number(params.timeoutMs ?? this.modelConfig.timeoutMs)),
      ...(params.variables && typeof params.variables === "object"
        ? { variables: params.variables as Record<string, unknown> }
        : {}),
      navigationPolicy: {
        allowSameTabNavigation: params.allowSameTabNavigation !== false,
        allowNewTabs: params.allowNewTabs === true,
        allowCrossOriginNavigation: params.allowCrossOriginNavigation === true
      }
    };
  }

  async #runBrowserExecution(
    page: Page,
    workspace: WorkspaceRecord,
    params: Record<string, unknown>
  ): Promise<BrowserExecutionResult> {
    const runtime = await this.#getStagehandRuntime(workspace);
    const input = this.#normalizeBrowserExecutionInput(params);
    if (input.startUrl && page.url() !== input.startUrl) {
      await page.goto(input.startUrl, {
        waitUntil: "domcontentloaded",
        timeout: input.timeoutMs
      });
    }
    return await runtime.execute(input, page);
  }

  async discover({ workspace }) {
    const page = await this.#page(workspace);
    return {
      url: page.url(),
      title: await page.title()
    };
  }

  async observe({ task, workspace, traceId, label = "browser-observe", recentActions = [] }) {
    const page = await this.#page(workspace);
    const pageText = await this.#readPageText(page);
    const [candidates, capture, title] = await Promise.all([
      this.#collectCandidates(page),
      this.capture({ task, workspace, traceId, label }),
      page.title().catch(() => "")
    ]);
    const blockers = detectBrowserBlockers({
      url: page.url(),
      title,
      visibleText: pageText
    });

    return createWorldState({
      surface: "browser",
      workspaceId: workspace.id,
      appContext: {
        title,
        url: page.url(),
        blockers,
        runtime: "stagehand"
      },
      capture,
      interactionCandidates: candidates,
      visibleText: pageText.slice(0, 4000),
      recentActions: summarizeRecentActions(recentActions),
      summary: `${title} @ ${page.url()}`
    });
  }

  async focus({ workspace }) {
    const page = await this.#page(workspace);
    await page.bringToFront();
    return { focused: true, url: page.url() };
  }

  async capture({ task, workspace, traceId, label = "browser-capture" }) {
    const page = await this.#page(workspace);
    const filePath = path.join(workspace.artifactsPath, `${Date.now()}-${label.replaceAll(/\s+/g, "-")}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    return this.artifactStore.registerExistingFile({
      workspace,
      taskId: task.id,
      traceId,
      kind: "screenshot",
      label,
      filePath,
      metadata: { surface: "browser", url: page.url() }
    });
  }

  async act({ task, step, workspace, traceId }) {
    const page = await this.#page(workspace);
    const params = step.params ?? {};

    try {
      switch (step.action) {
        case "goto":
        case "navigate":
        case "open_url":
        case "openUrl":
          await page.goto(params.url, {
            waitUntil: params.waitUntil ?? "domcontentloaded",
            timeout: params.timeoutMs ?? 30000
          });
          return { url: page.url(), title: await page.title() };
        case "browserObserve":
        case "stagehandObserve": {
          const runtime = await this.#getStagehandRuntime(workspace);
          return {
            observation: await runtime.observe(String(params.instruction ?? "").trim(), {
              page,
              timeoutMs: Number(params.timeoutMs ?? this.modelConfig.timeoutMs),
              onlyVisible: params.onlyVisible !== false,
              returnAction: params.returnAction !== false
            })
          };
        }
        case "browserAct":
        case "stagehandAct": {
          const runtime = await this.#getStagehandRuntime(workspace);
          return {
            result: await runtime.act(String(params.instruction ?? "").trim(), {
              page,
              timeoutMs: Number(params.timeoutMs ?? this.modelConfig.timeoutMs),
              variables: (params.variables ?? {}) as Record<string, unknown>
            })
          };
        }
        case "browserObserveAct":
        case "stagehandObserveAct": {
          const runtime = await this.#getStagehandRuntime(workspace);
          return {
            result: await runtime.observeThenAct(String(params.instruction ?? "").trim(), {
              page,
              timeoutMs: Number(params.timeoutMs ?? this.modelConfig.timeoutMs),
              variables: (params.variables ?? {}) as Record<string, unknown>
            })
          };
        }
        case "browserExtract":
        case "stagehandExtract": {
          const runtime = await this.#getStagehandRuntime(workspace);
          return {
            extracted: await runtime.extract(
              String(params.instruction ?? "").trim(),
              (params.schema ?? params.verificationSchema ?? null) as Record<string, unknown> | null,
              {
                page,
                timeoutMs: Number(params.timeoutMs ?? this.modelConfig.timeoutMs)
              }
            )
          };
        }
        case "browserExecute":
        case "browserAgent":
        case "stagehandAgent": {
          const result = await this.#runBrowserExecution(page, workspace, params);
          if (result.status !== "completed") {
            const detail = result.blockers[0]?.detail ?? "Browser execution was blocked.";
            throw new Error(detail);
          }
          return result;
        }
        case "click": {
          const locator = await locateElement(page, params);
          await locator.click({ button: params.button ?? "left", timeout: params.timeoutMs ?? 15000 });
          return { clicked: true };
        }
        case "type": {
          const locator = await locateElement(page, params);
          if (params.clear !== false) {
            await locator.fill("");
          }
          await locator.fill(params.text ?? "");
          return { typed: params.text?.length ?? 0 };
        }
        case "press":
          await page.keyboard.press(params.key);
          return { pressed: params.key };
        case "wait":
          await page.waitForTimeout(params.ms ?? 1000);
          return { waitedMs: params.ms ?? 1000 };
        case "waitFor":
          if (params.selector) {
            await page.locator(params.selector).waitFor({
              timeout: params.timeoutMs ?? 15000,
              state: params.state ?? "visible"
            });
          } else if (params.text) {
            await page.getByText(params.text, { exact: params.exact ?? false }).waitFor({
              timeout: params.timeoutMs ?? 15000,
              state: params.state ?? "visible"
            });
          } else if (params.urlIncludes) {
            await page.waitForURL(new RegExp(params.urlIncludes.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), {
              timeout: params.timeoutMs ?? 15000
            });
          }
          return { waitedFor: params };
        case "extractText": {
          const locator = await locateElement(page, params);
          return { text: (await locator.textContent())?.trim() ?? "" };
        }
        case "upload": {
          const locator = await this.#locatorForAction(page, params);
          if (!locator) {
            throw new Error("Browser upload requires a target, selector, or text.");
          }
          const filePaths = Array.isArray(params.paths)
            ? params.paths.map((entry) => resolveWorkspacePath(workspace, entry))
            : [resolveWorkspacePath(workspace, params.path)];
          await locator.setInputFiles(filePaths);
          return { uploaded: filePaths.length === 1 ? filePaths[0] : filePaths, uploadedPaths: filePaths };
        }
        case "download": {
          const locator = await this.#locatorForAction(page, params);
          const timeoutMs = Number(params.timeoutMs ?? 15000);
          const fileNameOverride = String(params.fileName ?? "").trim();
          const destinationOverride = params.path ? resolveWorkspacePath(workspace, params.path) : null;
          const [download] = await Promise.all([
            page.waitForEvent("download", { timeout: timeoutMs }),
            (async () => {
              if (locator) {
                await locator.click({ timeout: timeoutMs });
                return;
              }

              const clicked = await this.#clickByBounds(page, (params.target as { bounds?: { centerX?: number; centerY?: number } } | undefined)?.bounds);
              if (!clicked) {
                throw new Error(`Could not resolve download target ${String((params.target as { id?: string } | undefined)?.id ?? params.targetQuery ?? "unknown")}`);
              }
            })()
          ]);
          const suggestedFileName = download.suggestedFilename();
          const destinationPath =
            destinationOverride ?? path.join(workspace.downloadsPath, fileNameOverride || suggestedFileName);
          await fs.mkdir(path.dirname(destinationPath), { recursive: true });
          await download.saveAs(destinationPath);
          return {
            filePath: destinationPath,
            fileName: path.basename(destinationPath),
            suggestedFileName,
            url: download.url()
          };
        }
        case "evaluate":
          return {
            value: await page.evaluate(
              ({ source, arg }) => {
                const fn = new Function("arg", source);
                return fn(arg);
              },
              { source: params.script, arg: params.arg ?? null }
            )
          };
        case "capture":
        case "screenshot":
          return this.capture({ task, workspace, traceId, label: params.label ?? step.label });
        case "waitForLoad":
          await page.waitForLoadState(params.state ?? "load", {
            timeout: params.timeout ?? params.timeoutMs ?? 15000
          });
          return { loadState: params.state ?? "load" };
        case "scrollSurface":
          await page.mouse.wheel(params.dx ?? 0, params.dy ?? 800);
          return { scrolled: true, dx: params.dx ?? 0, dy: params.dy ?? 800 };
        case "clickAt":
          await page.mouse.click(Number(params.x ?? 0), Number(params.y ?? 0));
          return { clicked: true, x: Number(params.x ?? 0), y: Number(params.y ?? 0), resolutionMode: "point" };
        case "clickTarget":
        case "focusTarget": {
          const locator =
            (await this.#resolveLocatorFromTarget(page, params.target))
            ?? (await this.#resolveLocatorFromTargetQuery(page, params.targetQuery));
          if (locator) {
            await locator.click({ timeout: params.timeoutMs ?? 15000 });
            return { clicked: true, resolvedTarget: params.target };
          }

          const clicked = await this.#clickByBounds(page, params.target?.bounds);
          if (!clicked) {
            throw new Error(`Could not resolve target ${params.target?.id ?? params.targetQuery ?? "unknown"}`);
          }
          return { clicked: true, resolvedTarget: params.target, resolutionMode: "bounds" };
        }
        case "typeIntoTarget": {
          const locator =
            (await this.#resolveLocatorFromTarget(page, params.target))
            ?? (await this.#resolveLocatorFromTargetQuery(page, params.targetQuery));
          if (locator) {
            await locator.click({ timeout: params.timeoutMs ?? 15000 }).catch(() => {});
            if (params.clear !== false) {
              await locator.fill("");
            }
            await locator.fill(params.text ?? "");
            return { typed: params.text?.length ?? 0, resolvedTarget: params.target };
          }

          const clicked = await this.#clickByBounds(page, params.target?.bounds);
          if (!clicked) {
            throw new Error(`Could not resolve target ${params.target?.id ?? params.targetQuery ?? "unknown"}`);
          }
          await page.keyboard.type(params.text ?? "");
          return { typed: params.text?.length ?? 0, resolvedTarget: params.target, resolutionMode: "bounds" };
        }
        case "waitForTarget": {
          const locator =
            (await this.#resolveLocatorFromTarget(page, params.target))
            ?? (await this.#resolveLocatorFromTargetQuery(page, params.targetQuery));
          if (locator) {
            await locator.waitFor({ timeout: params.timeoutMs ?? 15000, state: params.state ?? "visible" });
            return { waitedForTarget: params.target?.id ?? null };
          }

          if (params.target?.text) {
            await page.getByText(params.target.text, { exact: false }).waitFor({
              timeout: params.timeoutMs ?? 15000,
              state: params.state ?? "visible"
            });
            return { waitedForTarget: params.target.id ?? null };
          }

          throw new Error(`Could not wait for unresolved target ${params.target?.id ?? "unknown"}`);
        }
        case "extractFromTarget": {
          const locator =
            (await this.#resolveLocatorFromTarget(page, params.target))
            ?? (await this.#resolveLocatorFromTargetQuery(page, params.targetQuery));
          if (locator) {
            const inputValue = await locator.inputValue().catch(() => null);
            if (inputValue !== null) {
              return { text: inputValue, resolvedTarget: params.target };
            }
            return {
              text: (await locator.textContent())?.trim() ?? params.target?.text ?? "",
              resolvedTarget: params.target
            };
          }

          return { text: params.target?.text ?? "", resolvedTarget: params.target, resolutionMode: "snapshot" };
        }
        default:
          throw new Error(`Unsupported browser action: ${step.action}`);
      }
    } catch (error) {
      throw new RecoverableError(error.message, { step, originalName: error.name });
    }
  }

  async verify({
    workspace,
    expectation = {}
  }: {
    workspace: WorkspaceRecord;
    expectation?: Record<string, unknown>;
  }) {
    const page = await this.#page(workspace);
    const details: Record<string, unknown> = {};
    const check = expectation;

    if (typeof check.urlIncludes === "string" && check.urlIncludes) {
      details.url = page.url();
      if (!page.url().includes(check.urlIncludes)) {
        return { ok: false, details };
      }
    }

    if (typeof check.titleContains === "string" && check.titleContains) {
      const title = await page.title().catch(() => "");
      details.title = title;
      if (!title.includes(check.titleContains)) {
        return { ok: false, details };
      }
    }

    if (typeof check.selectorVisible === "string" && check.selectorVisible) {
      const visible = await page.locator(check.selectorVisible).first().isVisible().catch(() => false);
      details.selectorVisible = visible;
      if (!visible) {
        return { ok: false, details };
      }
    }

    if (typeof check.textVisible === "string" && check.textVisible) {
      const visible = await this.#hasVisibleOrEditableText(page, check.textVisible);
      details.textVisible = visible.textVisible;
      details.inputValueVisible = visible.inputValueVisible;
      if (!visible.textVisible && !visible.inputValueVisible) {
        return { ok: false, details };
      }
    }

    const targetVisible = check.targetVisible as { text?: string } | undefined;
    if (typeof targetVisible?.text === "string" && targetVisible.text) {
      const visible = await page.getByText(targetVisible.text, { exact: false }).first().isVisible().catch(() => false);
      details.targetVisible = visible;
      if (!visible) {
        return { ok: false, details };
      }
    }

    const selectorText = check.selectorText as { selector?: string; equals?: string } | undefined;
    if (typeof selectorText?.selector === "string" && selectorText.selector) {
      const content = (await page.locator(selectorText.selector).textContent())?.trim() ?? "";
      details.selectorText = content;
      if (content !== selectorText.equals) {
        return { ok: false, details };
      }
    }

    if (typeof check.fileExists === "string" && check.fileExists) {
      const filePath = resolveWorkspacePath(workspace, check.fileExists);
      try {
        await fs.access(filePath);
        details.fileExists = true;
      } catch {
        return { ok: false, details: { ...details, fileExists: false, filePath } };
      }
    }

    if (check.readyState != null) {
      const readyState = await page.evaluate(() => document.readyState).catch(() => null);
      details.readyState = readyState;
      if (readyState !== check.readyState) {
        return { ok: false, details };
      }
    }

    if (check.navigationOccurred === true) {
      details.navigationOccurred = true;
    }

    if (check.fileSaved === true) {
      const artifactEntries = await fs.readdir(workspace.artifactsPath).catch(() => []);
      details.fileSaved = artifactEntries.length > 0;
      if (!details.fileSaved) {
        return { ok: false, details };
      }
    }

    return { ok: true, details };
  }

  async shutdown() {
    for (const runtime of this.runtimes.values()) {
      if (runtime.stagehand) {
        await runtime.stagehand.close().catch(() => null);
      }
      if (runtime.mode === "managed_profile") {
        await runtime.browser.close().catch(() => null);
      }
      if (runtime.process && !runtime.process.killed) {
        runtime.process.kill("SIGKILL");
      }
    }

    for (const launchProfile of this.launchProfiles.values()) {
      await fs.rm(launchProfile.userDataDir, { recursive: true, force: true }).catch(() => null);
    }

    this.runtimes.clear();
    this.launchProfiles.clear();
  }
}
