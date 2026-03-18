import fs from "node:fs/promises";
import path from "node:path";

import { SurfaceAdapter } from "./surface-adapter.js";
import { MacOSHostBridge } from "../host-bridges/macos-bridge.js";
import { WindowsHostBridge } from "../host-bridges/windows-bridge.js";
import { createInteractionCandidate, createWorldState, normalizeBounds, normalizeOcrBlocks, summarizeRecentActions } from "../world-state.js";
import type { BoundsLike } from "../world-state.js";
import type { SidecarAccessibilityElementInfo, SidecarAccessibilitySnapshotResult } from "../../types/native-sidecar.js";

function pickBridge(options) {
  if (process.platform === "darwin") {
    return new MacOSHostBridge(options);
  }

  if (process.platform === "win32") {
    return new WindowsHostBridge(options);
  }

  return null;
}

function resolveWorkspacePath(workspace, targetPath) {
  const raw = String(targetPath ?? "").trim();
  if (!raw) {
    throw new Error("File path is required.");
  }

  return path.isAbsolute(raw) ? raw : path.resolve(workspace.rootPath, raw);
}

function resolveAppName(params: Record<string, unknown>) {
  const name = typeof params.name === "string" && params.name.trim() ? params.name : null;
  if (name) {
    return name;
  }

  const appName = typeof params.appName === "string" && params.appName.trim() ? params.appName : null;
  return appName;
}

