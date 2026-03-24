import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { NativeSidecarClient } from "../native-sidecar.js";
import { defaultDataDir } from "../../config.js";
import type {
  SidecarAccessibilitySnapshotResult,
  SidecarFindTextResult,
  SidecarHealthResult,
  SidecarListWindowsResult,
  SidecarOcrOptions,
  SidecarOcrResult,
  SidecarPermissionsResult
} from "../../types/native-sidecar.js";

const execFileAsync = promisify(execFile);

function escapeAppleScript(text: string): string {
  return String(text).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function buildAccessibilitySnapshotScript(appName: string) {
  const appNameLiteral = JSON.stringify(String(appName ?? "").trim());
  return `
const targetApp = ${appNameLiteral};
function safe(fn, fallback) {
  try {
    const value = fn();
    return value === undefined || value === null ? fallback : value;
  } catch (_error) {
    return fallback;
  }
}

function toArray(collection) {
  if (!collection) {
    return [];
  }
  return safe(() => collection(), []);
}
function text(value) {
  const raw = value === undefined || value === null ? "" : String(value);
  return raw.trim();
}
function readBounds(element) {
  const position = safe(() => element.position(), null);
  const size = safe(() => element.size(), null);
  if (!position || !size || position.length < 2 || size.length < 2) {
    return null;
  }
  const x = Number(position[0]);
  const y = Number(position[1]);
  const width = Number(size[0]);
  const height = Number(size[1]);
  if (![x, y, width, height].every(Number.isFinite)) {
    return null;
  }
  return {
    x,
    y,
    width,
    height,
    centerX: x + width / 2,
    centerY: y + height / 2
  };
}
function actionNames(element) {
  return toArray(safe(() => element.actions, null))
    .map((action) => text(safe(() => action.name(), "")))
    .filter(Boolean);
}
function serializeElement(element, index, windowTitle) {
  return {
    id: "ax-" + index,
    role: text(safe(() => element.role(), "")),
    subrole: text(safe(() => element.subrole(), "")) || null,
    title: text(safe(() => element.title(), "")) || null,
    value: text(safe(() => element.value(), "")) || null,
    description: text(safe(() => element.description(), "")) || null,
    enabled: Boolean(safe(() => element.enabled(), true)),
    focused: Boolean(safe(() => element.focused(), false)),
    actions: actionNames(element),
    windowTitle: text(windowTitle) || null,
    bounds: readBounds(element)
  };
}
const systemEvents = Application("System Events");
const process = systemEvents.processes.byName(targetApp);
const windows = toArray(safe(() => process.windows, null));
const serializedWindows = windows.map((window) => ({
  title: text(safe(() => window.name(), "")),
  bounds: readBounds(window)
}));
const elements = [];
let nextIndex = 1;
windows.forEach((window) => {
  const windowTitle = text(safe(() => window.name(), ""));
  const content = [window].concat(toArray(safe(() => window.entireContents, null)));
  content.forEach((element) => {
    const serialized = serializeElement(element, nextIndex, windowTitle);
    nextIndex += 1;
    elements.push(serialized);
  });
});
JSON.stringify({
  appName: targetApp,
  windows: serializedWindows,
  elements: elements.slice(0, 400)
});
`.trim();
}

function buildFrontmostAppSwiftScript() {
  return `
import AppKit
import Foundation

let appName = NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
let bundleIdentifier = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
let payload: [String: String] = [
  "appName": appName,
  "bundleIdentifier": bundleIdentifier
]
let data = try JSONSerialization.data(withJSONObject: payload, options: [])
FileHandle.standardOutput.write(data)
`.trim();
}

function buildListWindowsSwiftScript() {
  return `
import CoreGraphics
import Foundation

func number(_ value: Any?) -> Double? {
  switch value {
  case let number as NSNumber:
    return number.doubleValue
  case let value as Double:
    return value
  case let value as Int:
    return Double(value)
  default:
    return nil
  }
}

var windows: [[String: Any]] = []
if let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] {
  for entry in info {
    let ownerName = entry[kCGWindowOwnerName as String] as? String ?? ""
    let windowName = entry[kCGWindowName as String] as? String ?? ""
    let layer = Int(number(entry[kCGWindowLayer as String]) ?? -1)
    let alpha = number(entry[kCGWindowAlpha as String]) ?? 0
    if ownerName.isEmpty || layer != 0 || alpha <= 0 {
      continue
    }
    let windowNumber = Int(number(entry[kCGWindowNumber as String]) ?? -1)
    let ownerPID = Int(number(entry[kCGWindowOwnerPID as String]) ?? -1)
    let boundsValue = entry[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let x = number(boundsValue["X"]) ?? 0
    let y = number(boundsValue["Y"]) ?? 0
    let width = number(boundsValue["Width"]) ?? 0
    let height = number(boundsValue["Height"]) ?? 0
    windows.append([
      "ownerName": ownerName,
      "windowName": windowName,
      "ownerPID": ownerPID,
      "windowNumber": windowNumber,
      "layer": layer,
      "alpha": alpha,
      "bounds": [
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "centerX": x + width / 2,
        "centerY": y + height / 2
      ]
    ])
  }
}

let payload: [String: Any] = ["windows": windows]
let data = try JSONSerialization.data(withJSONObject: payload, options: [])
FileHandle.standardOutput.write(data)
`.trim();
}

function buildPermissionsSwiftScript() {
  return `
import ApplicationServices
import CoreGraphics
import Foundation

let payload: [String: Any] = [
  "accessibility": AXIsProcessTrusted(),
  "screenRecording": CGPreflightScreenCaptureAccess()
]
let data = try JSONSerialization.data(withJSONObject: payload, options: [])
FileHandle.standardOutput.write(data)
`.trim();
}

function isUsableFrontmostApp(payload: { appName?: string; bundleIdentifier?: string } | null | undefined) {
  const appName = String(payload?.appName ?? "").trim();
  const bundleIdentifier = String(payload?.bundleIdentifier ?? "").trim();
  if (!appName) {
    return false;
  }
  if (appName === "loginwindow" || bundleIdentifier === "com.apple.loginwindow") {
    return false;
  }
  return true;
}

function buildOcrSwiftScript(filePath: string, options: SidecarOcrOptions = {}) {
  const normalizedPath = JSON.stringify(String(filePath ?? "").trim());
  const region = options.region ?? null;
  const scale = Number(options.scale ?? 0);
  return `
import Foundation
import Vision
import ImageIO
import CoreGraphics

let filePath = ${normalizedPath}
let cropX = CGFloat(${Number(region?.x ?? -1)})
let cropY = CGFloat(${Number(region?.y ?? -1)})
let cropWidth = CGFloat(${Number(region?.width ?? -1)})
let cropHeight = CGFloat(${Number(region?.height ?? -1)})
let requestedScale = CGFloat(${Number.isFinite(scale) && scale > 0 ? scale : 1})

func boxDictionary(_ box: CGRect, width: CGFloat, height: CGFloat, offsetX: CGFloat, offsetY: CGFloat, scale: CGFloat) -> [String: Double] {
  let effectiveScale = scale > 0 ? scale : 1
  let rect = CGRect(
    x: offsetX + ((box.origin.x * width) / effectiveScale),
    y: offsetY + (((1 - box.origin.y - box.size.height) * height) / effectiveScale),
    width: (box.size.width * width) / effectiveScale,
    height: (box.size.height * height) / effectiveScale
  )
  return [
    "x": Double(rect.origin.x),
    "y": Double(rect.origin.y),
    "width": Double(rect.size.width),
    "height": Double(rect.size.height),
    "centerX": Double(rect.midX),
    "centerY": Double(rect.midY)
  ]
}

func cropImage(_ image: CGImage, region: CGRect) -> CGImage? {
  let width = CGFloat(image.width)
  let height = CGFloat(image.height)
  var cropRect = CGRect(
    x: max(0, min(width - 1, region.origin.x * width)),
    y: max(0, min(height - 1, region.origin.y * height)),
    width: max(1, min(width, region.size.width * width)),
    height: max(1, min(height, region.size.height * height))
  )
  cropRect.origin.x = min(cropRect.origin.x, width - cropRect.size.width)
  cropRect.origin.y = min(cropRect.origin.y, height - cropRect.size.height)
  return image.cropping(to: cropRect)
}

func scaleImage(_ image: CGImage, scale: CGFloat) -> CGImage? {
  if scale <= 1.01 {
    return image
  }
  let width = max(1, Int(CGFloat(image.width) * scale))
  let height = max(1, Int(CGFloat(image.height) * scale))
  guard
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
    let context = CGContext(
      data: nil,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: 0,
      space: colorSpace,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )
  else {
    return image
  }
  context.interpolationQuality = .high
  context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  return context.makeImage()
}

let url = URL(fileURLWithPath: filePath)
guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), let baseImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
  let data = try JSONSerialization.data(withJSONObject: ["observations": []], options: [])
  FileHandle.standardOutput.write(data)
  exit(0)
}

var workingImage = baseImage
var offsetX: CGFloat = 0
var offsetY: CGFloat = 0
let scaleFactor = max(CGFloat(1), requestedScale)

if cropWidth > 0 && cropHeight > 0 {
  var normalized = CGRect(
    x: max(CGFloat(0), min(CGFloat(1), cropX)),
    y: max(CGFloat(0), min(CGFloat(1), cropY)),
    width: max(CGFloat(0.01), min(CGFloat(1), cropWidth)),
    height: max(CGFloat(0.01), min(CGFloat(1), cropHeight))
  )
  if normalized.origin.x + normalized.size.width > 1 {
    normalized.size.width = max(CGFloat(0.01), CGFloat(1) - normalized.origin.x)
  }
  if normalized.origin.y + normalized.size.height > 1 {
    normalized.size.height = max(CGFloat(0.01), CGFloat(1) - normalized.origin.y)
  }
  offsetX = normalized.origin.x * CGFloat(baseImage.width)
  offsetY = normalized.origin.y * CGFloat(baseImage.height)
  if let cropped = cropImage(baseImage, region: normalized) {
    workingImage = cropped
  }
}

if let scaled = scaleImage(workingImage, scale: scaleFactor) {
  workingImage = scaled
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
let handler = VNImageRequestHandler(cgImage: workingImage, options: [:])
do {
  try handler.perform([request])
} catch {
  let data = try JSONSerialization.data(withJSONObject: ["observations": []], options: [])
  FileHandle.standardOutput.write(data)
  exit(0)
}

let width = CGFloat(workingImage.width)
let height = CGFloat(workingImage.height)
let observations = (request.results ?? []).compactMap { observation -> [String: Any]? in
  guard let candidate = observation.topCandidates(1).first else {
    return nil
  }
  return [
    "text": candidate.string,
    "confidence": candidate.confidence,
    "box": boxDictionary(
      observation.boundingBox,
      width: width,
      height: height,
      offsetX: offsetX,
      offsetY: offsetY,
      scale: scaleFactor
    )
  ]
}

let payload: [String: Any] = ["observations": observations]
let data = try JSONSerialization.data(withJSONObject: payload, options: [])
FileHandle.standardOutput.write(data)
`.trim();
}

export interface MacOSHostBridgeOptions {
  dataDir?: string;
  sidecarExecutablePath?: string | null;
  sidecarArgs?: string[];
}

interface SidecarRequestOptions {
  timeoutMs?: number;
  resetSidecarOnFailure?: boolean;
}

export class MacOSHostBridge {
  sidecar: NativeSidecarClient;

  constructor(options: MacOSHostBridgeOptions = {}) {
    const dataDir = options.dataDir ?? defaultDataDir();
    this.sidecar = new NativeSidecarClient({
      dataDir,
      executablePath: options.sidecarExecutablePath ?? process.env.AGENTOS_NATIVE_SIDECAR,
      args: options.sidecarArgs ?? []
    });
  }

  async captureScreen(filePath: string, windowNumber?: number | null): Promise<unknown> {
    return this.#requestSidecar("capture_screen", { filePath, ...(windowNumber ? { windowNumber } : {}) }, async () => {
      const args = ["-x"];
      if (windowNumber) {
        args.push("-o", "-l", String(windowNumber));
      }
      args.push(filePath);
      await execFileAsync("screencapture", args);
      return { filePath, windowNumber: windowNumber ?? null };
    }, { timeoutMs: 1200 });
  }

  async launchApp(name: string): Promise<unknown> {
    return this.#requestSidecar("launch_app", { name }, async () => {
      await execFileAsync("open", ["-a", name]);
      return { launched: name };
    }, { timeoutMs: 1200 });
  }

  async focusApp(name: string): Promise<unknown> {
    return this.#requestSidecar("focus_app", { name }, async () => {
      await execFileAsync("open", ["-a", name]);
      await execFileAsync("osascript", [
        "-e",
        `tell application "${escapeAppleScript(name)}" to activate`
      ]);
      await execFileAsync("osascript", [
        "-e",
        `tell application "System Events" to set frontmost of process "${escapeAppleScript(name)}" to true`
      ]);
      return { focused: name };
    }, { timeoutMs: 900 });
  }

  async getFrontmostApp(): Promise<unknown> {
    const swiftFallback = async () => {
      const { stdout } = await execFileAsync("swift", ["-e", buildFrontmostAppSwiftScript()], {
        maxBuffer: 1024 * 1024
      });
      const payload = JSON.parse(stdout.trim() || "{}") as { appName?: string; bundleIdentifier?: string };
      return {
        appName: String(payload.appName ?? "").trim(),
        bundleIdentifier: String(payload.bundleIdentifier ?? "").trim()
      };
    };
    const result = await this.#requestSidecar<Record<string, unknown>>("frontmost_app", {}, swiftFallback, { timeoutMs: 700 });
    if (isUsableFrontmostApp(result as { appName?: string; bundleIdentifier?: string })) {
      return result;
    }
    const windows = await this.listWindows().catch(() => ({ windows: [] }));
    const firstWindow = Array.isArray(windows?.windows) ? windows.windows[0] : null;
    if (firstWindow && String(firstWindow.ownerName ?? "").trim()) {
      return {
        appName: String(firstWindow.ownerName ?? "").trim(),
        bundleIdentifier: ""
      };
    }
    return swiftFallback();
  }

  async getPermissionsStatus(): Promise<SidecarPermissionsResult> {
    return this.#requestSidecar<SidecarPermissionsResult>("permissions_status", {}, async () => {
      const { stdout } = await execFileAsync("swift", ["-e", buildPermissionsSwiftScript()], {
        maxBuffer: 1024 * 1024
      });
      const payload = JSON.parse(stdout.trim() || "{}") as Partial<SidecarPermissionsResult>;
      return {
        accessibility: Boolean(payload.accessibility),
        screenRecording: Boolean(payload.screenRecording)
      };
    }, { timeoutMs: 1500 });
  }

  async listWindows(): Promise<SidecarListWindowsResult> {
    const fallback = async () => {
      const { stdout } = await execFileAsync("swift", ["-e", buildListWindowsSwiftScript()], {
        maxBuffer: 1024 * 1024 * 8
      });
      const payload = JSON.parse(stdout.trim() || "{}") as Partial<SidecarListWindowsResult>;
      return {
        windows: Array.isArray(payload.windows) ? payload.windows : []
      };
    };
    const result = await this.#requestSidecar<SidecarListWindowsResult>("list_windows", {}, fallback, { timeoutMs: 1500 });
    if (Array.isArray(result?.windows) && result.windows.length > 0) {
      return result;
    }
    return fallback();
  }

  async getAccessibilitySnapshot(appName: string): Promise<SidecarAccessibilitySnapshotResult> {
    const normalizedAppName = String(appName ?? "").trim();
    if (!normalizedAppName) {
      return {
        appName: "",
        windows: [],
        elements: []
      };
    }

    return this.#requestSidecar<SidecarAccessibilitySnapshotResult>(
      "accessibility_snapshot",
      { appName: normalizedAppName },
      async () => {
        const { stdout } = await execFileAsync(
          "osascript",
          ["-l", "JavaScript", "-e", buildAccessibilitySnapshotScript(normalizedAppName)],
          {
            maxBuffer: 1024 * 1024 * 8
          }
        );
        const payload = JSON.parse(stdout.trim() || "{}") as Partial<SidecarAccessibilitySnapshotResult>;
        return {
          appName: String(payload.appName ?? normalizedAppName),
          windows: Array.isArray(payload.windows) ? payload.windows : [],
          elements: Array.isArray(payload.elements) ? payload.elements : []
        };
      },
      { timeoutMs: 1800 }
    );
  }

  async typeText(text: string): Promise<unknown> {
    return this.#requestSidecar("type_text", { text }, null);
  }

  async pasteText(text: string): Promise<unknown> {
    const previousClipboard = await this.#readClipboardText();
    await this.#writeClipboardText(text);
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      const result = await this.pressKey("v", ["cmd"]);
      await new Promise((resolve) => setTimeout(resolve, 150));
      return result;
    } finally {
      if (previousClipboard !== null) {
        await this.#writeClipboardText(previousClipboard).catch(() => null);
      }
    }
  }

  async pressKey(key: string, modifiers: string[] = []): Promise<unknown> {
    return this.#requestSidecar("key_press", { key, modifiers }, null);
  }

  async clickAt(x: number, y: number): Promise<unknown> {
    return this.#requestSidecar("click_at", { x, y }, null);
  }

  async moveMouse(x: number, y: number): Promise<unknown> {
    return this.#requestSidecar("move_mouse", { x, y }, null);
  }

  async scroll(dx: number, dy: number): Promise<unknown> {
    return this.#requestSidecar("scroll", { dx, dy }, null);
  }

  async ocrImage(filePath: string, options: SidecarOcrOptions = {}): Promise<SidecarOcrResult> {
    const region = options.region ?? null;
    const scale = Number(options.scale ?? 0);
    return this.#requestSidecar<SidecarOcrResult>(
      "ocr_image",
      {
        filePath,
        ...(region ? { region } : {}),
        ...(Number.isFinite(scale) && scale > 0 ? { scale } : {})
      },
      async () => {
        const { stdout } = await execFileAsync("swift", ["-e", buildOcrSwiftScript(filePath, options)], {
          maxBuffer: 1024 * 1024 * 8
        });
        const payload = JSON.parse(stdout.trim() || "{}") as Partial<SidecarOcrResult>;
        return {
          observations: Array.isArray(payload.observations) ? payload.observations : []
        };
      },
      { timeoutMs: 3500 }
    );
  }

  async findText(filePath: string, query: string): Promise<SidecarFindTextResult> {
    return this.#requestSidecar<SidecarFindTextResult>("find_text", { filePath, query }, null, { timeoutMs: 2500 });
  }

  async sidecarHealth(): Promise<SidecarHealthResult> {
    return this.sidecar.request<SidecarHealthResult>("health", {});
  }

  async runCommand(command: string, cwd = process.cwd()): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFileAsync("zsh", ["-lc", command], {
      cwd
    });
    return { stdout, stderr };
  }

  async #readClipboardText(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("pbpaste", [], {
        maxBuffer: 1024 * 1024 * 8
      });
      return stdout;
    } catch {
      return null;
    }
  }

  async #writeClipboardText(text: string): Promise<void> {
    await execFileAsync("zsh", ["-lc", "printf %s \"$AGENTOS_PASTE_TEXT\" | pbcopy"], {
      env: {
        ...process.env,
        AGENTOS_PASTE_TEXT: text
      },
      maxBuffer: 1024 * 1024 * 8
    });
  }

  async shutdown(): Promise<void> {
    await this.sidecar.shutdown();
  }

  async #requestSidecar<TResult>(
    method: string,
    params: Record<string, unknown>,
    fallback: (() => Promise<TResult>) | null,
    { timeoutMs = 15000, resetSidecarOnFailure = true }: SidecarRequestOptions = {}
  ): Promise<TResult> {
    if (await this.sidecar.isAvailable()) {
      try {
        return await this.sidecar.request<TResult>(method, params, { timeoutMs });
      } catch {
        if (resetSidecarOnFailure) {
          await this.sidecar.shutdown().catch(() => null);
        }
        if (fallback) {
          return fallback();
        }
        throw new Error(`Rust sidecar request failed for ${method}.`);
      }
    }

    if (!fallback) {
      throw new Error(`No fallback is available for ${method}.`);
    }

    return fallback();
  }
}
