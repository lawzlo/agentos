import type { InteractionCandidate, WorldState } from "../types/runtime-schema.js";
import {
  findOutlookComposeCandidate,
  findOutlookReplyButtonCandidate,
  findOutlookUnreadCandidate,
  mailSummariesMatch,
  normalizeMailSummary
} from "./mail-pack-utils.js";
import { visibleLines } from "./surface-signal-utils.js";
import { findDesktopWindowBounds } from "./vision-frame-utils.js";

const OUTLOOK_INBOX_RECOVERY_PATTERN = /\binbox\b/iu;
const OUTLOOK_NON_INBOX_FOLDER_PATTERN = /\b(deleted items|junk email|archive|sent|drafts)\b/iu;
const UNREAD_PATTERN = /(unread|mention|new message|new messages|未读|新消息)/iu;

interface OutlookNormalizedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface OutlookThreadSummaryLike {
  name?: string | null;
  subjectCue?: string | null;
  latestSnippet?: string | null;
  approxBox?: OutlookNormalizedBox | null;
}

interface OutlookVisualAnalysisLike {
  openThread?: string | null;
  selectedRow?: string | null;
  visibleUnreadThreads?: OutlookThreadSummaryLike[];
  composer?: {
    present?: boolean | null;
    evidence?: string | null;
  } | null;
  scene?: string | null;
  targetThreadOpen?: boolean | null;
}

export function hasOutlookInboxRecoveryHint(lines: string[]) {
  return lines.some((line) => OUTLOOK_INBOX_RECOVERY_PATTERN.test(line)) &&
    lines.some((line) => OUTLOOK_NON_INBOX_FOLDER_PATTERN.test(line));
}

export function findOutlookInboxRecoveryPoint(worldState: WorldState | null): { x: number; y: number } | null {
  const interactionCandidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  const screenTextBlocks = Array.isArray(worldState?.screenTextBlocks) ? worldState.screenTextBlocks : [];
  const windowBounds = findDesktopWindowBounds(worldState, "Microsoft Outlook");
  const maxSidebarX = windowBounds
    ? windowBounds.x + windowBounds.width * 0.38
    : Number.POSITIVE_INFINITY;

  const rankedInteractionCandidates = interactionCandidates
    .map((candidate) => ({
      text: String(candidate?.text ?? "").trim(),
      bounds: candidate?.bounds ?? null,
      score: (candidate?.isInteractive ? 10 : 0) + (candidate?.role === "button" ? 5 : 0)
    }))
    .filter((candidate) => {
      const text = String(candidate.text ?? "").trim();
      const bounds = candidate.bounds;
      return (
        OUTLOOK_INBOX_RECOVERY_PATTERN.test(text) &&
        bounds &&
        Number.isFinite(bounds.centerX) &&
        Number.isFinite(bounds.centerY) &&
        Number(bounds.centerX) <= maxSidebarX
      );
    })
    .sort((left, right) => {
      return Number(right.score ?? 0) - Number(left.score ?? 0)
        || Number(left.bounds?.centerY ?? Number.POSITIVE_INFINITY) - Number(right.bounds?.centerY ?? Number.POSITIVE_INFINITY);
    });
  const interactionMatch = rankedInteractionCandidates[0];
  if (interactionMatch?.bounds && Number.isFinite(Number(interactionMatch.bounds.centerX)) && Number.isFinite(Number(interactionMatch.bounds.centerY))) {
    return {
      x: Number(interactionMatch.bounds.centerX),
      y: Number(interactionMatch.bounds.centerY)
    };
  }

  const rankedScreenTextBlocks = screenTextBlocks
    .map((block) => ({
      text: String((block as { text?: unknown } | null)?.text ?? "").trim(),
      bounds: (block as { bounds?: InteractionCandidate["bounds"] } | null)?.bounds ?? null,
      score: Math.round(Number((block as { confidence?: unknown } | null)?.confidence ?? 0) * 10)
    }))
    .filter((block) => {
      const text = String(block.text ?? "").trim();
      const bounds = block.bounds;
      return (
        OUTLOOK_INBOX_RECOVERY_PATTERN.test(text) &&
        bounds &&
        Number.isFinite(bounds.centerX) &&
        Number.isFinite(bounds.centerY) &&
        Number(bounds.centerX) <= maxSidebarX
      );
    })
    .sort((left, right) => {
      return Number(right.score ?? 0) - Number(left.score ?? 0)
        || Number(left.bounds?.centerY ?? Number.POSITIVE_INFINITY) - Number(right.bounds?.centerY ?? Number.POSITIVE_INFINITY);
    });
  const screenMatch = rankedScreenTextBlocks[0];
  if (!screenMatch?.bounds || !Number.isFinite(Number(screenMatch.bounds.centerX)) || !Number.isFinite(Number(screenMatch.bounds.centerY))) {
    return null;
  }
  return {
    x: Number(screenMatch.bounds.centerX),
    y: Number(screenMatch.bounds.centerY)
  };
}

