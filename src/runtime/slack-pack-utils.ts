import type { InteractionCandidate, WorldState } from "../types/runtime-schema.js";
import {
  candidateHintText,
  conversationCandidates,
  visibleLines
} from "./surface-signal-utils.js";
import { normalizeSlackSummary } from "./slack-semantic-facts.js";

type LivePackSurface = "browser" | "desktop";

const SEND_PATTERN = /(send|reply|submit|发送|回复|提交)/iu;
const UNREAD_PATTERN = /(unread|mention|new message|new messages|未读|新消息)/iu;
const SLACK_UI_CHROME_PATTERN =
  /^(search|compose|home|later|activity|more|threads|drafts|canvas|huddle|send|reply|message|messages|slack|搜索|撰写|发送|回复|消息)$/iu;
const SLACK_NAVIGATION_PATTERN =
  /^(threads|drafts(?:\s*&\s*sent)?|directories|huddles?|starred|direct messages|channels|later|activity|home|canvas|more)$/iu;

function dedupeStrings(values: unknown[] = []): string[] {
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

function defaultLocalizedTarget(surface: LivePackSurface, kind: "compose" | "send", worldState: WorldState | null): string {
  const chinese = /[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? ""));
  if (kind === "compose") {
    return chinese ? "消息" : "Message";
  }
  return chinese || surface === "desktop" ? "发送" : "Send";
}

function slackChromeKey(text: string): string {
  return normalizeSlackSummary(text)
    .replace(/^[*@]\s*/u, "")
    .replace(/^\d+[a-z]?\s+/iu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

export function isSlackUiChrome(text: string): boolean {
  const raw = String(text ?? "").trim();
  const key = slackChromeKey(raw);
  return (
    SLACK_UI_CHROME_PATTERN.test(raw) ||
    SLACK_UI_CHROME_PATTERN.test(key) ||
    SLACK_NAVIGATION_PATTERN.test(key)
  );
}

export function scoreSlackCandidate({
  candidate,
  worldState
}: {
  candidate: InteractionCandidate;
  worldState: WorldState | null;
}): number | null {
  const hintText = candidateHintText(candidate);
  const summary = normalizeSlackSummary(candidate.text || hintText);
  if (!summary || isSlackUiChrome(summary) || SEND_PATTERN.test(summary)) {
    return null;
  }

  let score = candidate.isInteractive ? 12 : 4;
  if (candidate.role === "link" || candidate.role === "button") {
    score += 4;
  }
  if (String((candidate.sourceHints ?? {}).source ?? "").toLowerCase() === "accessibility") {
    score += 12;
  }
  if (candidate.role === "row") {
    score += 6;
  }
  if (UNREAD_PATTERN.test(hintText)) {
    score += 30;
  }

  const lines = visibleLines(worldState);
  for (const [index, line] of lines.entries()) {
    if (!UNREAD_PATTERN.test(line)) {
      continue;
    }
    const nearby = lines.slice(index + 1, index + 6).some((entry) => entry.includes(summary) || summary.includes(entry));
    if (nearby) {
      score += 15;
      break;
    }
  }

  if (summary.length >= 4 && summary.length <= 80) {
    score += 3;
  }
  if (/^[#@]/u.test(summary)) {
    score += 1;
  }

  return score;
}

export function findSlackUnreadCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = conversationCandidates(worldState, {
    desktopRequiresAccessibility: worldState?.surface === "desktop"
  });
  const ranked = candidates
    .map((candidate) => ({ candidate, score: scoreSlackCandidate({ candidate, worldState }) }))
    .filter((entry): entry is { candidate: InteractionCandidate; score: number } => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score);
  return ranked[0]?.candidate ?? null;
}

export function findSlackComposeCandidate(worldState: WorldState | null, surface: LivePackSurface): InteractionCandidate | null {
  const candidates = conversationCandidates(worldState, {
    desktopRequiresAccessibility: surface === "desktop"
  });
  return (
    candidates.find((candidate) => {
      const hintText = candidateHintText(candidate);
      return (
        candidate.role === "textbox" ||
        /(message|reply|消息|回复)/iu.test(hintText) ||
        /(message|reply|消息|回复)/iu.test(candidate.text)
      );
    }) ?? null
  );
}

export function pickSlackComposeQuery(worldState: WorldState | null, surface: LivePackSurface): string {
  const composeCandidate = findSlackComposeCandidate(worldState, surface);

  if (!composeCandidate) {
    return defaultLocalizedTarget(surface, "compose", worldState);
  }

  const hints = (composeCandidate.sourceHints ?? {}) as Record<string, unknown>;
  return (
    String(hints.placeholder ?? hints.ariaLabel ?? composeCandidate.text ?? "").trim() ||
    defaultLocalizedTarget(surface, "compose", worldState)
  );
}

export function findSlackSendCandidate(worldState: WorldState | null, surface: LivePackSurface): InteractionCandidate | null {
  const candidates = conversationCandidates(worldState, {
    desktopRequiresAccessibility: surface === "desktop"
  });
  return (
    candidates.find((candidate) => {
      const hintText = candidateHintText(candidate);
      return candidate.role === "button" && (SEND_PATTERN.test(hintText) || SEND_PATTERN.test(candidate.text));
    }) ?? null
  );
}

export function pickSlackSendQuery(worldState: WorldState | null, surface: LivePackSurface): string {
  const sendCandidate = findSlackSendCandidate(worldState, surface);

  if (!sendCandidate) {
    return defaultLocalizedTarget(surface, "send", worldState);
  }

  return (
    String(sendCandidate.text ?? "").trim() ||
    String(((sendCandidate.sourceHints ?? {}) as Record<string, unknown>).ariaLabel ?? "").trim() ||
    defaultLocalizedTarget(surface, "send", worldState)
  );
}

export function extractSlackThreadContext(worldState: WorldState | null, summary: string): string[] {
  const lines = visibleLines(worldState).filter((line) => !isSlackUiChrome(line));
  const normalizedSummary = normalizeSlackSummary(summary);
  const summaryIndex = lines.findIndex((line) => normalizeSlackSummary(line) === normalizedSummary);
  const pool = summaryIndex === -1 ? lines : lines.slice(summaryIndex + 1);
  return dedupeStrings(
    pool.filter((line) => {
      const normalized = normalizeSlackSummary(line);
      return normalized && normalized !== normalizedSummary && !UNREAD_PATTERN.test(line) && !SEND_PATTERN.test(line);
    })
  ).slice(0, 4);
}
