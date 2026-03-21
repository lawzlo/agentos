import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import type { BrowserContext, Locator, Page } from "playwright-core";

import { SurfaceAdapter } from "./surface-adapter.js";
import { RecoverableError } from "../errors.js";
import { createInteractionCandidate, createWorldState, summarizeRecentActions } from "../world-state.js";
import type { ArtifactStore } from "../artifact-store.js";
import type { WorkspaceRecord } from "../../types/runtime-schema.js";

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

export class BrowserSurfaceAdapter extends SurfaceAdapter {
  artifactStore: ArtifactStore;
  browserExecutable: string | null;
  headless: boolean;
  contexts: Map<string, BrowserContext>;
  constructor({
    artifactStore,
    browserExecutable,
    headless
  }: {
    artifactStore: ArtifactStore;
    browserExecutable: string | null;
    headless: boolean;
  }) {
    super("browser");
    this.artifactStore = artifactStore;
    this.browserExecutable = browserExecutable;
    this.headless = headless;
    this.contexts = new Map();
  }

  #contextKey(workspace: WorkspaceRecord): string {
    return workspace.profilePath || workspace.id;
  }

  async #getContext(workspace: WorkspaceRecord): Promise<BrowserContext> {
    const contextKey = this.#contextKey(workspace);
    if (this.contexts.has(contextKey)) {
      return this.contexts.get(contextKey);
    }

    if (!this.browserExecutable) {
      throw new Error("No managed browser executable detected. Set AGENTOS_BROWSER_EXECUTABLE.");
    }

    const context = await chromium.launchPersistentContext(workspace.profilePath, {
      executablePath: this.browserExecutable,
      headless: this.headless,
      acceptDownloads: true,
      downloadsPath: workspace.downloadsPath,
      viewport: { width: 1440, height: 960 },
      args: ["--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check"]
    });

    this.contexts.set(contextKey, context);
    return context;
  }

  async #page(workspace: WorkspaceRecord): Promise<Page> {
    const context = await this.#getContext(workspace);
    const existing = context.pages()[0];
    return existing ?? context.newPage();
  }

  async #collectCandidates(page: Page) {
    const rawCandidates = await page
      .locator("button, a[href], input, textarea, select, [role='button'], [role='textbox'], [contenteditable='true']")
      .evaluateAll((nodes) =>
        nodes.slice(0, 80).map((node) => {
          const element = node;
          const rect = element.getBoundingClientRect();
          return {
            text: (element.textContent || element.getAttribute("value") || "").trim().slice(0, 160),
            tag: element.tagName.toLowerCase(),
            type: element.getAttribute("type"),
            role: element.getAttribute("role"),
            bounds: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              centerX: rect.x + rect.width / 2,
              centerY: rect.y + rect.height / 2
            },
            isInteractive: rect.width > 0 && rect.height > 0,
            sourceHints: {
              tag: element.tagName.toLowerCase(),
              type: element.getAttribute("type"),
              name: element.getAttribute("name"),
              placeholder: element.getAttribute("placeholder"),
              ariaLabel: element.getAttribute("aria-label"),
              title: element.getAttribute("title"),
              href: element.getAttribute("href")
            }
          };
        })
      )
      .catch(() => []);

    return rawCandidates
      .filter((candidate) => candidate.isInteractive)
      .map((candidate, index) =>
        createInteractionCandidate(
          {
            ...candidate,
            id: `browser-candidate-${index + 1}`,
            role: candidate.role || inferRole(candidate),
            confidence: 0.72
          },
          index,
          "browser"
        )
      );
  }

  async #resolveLocatorFromTarget(
    page: Page,
    target: Record<string, unknown> | null | undefined
  ): Promise<Locator | null> {
    const targetText = typeof target?.text === "string" ? target.text : "";
    const hints = (target?.sourceHints ?? {}) as {
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

  async discover({ workspace }) {
    const page = await this.#page(workspace);
    return {
      url: page.url(),
      title: await page.title()
    };
  }

  async observe({ task, workspace, traceId, label = "browser-observe", recentActions = [] }) {
    const page = await this.#page(workspace);
    const [pageText, candidates, capture, title] = await Promise.all([
      page.locator("body").innerText().catch(() => ""),
      this.#collectCandidates(page),
      this.capture({ task, workspace, traceId, label }),
      page.title().catch(() => "")
    ]);

    return createWorldState({
      surface: "browser",
      workspaceId: workspace.id,
      appContext: {
        title,
        url: page.url()
      },
      capture,
      ocrBlocks: [],
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
        case "clickTarget":
        case "focusTarget": {
          const locator = await this.#resolveLocatorFromTarget(page, params.target);
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
          const locator = await this.#resolveLocatorFromTarget(page, params.target);
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
          const locator = await this.#resolveLocatorFromTarget(page, params.target);
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
          const locator = await this.#resolveLocatorFromTarget(page, params.target);
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
    for (const context of this.contexts.values()) {
      await context.close();
    }

    this.contexts.clear();
  }
}