export function isOutlookThreadOpenForTarget(
  vision: OutlookVisualAnalysisLike | null,
  targetThread: string,
  targetCue: string | null = null
): boolean {
  return didOutlookThreadSelectionAdvance({ vision, targetThread, targetCue });
}

export function didOutlookThreadSelectionAdvance({
  vision,
  targetThread,
  targetCue = null,
  previousOpenThread = null
}: {
  vision: OutlookVisualAnalysisLike | null;
  targetThread: string;
  targetCue?: string | null;
  previousOpenThread?: string | null;
}): boolean {
  void previousOpenThread;
  if (!vision) {
    return false;
  }
  if (vision.targetThreadOpen === true) {
    return true;
  }

  const normalizedTarget = normalizeMailSummary(targetThread);
  const normalizedOpenThread = normalizeMailSummary(String(vision.openThread ?? ""));
  const normalizedSelectedRow = normalizeMailSummary(String(vision.selectedRow ?? ""));
  const normalizedCue = normalizeMailSummary(String(targetCue ?? ""));
  if (mailSummariesMatch(normalizedTarget, normalizedOpenThread)) {
    return true;
  }
  if (mailSummariesMatch(normalizedCue, normalizedOpenThread)) {
    return true;
  }
  if (mailSummariesMatch(normalizedTarget, normalizedSelectedRow)) {
    return true;
  }
  if (mailSummariesMatch(normalizedCue, normalizedSelectedRow)) {
    return true;
  }
  if (normalizedTarget && normalizedSelectedRow.startsWith(normalizedTarget)) {
    return true;
  }
  if (normalizedCue && normalizedSelectedRow.includes(normalizedCue)) {
    return true;
  }
  return false;
}

export function didOutlookThreadSelectionAdvanceFromState({
  worldState,
  targetThread,
  targetCue = null,
  previousOpenThread = null,
  requireReplySurface = false
}: {
  worldState: WorldState | null;
  targetThread: string;
  targetCue?: string | null;
  previousOpenThread?: string | null;
  requireReplySurface?: boolean;
}): boolean {
  if (!worldState) {
    return false;
  }

  const normalizedTarget = normalizeMailSummary(targetThread);
  const normalizedCue = normalizeMailSummary(String(targetCue ?? ""));
  const normalizedPrevious = normalizeMailSummary(String(previousOpenThread ?? ""));
  const rawVisibleLines = visibleLines(worldState)
    .map((line) => String(line ?? "").trim())
    .filter(Boolean);
  const visibleLinesNormalized = rawVisibleLines
    .map((line) => normalizeMailSummary(line))
    .filter(Boolean);
  const matchesVisibleThread = [normalizedTarget, normalizedCue, normalizedPrevious]
    .filter(Boolean)
    .some((candidate) => visibleLinesNormalized.some((line) => mailSummariesMatch(line, candidate)));
  const hasReplySurface = Boolean(findOutlookReplyButtonCandidate(worldState) || findOutlookComposeCandidate(worldState));
  const hasQuotedThreadSubject = rawVisibleLines.some((line) => /^(?:re|fw|fwd)\s*[:：]/iu.test(line));
  const unreadStillVisible = rawVisibleLines.some((line) => UNREAD_PATTERN.test(line)) || Boolean(findOutlookUnreadCandidate(worldState));

  if (requireReplySurface) {
    return hasReplySurface && matchesVisibleThread;
  }

  if (hasReplySurface && matchesVisibleThread) {
    return true;
  }

  if (hasQuotedThreadSubject && !unreadStillVisible) {
    if (matchesVisibleThread) {
      return true;
    }
    return Boolean(normalizedPrevious || normalizedTarget || normalizedCue);
  }

  return false;
}

