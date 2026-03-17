import fs from "node:fs/promises";
import path from "node:path";
import { SurfaceAdapter } from "./surface-adapter.js";
import { MacOSHostBridge } from "../host-bridges/macos-bridge.js";
import { WindowsHostBridge } from "../host-bridges/windows-bridge.js";
import { createInteractionCandidate, createWorldState, normalizeOcrBlocks, summarizeRecentActions } from "../world-state.js";
function pickBridge(options) {
    if (process.platform === "darwin") {
        return new MacOSHostBridge(options);
    }
    if (process.platform === "win32") {
        return new WindowsHostBridge(options);
    }
    return null;
}
export class DesktopSurfaceAdapter extends SurfaceAdapter {
    artifactStore;
    bridge;
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
        return ocrBlocks.map((block, index) => createInteractionCandidate({
            id: block.id ?? `desktop-candidate-${index + 1}`,
            kind: "text",
            text: block.text,
            role: "text",
            bounds: block.bounds,
            confidence: block.confidence ?? 0.65,
            sourceHints: { source: "ocr" },
            isInteractive: true
        }, index, "desktop"));
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
        const ocrBlocks = normalizeOcrBlocks(ocr.observations ?? [], "desktop");
        return createWorldState({
            surface: "desktop",
            workspaceId: workspace.id,
            appContext: {
                ...frontmostApp,
                windows: windows.windows ?? [],
                permissions
            },
            capture,
            ocrBlocks,
            interactionCandidates: this.#createCandidates(ocrBlocks),
            visibleText: ocrBlocks.map((block) => block.text).join("\n").slice(0, 4000),
            recentActions: summarizeRecentActions(recentActions),
            summary: `${frontmostApp.appName} with ${ocrBlocks.length} OCR observations across ${(windows.windows ?? []).length} windows`
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
    async focus({ step }) {
        const bridge = this.#requireBridge();
        if (step.params?.name) {
            return bridge.focusApp(step.params.name);
        }
        return { focused: false };
    }
    async act({ task, step, workspace, traceId }) {
        const bridge = this.#requireBridge();
        const params = step.params ?? {};
        switch (step.action) {
            case "launchApp":
                return bridge.launchApp(params.name);
            case "focusApp":
                return bridge.focusApp(params.name);
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
    async verify({ task, workspace, traceId, expectation = {} }) {
        const bridge = this.#requireBridge();
        const details = {};
        const check = expectation;
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
            }
            catch {
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
