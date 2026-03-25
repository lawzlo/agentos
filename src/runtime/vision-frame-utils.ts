import fs from "node:fs/promises";
import type { InteractionCandidate, WorldState } from "../types/runtime-schema.js";

export interface NormalizedVisionBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clampNormalizedUnit(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

export function findDesktopWindowBounds(
  worldState: WorldState | null,
  appName: string
): InteractionCandidate["bounds"] | null {
  const windows = Array.isArray((worldState?.appContext as { windows?: unknown[] } | null)?.windows)
    ? (((worldState?.appContext as { windows?: unknown[] } | null)?.windows ?? []) as Array<Record<string, unknown>>)
    : [];
  const appContext = (worldState?.appContext ?? null) as Record<string, unknown> | null;
  const captureWindowNumber = Number(appContext?.captureWindowNumber ?? NaN);
  const matchesApp = (windowInfo: Record<string, unknown>) => {
    const ownerName = String(windowInfo?.ownerName ?? "");
    const windowName = String(windowInfo?.windowName ?? "");
    return appName && (ownerName.includes(appName) || windowName.includes(appName));
  };
  const captureMatched =
    Number.isFinite(captureWindowNumber) && captureWindowNumber > 0
      ? windows.find((windowInfo) =>
          matchesApp(windowInfo)
          && Number(windowInfo?.windowNumber ?? NaN) === captureWindowNumber
        )
      : null;
  const matched = captureMatched ?? windows.find(matchesApp);
  return (matched?.bounds ?? null) as InteractionCandidate["bounds"] | null;
}

export async function readCaptureImageSize(
  capturePath: string
): Promise<{ width: number; height: number } | null> {
  const imagePath = String(capturePath ?? "").trim();
  if (!imagePath) {
    return null;
  }

  try {
    const handle = await fs.open(imagePath, "r");
    try {
      const header = Buffer.alloc(32);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (bytesRead >= 24 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        const width = header.readUInt32BE(16);
        const height = header.readUInt32BE(20);
        if (width > 0 && height > 0) {
          return { width, height };
        }
      }
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }

  return null;
}

export async function resolveDesktopVisionFrame(
  worldState: WorldState | null,
  appName: string
): Promise<InteractionCandidate["bounds"] | null> {
  const windowBounds = findDesktopWindowBounds(worldState, appName);
  if (windowBounds) {
    return windowBounds;
  }

  const captureSize = await readCaptureImageSize(String(worldState?.capture?.path ?? ""));
  if (captureSize) {
    return {
      x: 0,
      y: 0,
      width: captureSize.width,
      height: captureSize.height,
      centerX: captureSize.width / 2,
      centerY: captureSize.height / 2
    };
  }

  return windowBounds;
}

export async function resolveBrowserVisionFrame(worldState: WorldState | null): Promise<InteractionCandidate["bounds"] | null> {
  const captureWindowBounds = ((worldState?.capture as { metadata?: { windowBounds?: InteractionCandidate["bounds"] } } | null)?.metadata
    ?.windowBounds ?? null) as InteractionCandidate["bounds"] | null;
  if (captureWindowBounds) {
    return captureWindowBounds;
  }

  const captureSize = await readCaptureImageSize(String(worldState?.capture?.path ?? ""));
  if (captureSize) {
    return {
      x: 0,
      y: 0,
      width: captureSize.width,
      height: captureSize.height,
      centerX: captureSize.width / 2,
      centerY: captureSize.height / 2
    };
  }

  return null;
}

export async function resolveDesktopVisionCandidateBounds(
  worldState: WorldState | null,
  appName: string,
  box: NormalizedVisionBox | null
): Promise<InteractionCandidate["bounds"] | undefined> {
  if (!box) {
    return undefined;
  }
  const frame = await resolveDesktopVisionFrame(worldState, appName);
  if (!frame) {
    return undefined;
  }
  const x = Number(frame.x ?? 0) + Number(frame.width ?? 0) * box.x;
  const y = Number(frame.y ?? 0) + Number(frame.height ?? 0) * box.y;
  const width = Number(frame.width ?? 0) * box.width;
  const height = Number(frame.height ?? 0) * box.height;
  return {
    x,
    y,
    width,
    height,
    centerX: x + width / 2,
    centerY: y + height / 2
  };
}

export async function resolveBrowserVisionCandidateBounds(
  worldState: WorldState | null,
  box: NormalizedVisionBox | null
): Promise<InteractionCandidate["bounds"] | undefined> {
  if (!box) {
    return undefined;
  }
  const frame = await resolveBrowserVisionFrame(worldState);
  if (!frame) {
    return undefined;
  }
  const x = Number(frame.x ?? 0) + Number(frame.width ?? 0) * box.x;
  const y = Number(frame.y ?? 0) + Number(frame.height ?? 0) * box.y;
  const width = Number(frame.width ?? 0) * box.width;
  const height = Number(frame.height ?? 0) * box.height;
  return {
    x,
    y,
    width,
    height,
    centerX: x + width / 2,
    centerY: y + height / 2
  };
}

export async function resolveDesktopVisionClickPoint(
  worldState: WorldState | null,
  appName: string,
  box: NormalizedVisionBox | null,
  fallback: { x: number; y: number } | null = null
): Promise<{ x: number; y: number } | null> {
  const bounds = await resolveDesktopVisionCandidateBounds(worldState, appName, box);
  if (bounds) {
    return {
      x: bounds.centerX,
      y: bounds.centerY
    };
  }
  if (!fallback) {
    return null;
  }
  const frame = await resolveDesktopVisionFrame(worldState, appName);
  if (!frame) {
    return null;
  }
  return {
    x: Number(frame.x ?? 0) + Number(frame.width ?? 0) * fallback.x,
    y: Number(frame.y ?? 0) + Number(frame.height ?? 0) * fallback.y
  };
}

export function buildDesktopPointBounds(
  worldState: WorldState | null,
  appName: string,
  point: { x: number; y: number } | null,
  radius = 18
): InteractionCandidate["bounds"] | null {
  if (!point) {
    return null;
  }
  const frame = findDesktopWindowBounds(worldState, appName);
  if (!frame) {
    return null;
  }
  const centerX = Number(frame.x ?? 0) + Number(frame.width ?? 0) * Number(point.x ?? 0);
  const centerY = Number(frame.y ?? 0) + Number(frame.height ?? 0) * Number(point.y ?? 0);
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) {
    return null;
  }
  return {
    x: centerX - radius,
    y: centerY - radius,
    width: radius * 2,
    height: radius * 2,
    centerX,
    centerY
  };
}

export function buildBrowserPointBounds(
  worldState: WorldState | null,
  point: { x: number; y: number } | null,
  radius = 18
): InteractionCandidate["bounds"] | null {
  if (!point) {
    return null;
  }
  const frame = ((worldState?.capture as { metadata?: { windowBounds?: InteractionCandidate["bounds"] } } | null)?.metadata
    ?.windowBounds ?? null) as InteractionCandidate["bounds"] | null;
  if (!frame) {
    return null;
  }
  const centerX = Number(frame.x ?? 0) + Number(frame.width ?? 0) * Number(point.x ?? 0);
  const centerY = Number(frame.y ?? 0) + Number(frame.height ?? 0) * Number(point.y ?? 0);
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) {
    return null;
  }
  return {
    x: centerX - radius,
    y: centerY - radius,
    width: radius * 2,
    height: radius * 2,
    centerX,
    centerY
  };
}

export function buildDesktopNormalizedRegionFromBounds(
  worldState: WorldState | null,
  appName: string,
  bounds: InteractionCandidate["bounds"] | null | undefined
): { x: number; y: number; width: number; height: number } | null {
  const frame = findDesktopWindowBounds(worldState, appName);
  if (!frame || !bounds) {
    return null;
  }
  const frameX = Number(frame.x ?? NaN);
  const frameY = Number(frame.y ?? NaN);
  const frameWidth = Number(frame.width ?? NaN);
  const frameHeight = Number(frame.height ?? NaN);
  const x = Number(bounds.x ?? NaN);
  const y = Number(bounds.y ?? NaN);
  const width = Number(bounds.width ?? NaN);
  const height = Number(bounds.height ?? NaN);
  if (
    ![frameX, frameY, frameWidth, frameHeight, x, y, width, height].every((value) => Number.isFinite(value))
    || frameWidth <= 0
    || frameHeight <= 0
  ) {
    return null;
  }
  return {
    x: clampNormalizedUnit((x - frameX) / frameWidth),
    y: clampNormalizedUnit((y - frameY) / frameHeight),
    width: clampNormalizedUnit(width / frameWidth),
    height: clampNormalizedUnit(height / frameHeight)
  };
}