export function isOutlookTargetUnreadStillVisible(
  vision: OutlookVisualAnalysisLike | null,
  targetThread: string,
  targetCue: string | null = null
): boolean {
  if (!vision) {
    return false;
  }

  const normalizedTarget = normalizeMailSummary(targetThread);
  const normalizedCue = normalizeMailSummary(String(targetCue ?? ""));
  return (vision.visibleUnreadThreads ?? []).some((thread) => {
    const threadName = normalizeMailSummary(String(thread.name ?? ""));
    const threadSubjectCue = normalizeMailSummary(String(thread.subjectCue ?? ""));
    return (
      mailSummariesMatch(threadName, normalizedTarget)
      || mailSummariesMatch(threadName, normalizedCue)
      || mailSummariesMatch(threadSubjectCue, normalizedCue)
    );
  });
}

export function findMatchingOutlookVisibleThread(
  vision: OutlookVisualAnalysisLike | null,
  targetThread: string,
  targetCue: string | null = null
): OutlookThreadSummaryLike | null {
  if (!vision) {
    return null;
  }

  const normalizedTarget = normalizeMailSummary(targetThread);
  const normalizedCue = normalizeMailSummary(String(targetCue ?? ""));
  for (const thread of vision.visibleUnreadThreads ?? []) {
    const threadName = normalizeMailSummary(String(thread.name ?? ""));
    const threadSubjectCue = normalizeMailSummary(String(thread.subjectCue ?? ""));
    const threadSnippet = normalizeMailSummary(String(thread.latestSnippet ?? ""));
    if (
      mailSummariesMatch(threadName, normalizedTarget)
      || mailSummariesMatch(threadName, normalizedCue)
      || mailSummariesMatch(threadSubjectCue, normalizedCue)
      || mailSummariesMatch(threadSnippet, normalizedCue)
    ) {
      return thread;
    }
  }

  return null;
}

export function traceOutlookThreadState(
  stage: string,
  {
    vision,
    targetThread,
    targetCue,
    previousOpenThread,
    openAttempts
  }: {
    vision: OutlookVisualAnalysisLike | null;
    targetThread: string;
    targetCue: string | null;
    previousOpenThread: string | null;
    openAttempts: number;
  }
): void {
  if (process.env.AGENTOS_TRACE_OUTLOOK_STATE !== "1") {
    return;
  }
  const advanced = didOutlookThreadSelectionAdvance({
    vision,
    targetThread,
    targetCue,
    previousOpenThread
  });
  const unreadStillVisible = isOutlookTargetUnreadStillVisible(vision, targetThread, targetCue);
  console.error(
    JSON.stringify(
      {
        stage,
        targetThread,
        targetCue,
        previousOpenThread,
        openAttempts,
        scene: vision?.scene ?? null,
        openThread: vision?.openThread ?? null,
        selectedRow: vision?.selectedRow ?? null,
        targetThreadOpen: vision?.targetThreadOpen ?? null,
        composerPresent: vision?.composer?.present ?? null,
        composerEvidence: vision?.composer?.evidence ?? null,
        visibleUnreadThreads: (vision?.visibleUnreadThreads ?? []).map((thread) => ({
          name: thread.name ?? null,
          subjectCue: thread.subjectCue ?? null
        })),
        advanced,
        unreadStillVisible
      },
      null,
      2
    )
  );
}

export function traceOutlookAnalysisError(stage: string, error: unknown): void {
  if (process.env.AGENTOS_TRACE_OUTLOOK_STATE !== "1") {
    return;
  }
  console.error(
    JSON.stringify(
      {
        stage,
        analysisError: error instanceof Error ? error.message : String(error ?? "unknown_error")
      },
      null,
      2
    )
  );
}
