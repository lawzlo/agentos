import type { InteractionCandidate, WorldState } from "../types/runtime-schema.js";
import { findDesktopWindowBounds } from "./vision-frame-utils.js";

interface NormalizedVisionBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface NormalizedVisionPoint {
  x: number;
  y: number;
}

interface OutlookComposerStateLike {
  composer: {
    present: boolean;
    approxBox: NormalizedVisionBox | null | undefined;
    entryPoint: NormalizedVisionPoint | null | undefined;
    hasDraftText: boolean | null;
    draftPreview: string | null;
  };
}

function clampNormalizedUnit(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function isPointWithinNormalizedBox(
  point: NormalizedVisionPoint | null | undefined,
  box: NormalizedVisionBox | null | undefined
) {
  if (!point || !box) {
    return false;
  }
  return (
    Number(point.x) >= Number(box.x) &&
    Number(point.x) <= Number(box.x) + Number(box.width) &&
    Number(point.y) >= Number(box.y) &&
    Number(point.y) <= Number(box.y) + Number(box.height)
  );
}

export function deriveOutlookComposerBodyPoint({
  approxBox,
  entryPoint
}: {
  approxBox: NormalizedVisionBox | null | undefined;
  entryPoint: NormalizedVisionPoint | null | undefined;
}): NormalizedVisionPoint | null {
  const box = approxBox ?? null;
  const candidate = entryPoint ?? null;
  if (box && candidate && isPointWithinNormalizedBox(candidate, box)) {
    const minBodyY = Number(box.y) + Math.max(Number(box.height) * 0.14, 0.045);
    const maxBodyY = Number(box.y) + Number(box.height) * 0.62;
    const minBodyX = Number(box.x) + Math.min(Number(box.width) * 0.04, 0.035);
    const maxBodyX = Number(box.x) + Number(box.width) * 0.82;
    if (
      Number(candidate.x) >= minBodyX &&
      Number(candidate.x) <= maxBodyX &&
      Number(candidate.y) >= minBodyY &&
      Number(candidate.y) <= maxBodyY
    ) {
      return {
        x: clampNormalizedUnit(Number(candidate.x)),
        y: clampNormalizedUnit(Number(candidate.y))
      };
    }
  }

  if (!box) {
    return candidate
      ? {
          x: clampNormalizedUnit(Number(candidate.x)),
          y: clampNormalizedUnit(Number(candidate.y))
        }
      : null;
  }

  return {
    x: clampNormalizedUnit(Number(box.x) + Math.min(Math.max(Number(box.width) * 0.1, 0.035), Number(box.width) * 0.22)),
    y: clampNormalizedUnit(Number(box.y) + Math.min(Math.max(Number(box.height) * 0.18, 0.06), Number(box.height) * 0.34))
  };
}

export function deriveOutlookComposerVerifyRegionFromVisual(
  composer: { approxBox: NormalizedVisionBox | null | undefined; entryPoint: NormalizedVisionPoint | null | undefined } | null
): { x: number; y: number; width: number; height: number } | null {
  const box = composer?.approxBox ?? null;
  const bodyPoint = deriveOutlookComposerBodyPoint({
    approxBox: box,
    entryPoint: composer?.entryPoint ?? null
  });
  if (!box || !bodyPoint) {
    return null;
  }

  const left = Math.max(
    Number(box.x) + Math.min(Number(box.width) * 0.03, 0.025),
    Number(bodyPoint.x) - Math.min(Number(box.width) * 0.03, 0.025)
  );
  const top = Math.max(
    Number(box.y) + Math.max(Number(box.height) * 0.16, 0.055),
    Number(bodyPoint.y) - Math.min(Number(box.height) * 0.035, 0.04)
  );
  const right = Math.min(1, Number(box.x) + Number(box.width) * 0.88);
  const bottom = Math.min(1, Number(box.y) + Number(box.height) * 0.42);
  const width = Math.max(0.18, right - left);
  const height = Math.max(0.08, bottom - top);
  return {
    x: clampNormalizedUnit(left),
    y: clampNormalizedUnit(top),
    width: clampNormalizedUnit(width),
    height: clampNormalizedUnit(height)
  };
}

function resolveDesktopNormalizedRegionBounds(
  worldState: WorldState | null,
  appName: string,
  region: { x: number; y: number; width: number; height: number } | null | undefined
): InteractionCandidate["bounds"] | null {
  const frame = findDesktopWindowBounds(worldState, appName);
  if (!frame || !region) {
    return null;
  }
  const frameX = Number(frame.x ?? NaN);
  const frameY = Number(frame.y ?? NaN);
  const frameWidth = Number(frame.width ?? NaN);
  const frameHeight = Number(frame.height ?? NaN);
  const x = Number(region.x ?? NaN);
  const y = Number(region.y ?? NaN);
  const width = Number(region.width ?? NaN);
  const height = Number(region.height ?? NaN);
  if (
    ![frameX, frameY, frameWidth, frameHeight, x, y, width, height].every((value) => Number.isFinite(value))
    || frameWidth <= 0
    || frameHeight <= 0
  ) {
    return null;
  }
  const absoluteX = frameX + frameWidth * x;
  const absoluteY = frameY + frameHeight * y;
  const absoluteWidth = frameWidth * width;
  const absoluteHeight = frameHeight * height;
  return {
    x: absoluteX,
    y: absoluteY,
    width: absoluteWidth,
    height: absoluteHeight,
    centerX: absoluteX + absoluteWidth / 2,
    centerY: absoluteY + absoluteHeight / 2
  };
}

function collectDesktopVisibleLinesInRegion(
  worldState: WorldState | null,
  appName: string,
  region: { x: number; y: number; width: number; height: number } | null | undefined
): string[] {
  const bounds = resolveDesktopNormalizedRegionBounds(worldState, appName, region);
  if (!bounds) {
    return [];
  }
  return (Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [])
    .filter((candidate) => {
      const centerX = Number(candidate?.bounds?.centerX ?? NaN);
      const centerY = Number(candidate?.bounds?.centerY ?? NaN);
      return (
        Number.isFinite(centerX)
        && Number.isFinite(centerY)
        && centerX >= Number(bounds.x)
        && centerX <= Number(bounds.x) + Number(bounds.width)
        && centerY >= Number(bounds.y)
        && centerY <= Number(bounds.y) + Number(bounds.height)
      );
    })
    .sort((left, right) => {
      const leftY = Number(left?.bounds?.centerY ?? 0);
      const rightY = Number(right?.bounds?.centerY ?? 0);
      if (Math.abs(leftY - rightY) > 8) {
        return leftY - rightY;
      }
      return Number(left?.bounds?.centerX ?? 0) - Number(right?.bounds?.centerX ?? 0);
    })
    .map((candidate) => String(candidate?.text ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const OUTLOOK_QUOTE_MARKER_PATTERN = /^(on .+wrote:|from:|date:|subject:|cc:|bcc:|get outlook for mac|>)/iu;
const OUTLOOK_COMPOSER_NOISE_PATTERN = /^(reply|send|discard|attach|loop components|signature|importance|from|to|cc|bcc|aptos|\d+)$/iu;

function outlookComposerContainsAuthoredDraftText(lines: string[]): boolean {
  const normalizedLines = lines
    .map((line) => String(line ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const quoteIndex = normalizedLines.findIndex((line) => OUTLOOK_QUOTE_MARKER_PATTERN.test(line));
  const authoredLines = (quoteIndex === -1 ? normalizedLines : normalizedLines.slice(0, quoteIndex)).filter(
    (line) => !OUTLOOK_COMPOSER_NOISE_PATTERN.test(line)
  );
  return authoredLines.some((line) => /[\p{L}\p{N}]/u.test(line));
}

export function reconcileOutlookVisualDraftState<T extends OutlookComposerStateLike>(
  worldState: WorldState | null,
  vision: T | null
): T | null {
  if (!vision?.composer.present || vision.composer.hasDraftText !== true) {
    return vision;
  }
  if (String(vision.composer.draftPreview ?? "").trim()) {
    return vision;
  }
  const composeVerifyRegion = deriveOutlookComposerVerifyRegionFromVisual(vision.composer);
  const composeLines = collectDesktopVisibleLinesInRegion(worldState, "Microsoft Outlook", composeVerifyRegion);
  if (outlookComposerContainsAuthoredDraftText(composeLines)) {
    return vision;
  }
  return {
    ...vision,
    composer: {
      ...vision.composer,
      hasDraftText: false,
      draftPreview: null
    }
  };
}

export function deriveOutlookComposerBodyBounds(
  bounds: InteractionCandidate["bounds"] | null | undefined
): InteractionCandidate["bounds"] | null {
  if (!bounds) {
    return null;
  }
  const x = Number(bounds.x ?? NaN);
  const y = Number(bounds.y ?? NaN);
  const width = Number(bounds.width ?? NaN);
  const height = Number(bounds.height ?? NaN);
  if (![x, y, width, height].every((value) => Number.isFinite(value)) || width <= 0 || height <= 0) {
    return null;
  }

  const bodyX = x + Math.min(Math.max(width * 0.08, 28), width * 0.24);
  const bodyY = y + Math.min(Math.max(height * 0.18, 54), height * 0.34);
  const bodyWidth = Math.min(Math.max(width * 0.52, 220), width * 0.74);
  const bodyHeight = Math.min(Math.max(height * 0.16, 80), height * 0.24);
  return {
    x: bodyX,
    y: bodyY,
    width: bodyWidth,
    height: bodyHeight,
    centerX: bodyX + Math.min(48, bodyWidth / 2),
    centerY: bodyY + Math.min(22, bodyHeight / 2)
  };
}
