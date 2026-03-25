import type { InteractionCandidate, WorldState } from "../types/runtime-schema.js";

export interface DesktopProbeCandidateSummary {
  id: string;
  text: string;
  role: string | null;
  interactive: boolean;
  source: string;
  score?: number | null;
  bounds?: InteractionCandidate["bounds"];
  hints?: string[];
}

export interface SurfaceSignal {
  text: string;
  source: string;
  interactive: boolean;
  role: string | null;
  index: number;
  score: number;
}

const DESKTOP_WINDOW_CONTROL_SUBROLE_PATTERN =
  /(axclosebutton|axminimizebutton|axzoombutton|axfullscreenbutton|axtoolbarbutton)/iu;
const DESKTOP_WINDOW_CONTROL_TEXT_PATTERN =
  /^(close|close button|minimi[sz]e|minimi[sz]e button|zoom|zoom button|full ?screen|enter full ?screen|exit full ?screen|toolbar)$/iu;
const SURFACE_ACTION_TEXT_PATTERN = /^(send|reply|submit|search|发送|回复|提交|搜索)$/iu;

function uniqueStrings(values: unknown[] = []): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function normalizeTokens(values: unknown[] = []): string[] {
  return uniqueStrings(values).map((entry) => entry.toLowerCase());
}

function collectSignals(worldState: WorldState | null): SurfaceSignal[] {
  const signals: SurfaceSignal[] = [];

  for (const [index, candidate] of (worldState?.interactionCandidates ?? []).entries()) {
    const text = String(candidate?.text ?? "").trim();
    if (!text) {
      continue;
    }

    signals.push({
      text,
      source: "candidate",
      interactive: Boolean(candidate?.isInteractive),
      role: candidate?.role ?? null,
      index,
      score: candidate?.isInteractive ? 8 : 5
    });
  }

  for (const [index, block] of (worldState?.ocrBlocks ?? []).entries()) {
    const text = String(block?.text ?? "").trim();
    if (!text) {
      continue;
    }

    signals.push({
      text,
      source: "ocr",
      interactive: false,
      role: "text",
      index,
      score: 4
    });
  }

  for (const [index, line] of String(worldState?.visibleText ?? "")
    .split("\n")
    .entries()) {
    const text = String(line ?? "").trim();
    if (!text) {
      continue;
    }

    signals.push({
      text,
      source: "visible",
      interactive: false,
      role: "text",
      index,
      score: 2
    });
  }

  const windows = Array.isArray((worldState?.appContext as { windows?: unknown } | null)?.windows)
    ? (((worldState?.appContext as { windows?: unknown[] } | null)?.windows ?? []) as Array<Record<string, unknown>>)
    : [];
  for (const [index, windowInfo] of windows.entries()) {
    const text = String(windowInfo?.title ?? "").trim();
    if (!text) {
      continue;
    }

    signals.push({
      text,
      source: "window",
      interactive: false,
      role: "window",
      index,
      score: 1
    });
  }

  return signals;
}

export function visibleLines(worldState: WorldState | null): string[] {
  return uniqueStrings(collectSignals(worldState).map((signal) => signal.text)).slice(0, 120);
}

export function matchTriggerText(lines: string[], triggerTexts: unknown[] = []): string | null {
  const loweredTriggers = triggerTexts.map((entry) => String(entry).toLowerCase()).filter(Boolean);
  if (!loweredTriggers.length) {
    return lines[0] ?? null;
  }

  return lines.find((line) => loweredTriggers.some((trigger) => line.toLowerCase().includes(trigger))) ?? null;
}

export function bestSignalMatch({
  worldState,
  triggerTexts = [],
  unreadTokens = [],
  ignoreTokens = []
}: {
  worldState: WorldState | null;
  triggerTexts?: unknown[];
  unreadTokens?: unknown[];
  ignoreTokens?: unknown[];
}): SurfaceSignal | null {
  const triggerTokens = normalizeTokens(triggerTexts);
  const unreadMatches = normalizeTokens(unreadTokens);
  const ignored = normalizeTokens(ignoreTokens);
  const signals = collectSignals(worldState);

  const ranked = signals
    .map((signal) => {
      const lowered = signal.text.toLowerCase();
      if (ignored.some((token) => lowered.includes(token))) {
        return null;
      }

      let score = signal.score;
      if (triggerTokens.some((token) => lowered.includes(token))) {
        score += 12;
      }
      if (unreadMatches.some((token) => lowered.includes(token))) {
        score += 10;
      }
      if (SURFACE_ACTION_TEXT_PATTERN.test(signal.text.trim())) {
        score -= 6;
      }

      return {
        ...signal,
        score
      };
    })
    .filter((signal): signal is SurfaceSignal => Boolean(signal))
    .sort((left, right) => right.score - left.score);

  return ranked[0] ?? null;
}

