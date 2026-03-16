export interface BoundsLike {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  centerX?: number;
  centerY?: number;
}

export interface OcrBlockLike {
  id?: string;
  text?: string;
  confidence?: number;
  box?: BoundsLike;
  bounds?: BoundsLike;
  source?: string;
}

export interface InteractionCandidateLike {
  id?: string;
  kind?: string;
  text?: string;
  role?: string | null;
  tag?: string | null;
  bounds?: BoundsLike;
  box?: BoundsLike;
  confidence?: number;
  sourceHints?: Record<string, unknown>;
  isInteractive?: boolean;
}

export interface RecentActionLike {
  label?: string;
  action?: string;
  surface?: string;
  result?: unknown;
}

export function normalizeBounds(bounds: BoundsLike = {}) {
  const x = Number(bounds.x ?? 0);
  const y = Number(bounds.y ?? 0);
  const width = Number(bounds.width ?? 0);
  const height = Number(bounds.height ?? 0);

  return {
    x,
    y,
    width,
    height,
    centerX: Number(bounds.centerX ?? x + width / 2),
    centerY: Number(bounds.centerY ?? y + height / 2)
  };
}

export function normalizeOcrBlocks(
  blocks: OcrBlockLike[] = [],
  surface = "unknown"
) {
  return blocks
    .filter((block) => block?.text)
    .map((block, index) => ({
      id: block.id ?? `${surface}-ocr-${index + 1}`,
      text: String(block.text).trim(),
      confidence: Number(block.confidence ?? 0),
      bounds: normalizeBounds(block.box ?? block.bounds ?? {}),
      source: block.source ?? "ocr"
    }))
    .filter((block) => block.text);
}

export function createInteractionCandidate(
  candidate: InteractionCandidateLike,
  index = 0,
  surface = "unknown"
) {
  return {
    id: candidate.id ?? `${surface}-candidate-${index + 1}`,
    surface,
    kind: candidate.kind ?? "element",
    text: candidate.text ?? "",
    role: candidate.role ?? candidate.tag ?? null,
    bounds: normalizeBounds(candidate.bounds ?? candidate.box ?? {}),
    confidence: Number(candidate.confidence ?? 0.5),
    sourceHints: candidate.sourceHints ?? {},
    isInteractive: candidate.isInteractive ?? true
  };
}

export function createWorldState({
  surface,
  workspaceId,
  appContext,
  capture,
  ocrBlocks = [],
  interactionCandidates = [],
  visibleText = "",
  recentActions = [],
  summary = null
}: {
  surface: string;
  workspaceId: string;
  appContext: Record<string, unknown> | null;
  capture: unknown;
  ocrBlocks?: unknown[];
  interactionCandidates?: unknown[];
  visibleText?: string;
  recentActions?: RecentActionLike[];
  summary?: string | null;
}) {
  return {
    version: 1,
    surface,
    workspaceId,
    appContext,
    capture,
    ocrBlocks,
    interactionCandidates,
    visibleText,
    recentActions,
    summary,
    timestamp: new Date().toISOString()
  };
}

export function summarizeRecentActions(actions: RecentActionLike[] = [], limit = 6) {
  return actions.slice(-limit).map((action) => ({
    label: action.label,
    action: action.action,
    surface: action.surface,
    result: action.result ?? null
  }));
}