function uniqueStrings(values: unknown[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (!text) {
      continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(text);
  }
  return result;
}

function normalizeAppKey(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function pointWithinBounds(x: number, y: number, bounds: { x: number; y: number; width: number; height: number }) {
  return x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height;
}

function filterOcrBlocksToFrontmostWindows({
  ocrBlocks,
  frontmostApp,
  windows
}: {
  ocrBlocks: Array<{ text?: string; bounds?: { centerX?: number; centerY?: number } }>;
  frontmostApp: Record<string, unknown> | null;
  windows: Array<Record<string, unknown>>;
}) {
  const appKey = normalizeAppKey(frontmostApp?.appName);
  if (!appKey) {
    return ocrBlocks;
  }

  const matchingWindows = windows.filter((windowInfo) => {
    const ownerName = normalizeAppKey(windowInfo.ownerName);
    const windowName = normalizeAppKey(windowInfo.windowName);
    return ownerName.includes(appKey) || windowName.includes(appKey);
  });

  if (!matchingWindows.length) {
    return ocrBlocks;
  }

  const filtered = ocrBlocks.filter((block) => {
    const centerX = Number(block?.bounds?.centerX);
    const centerY = Number(block?.bounds?.centerY);
    if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) {
      return false;
    }

    return matchingWindows.some((windowInfo) => {
      const bounds = windowInfo.bounds as { x: number; y: number; width: number; height: number } | undefined;
      if (!bounds) {
        return false;
      }
      return pointWithinBounds(centerX, centerY, bounds);
    });
  });

  return filtered.length ? filtered : ocrBlocks;
}

function normalizeAccessibilityRole(role: unknown, subrole: unknown) {
  const roleKey = String(role ?? "").trim().toLowerCase();
  const subroleKey = String(subrole ?? "").trim().toLowerCase();

  if (roleKey.includes("text area") || roleKey.includes("text field") || roleKey.includes("search field")) {
    return "textbox";
  }
  if (roleKey.includes("button")) {
    return "button";
  }
  if (roleKey.includes("link")) {
    return "link";
  }
  if (roleKey.includes("row")) {
    return "row";
  }
  if (roleKey.includes("checkbox")) {
    return "checkbox";
  }
  if (roleKey.includes("static text") || roleKey.includes("text")) {
    return "text";
  }
  if (roleKey.includes("group") && subroleKey.includes("text")) {
    return "text";
  }

  return roleKey || null;
}

function accessibilityElementText(element: SidecarAccessibilityElementInfo) {
  const values = uniqueStrings([element.title, element.value, element.description]);
  return values[0] ?? "";
}

function isAccessibilityElementInteractive(element: SidecarAccessibilityElementInfo, role: string | null) {
  const actions = Array.isArray(element.actions) ? element.actions.map((entry) => String(entry ?? "").toLowerCase()) : [];
  if (actions.some((action) => action.includes("press") || action.includes("confirm"))) {
    return true;
  }

  return ["textbox", "button", "link", "row", "checkbox"].includes(String(role ?? "").toLowerCase());
}

function createAccessibilityCandidates(snapshot: SidecarAccessibilitySnapshotResult | null, surface = "desktop") {
  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : [];
  return elements
    .map((element, index) => {
      const role = normalizeAccessibilityRole(element.role, element.subrole);
      const text = accessibilityElementText(element);
      const bounds = element.bounds ? normalizeBounds(element.bounds as BoundsLike) : null;
      if (!text || !bounds) {
        return null;
      }

      return createInteractionCandidate(
        {
          id: element.id ?? `${surface}-ax-${index + 1}`,
          kind: "element",
          text,
          role,
          bounds,
          confidence: 0.98,
          sourceHints: {
            source: "accessibility",
            ariaLabel: element.title ?? "",
            placeholder: element.description ?? "",
            value: element.value ?? "",
            roleDescription: element.subrole ?? "",
            actions: Array.isArray(element.actions) ? element.actions : [],
            windowTitle: element.windowTitle ?? "",
            axRole: element.role ?? "",
            axSubrole: element.subrole ?? "",
            focused: Boolean(element.focused),
            enabled: element.enabled !== false
          },
          isInteractive: isAccessibilityElementInteractive(element, role)
        },
        index,
        surface
      );
    })
    .filter(Boolean);
}

function dedupeInteractionCandidates(candidates: Array<Record<string, unknown>>) {
  const seen = new Set<string>();
  const result: Array<Record<string, unknown>> = [];
  for (const candidate of candidates) {
    const bounds = (candidate.bounds ?? {}) as Record<string, unknown>;
    const key = [
      String(candidate.text ?? "").trim().toLowerCase(),
      String(candidate.role ?? "").trim().toLowerCase(),
      Math.round(Number(bounds.centerX ?? 0)),
      Math.round(Number(bounds.centerY ?? 0))
    ].join(":");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

export class DesktopSurfaceAdapter extends SurfaceAdapter {
  artifactStore: any;
  bridge: any;
  constructor({ artifactStore, dataDir }) {
    super("desktop");
    this.artifactStore = artifactStore;
    this.bridge = pickBridge({ dataDir });
  }

  #requireBridge() {
    if (!this.bridge) {
      throw new Error(`Desktop automation is not available on ${process.platform}.`);
    }

    return this.bridge;
  }

  #createCandidates(ocrBlocks) {
    return ocrBlocks.map((block, index) =>
      createInteractionCandidate(
        {
          id: block.id ?? `desktop-candidate-${index + 1}`,
          kind: "text",
          text: block.text,
          role: "text",
          bounds: block.bounds,
          confidence: block.confidence ?? 0.65,
          sourceHints: { source: "ocr" },
          isInteractive: true
        },
        index,
        "desktop"
      )
    );
  }

  #visibleText(accessibilityCandidates, ocrBlocks) {
    return uniqueStrings([
      ...accessibilityCandidates.map((candidate) => candidate.text),
      ...ocrBlocks.map((block) => block.text)
    ])
      .join("\n")
      .slice(0, 4000);
  }

  async discover() {
    return this.#requireBridge().getFrontmostApp();
  }

  async observe({ task, workspace, traceId, label = "desktop-observe", recentActions = [] }) {
    const bridge = this.#requireBridge();
    const capture = await this.capture({ task, workspace, traceId, label });
    const [frontmostApp, ocr, windows, permissions] = await Promise.all([
      bridge.getFrontmostApp(),
      bridge.ocrImage(capture.path),
      typeof bridge.listWindows === "function"
        ? bridge.listWindows().catch(() => ({ windows: [] }))
        : { windows: [] },
      typeof bridge.getPermissionsStatus === "function"
        ? bridge.getPermissionsStatus().catch(() => null)
        : null
    ]);
    const accessibility =
      typeof bridge.getAccessibilitySnapshot === "function" && frontmostApp?.appName
        ? await bridge.getAccessibilitySnapshot(String(frontmostApp.appName)).catch(() => null)
        : null;
    const ocrBlocks = filterOcrBlocksToFrontmostWindows({
      ocrBlocks: normalizeOcrBlocks(ocr.observations ?? [], "desktop"),
      frontmostApp: (frontmostApp ?? null) as Record<string, unknown> | null,
      windows: Array.isArray(windows.windows) ? (windows.windows as Array<Record<string, unknown>>) : []
    });
    const accessibilityCandidates = createAccessibilityCandidates(accessibility, "desktop");
    const interactionCandidates = dedupeInteractionCandidates([
      ...accessibilityCandidates,
      ...this.#createCandidates(ocrBlocks)
    ]);
    const visibleText = this.#visibleText(accessibilityCandidates, ocrBlocks);

    return createWorldState({
      surface: "desktop",
      workspaceId: workspace.id,
      appContext: {
        ...frontmostApp,
        windows: windows.windows ?? [],
        permissions,
        accessibility
      },
      capture,
      ocrBlocks,
      interactionCandidates,
      visibleText,
      recentActions: summarizeRecentActions(recentActions),
      summary: `${frontmostApp.appName} with ${accessibilityCandidates.length} accessibility candidates and ${ocrBlocks.length} OCR observations across ${(windows.windows ?? []).length} windows`
    });
  }

  async capture({ task, workspace, traceId, label = "desktop-capture" }) {
    const bridge = this.#requireBridge();
    const filePath = path.join(workspace.artifactsPath, `${Date.now()}-${label.replaceAll(/\s+/g, "-")}.png`);
    await bridge.captureScreen(filePath);
    return this.artifactStore.registerExistingFile({
      taskId: task.id,
      traceId,
      kind: "screenshot",
      label,
      filePath,
      metadata: { surface: "desktop" }
    });
  }

  async focus(args: { step?: { params?: Record<string, unknown> } } = {}) {
    const bridge = this.#requireBridge();
    const step = args.step;
    const appName = step?.params ? resolveAppName(step.params) : null;
    if (appName) {
      return bridge.focusApp(appName);
    }

    return { focused: false };
  }

  async act({ task, step, workspace, traceId }) {
    const params = step.params ?? {};

    switch (step.action) {
      case "readFileText": {
        const filePath = resolveWorkspacePath(workspace, params.path);
        return { path: filePath, text: await fs.readFile(filePath, "utf8") };
      }
      case "writeFileText": {
        const filePath = resolveWorkspacePath(workspace, params.path);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, String(params.text ?? ""), "utf8");
        return { path: filePath, written: true };
      }
      case "appendFileText": {
        const filePath = resolveWorkspacePath(workspace, params.path);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.appendFile(filePath, String(params.text ?? ""), "utf8");
        return { path: filePath, appended: true };
      }
      case "moveFile": {
        const fromPath = resolveWorkspacePath(workspace, params.from);
        const toPath = resolveWorkspacePath(workspace, params.to);
        await fs.mkdir(path.dirname(toPath), { recursive: true });
        await fs.rename(fromPath, toPath);
        return { fromPath, toPath, moved: true };
      }
      case "copyFile": {
        const fromPath = resolveWorkspacePath(workspace, params.from);
        const toPath = resolveWorkspacePath(workspace, params.to);
        await fs.mkdir(path.dirname(toPath), { recursive: true });
        await fs.copyFile(fromPath, toPath);
        return { fromPath, toPath, copied: true };
      }
      case "listFiles": {
        const dirPath = resolveWorkspacePath(workspace, params.path ?? ".");
        return { path: dirPath, entries: await fs.readdir(dirPath) };
      }
    }

    const bridge = this.#requireBridge();

    switch (step.action) {
      case "launchApp": {
        const appName = resolveAppName(params);
        if (!appName) {
          throw new Error("launchApp requires a name or appName parameter.");
        }
        return bridge.launchApp(appName);
      }
      case "focusApp": {
        const appName = resolveAppName(params);
        if (!appName) {
          throw new Error("focusApp requires a name or appName parameter.");
        }
        return bridge.focusApp(appName);
      }
      case "typeText":
        return bridge.typeText(params.text ?? "");
      case "pressKey":
        return bridge.pressKey(params.key, params.modifiers ?? []);
      case "moveMouse":
        return bridge.moveMouse(params.x, params.y);
      case "clickAt":
        return bridge.clickAt(params.x, params.y);
      case "scroll":
      case "scrollSurface":
        return bridge.scroll(params.dx ?? 0, params.dy ?? 0);
      case "clickText": {
        const capture = await this.capture({ task, workspace, traceId, label: `ocr-${step.id}` });
        const result = await bridge.findText(capture.path, params.text);
        if (!result.found) {
          throw new Error(`Could not locate text "${params.text}" on screen.`);
        }
        const box = result.match.box;
        await bridge.clickAt(box.centerX, box.centerY);
        return result;
      }
      case "ocrScreen": {
        const capture = await this.capture({ task, workspace, traceId, label: `ocr-${step.id}` });
        return bridge.ocrImage(capture.path);
      }
      case "waitForText": {
        const timeoutMs = params.timeoutMs ?? 10000;
        const pollMs = params.pollMs ?? 500;
        const started = Date.now();

        while (Date.now() - started < timeoutMs) {
          const capture = await this.capture({ task, workspace, traceId, label: `wait-${step.id}` });
          const result = await bridge.findText(capture.path, params.text);
          if (result.found) {
            return result;
          }
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }

        throw new Error(`Timed out waiting for text "${params.text}" on screen.`);
      }
      case "clickTarget":
      case "focusTarget": {
        const target = params.target;
        if (!target?.bounds) {
          throw new Error(`Target ${target?.id ?? "unknown"} is missing bounds.`);
        }
        return bridge.clickAt(target.bounds.centerX, target.bounds.centerY);
      }
      case "typeIntoTarget": {
        const target = params.target;
        if (target?.bounds) {
          await bridge.clickAt(target.bounds.centerX, target.bounds.centerY);
        }
        return bridge.typeText(params.text ?? "");
      }
      case "waitForTarget": {
        const timeoutMs = params.timeoutMs ?? 10000;
        const pollMs = params.pollMs ?? 500;
        const targetText = params.target?.text ?? params.targetQuery;
        const started = Date.now();

        while (Date.now() - started < timeoutMs) {
          const capture = await this.capture({ task, workspace, traceId, label: `wait-target-${step.id}` });
          const result = await bridge.findText(capture.path, targetText);
          if (result.found) {
            return result;
          }
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }

        throw new Error(`Timed out waiting for target "${targetText}".`);
      }
      case "extractFromTarget":
        return { text: params.target?.text ?? "" };
      case "wait":
        await new Promise((resolve) => setTimeout(resolve, params.ms ?? 1000));
        return { waitedMs: params.ms ?? 1000 };
      case "shell":
        return bridge.runCommand(params.command, params.cwd ?? workspace.rootPath);
      case "capture":
        return this.capture({ task, workspace, traceId, label: params.label ?? step.label });
      default:
        throw new Error(`Unsupported desktop action: ${step.action}`);
    }
  }

  async verify({ task, workspace, traceId, expectation = {} }: { task: any; workspace: any; traceId: any; expectation?: any }) {
    const bridge = this.#requireBridge();
    const details: Record<string, any> = {};
    const check = expectation as Record<string, any>;

    if (check.frontmostApp) {
      const frontmost = await bridge.getFrontmostApp();
      details.frontmostApp = frontmost.appName;
      if (!frontmost.appName.includes(check.frontmostApp)) {
        return { ok: false, details };
      }
    }

    if (check.fileExists) {
      try {
        await fs.access(check.fileExists);
        details.fileExists = true;
      } catch {
        return { ok: false, details: { ...details, fileExists: false } };
      }
    }

    const targetText = check.textVisible ?? check.targetVisible?.text;
    if (targetText) {
      const capture = await this.capture({ task, workspace, traceId, label: "verify-text" });
      const result = await bridge.findText(capture.path, targetText);
      details.textVisible = result.found;
      if (!result.found) {
        return { ok: false, details };
      }
      details.textMatch = result.match;
    }

    return { ok: true, details };
  }

  async shutdown() {
    if (typeof this.bridge?.shutdown === "function") {
      await this.bridge.shutdown();
    }
  }
}