export function contextForSignal(
  worldState: WorldState | null,
  signal: { text?: string } | null
): string[] {
  const lines = visibleLines(worldState);
  const index = lines.findIndex((line) => line === signal?.text);
  if (index === -1) {
    return lines.slice(0, 3);
  }

  return uniqueStrings(lines.slice(Math.max(0, index - 1), index + 2)).slice(0, 3);
}

export function candidateHintStrings(candidate: InteractionCandidate | null | undefined): string[] {
  if (!candidate) {
    return [];
  }
  const hints = (candidate.sourceHints ?? {}) as Record<string, unknown>;
  return uniqueStrings([
    candidate.text,
    hints.ariaLabel,
    hints.placeholder,
    hints.title,
    hints.name,
    hints.roleDescription
  ]);
}

export function candidateHintText(candidate: InteractionCandidate | null | undefined): string {
  return candidateHintStrings(candidate).join(" ").trim();
}

export function summarizeProbeCandidate(
  candidate: InteractionCandidate | null | undefined,
  score: number | null = null
): DesktopProbeCandidateSummary | null {
  if (!candidate) {
    return null;
  }

  return {
    id: String(candidate.id ?? ""),
    text: String(candidate.text ?? "").trim(),
    role: candidate.role ?? null,
    interactive: Boolean(candidate.isInteractive),
    source: String((candidate.sourceHints ?? {}).source ?? "unknown"),
    score,
    bounds: candidate.bounds,
    hints: candidateHintStrings(candidate).slice(0, 6)
  };
}

export function rankProbeCandidates(
  worldState: WorldState | null,
  scorer: (args: { candidate: InteractionCandidate; worldState: WorldState | null }) => number | null,
  candidates: InteractionCandidate[],
  limit = 5
): DesktopProbeCandidateSummary[] {
  return candidates
    .map((candidate) => ({ candidate, score: scorer({ candidate, worldState }) }))
    .filter((entry): entry is { candidate: InteractionCandidate; score: number } => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => summarizeProbeCandidate(entry.candidate, entry.score))
    .filter((entry): entry is DesktopProbeCandidateSummary => Boolean(entry));
}

export function isAccessibilityCandidate(candidate: InteractionCandidate | null | undefined): boolean {
  return String((candidate?.sourceHints ?? {}).source ?? "").toLowerCase() === "accessibility";
}

export function isDesktopWindowControlCandidate(candidate: InteractionCandidate | null | undefined): boolean {
  if (!candidate || !isAccessibilityCandidate(candidate)) {
    return false;
  }

  const hints = (candidate.sourceHints ?? {}) as Record<string, unknown>;
  const axRole = String(hints.axRole ?? "").trim().toLowerCase();
  const axSubrole = String(hints.axSubrole ?? "").trim().toLowerCase();
  const hintStrings = candidateHintStrings(candidate).map((value) => value.toLowerCase());
  const text = String(candidate.text ?? "").trim().toLowerCase();

  if (DESKTOP_WINDOW_CONTROL_SUBROLE_PATTERN.test(axSubrole) || DESKTOP_WINDOW_CONTROL_SUBROLE_PATTERN.test(axRole)) {
    return true;
  }

  if (String(candidate.role ?? "").toLowerCase() !== "button") {
    return false;
  }

  return [text, ...hintStrings].some((value) => DESKTOP_WINDOW_CONTROL_TEXT_PATTERN.test(value));
}

export function conversationCandidates(
  worldState: WorldState | null,
  { desktopRequiresAccessibility = false }: { desktopRequiresAccessibility?: boolean } = {}
): InteractionCandidate[] {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  const accessibilityCandidates = candidates
    .filter(isAccessibilityCandidate)
    .filter((candidate) => !isDesktopWindowControlCandidate(candidate));
  if (worldState?.surface === "desktop" && desktopRequiresAccessibility) {
    return accessibilityCandidates;
  }

  return accessibilityCandidates.length
    ? accessibilityCandidates
    : candidates.filter((candidate) => !isDesktopWindowControlCandidate(candidate));
}

export function wechatCandidates(worldState: WorldState | null): InteractionCandidate[] {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  return candidates.filter((candidate) => !isDesktopWindowControlCandidate(candidate));
}
