import type { InteractionCandidate, WorldState } from "../types/runtime-schema.js";
import { deriveOutlookComposerBodyBounds } from "./outlook-compose-utils.js";
import {
  candidateHintText,
  conversationCandidates,
  isAccessibilityCandidate,
  visibleLines
} from "./surface-signal-utils.js";
import { findDesktopWindowBounds } from "./vision-frame-utils.js";

type LivePackSurface = "browser" | "desktop";

const SEND_PATTERN = /(send|reply|submit|发送|回复|提交)/iu;
const UNREAD_PATTERN = /(unread|mention|new message|new messages|未读|新消息)/iu;
const MAIL_UI_CHROME_PATTERN =
  /^(mail|email|gmail|outlook|邮件|inbox|收件箱|已发送|sent|drafts|草稿|spam|archive|归档|trash|垃圾箱|delete|删除|search|搜索|compose|撰写|reply|回复|send|发送)$/iu;
const OUTLOOK_UI_CHROME_PATTERN =
  /^(outlook|focused|other|archive|flag|categories|categorize|junk email|junk|trash|deleted items|drafts|sent items|reply all|forward|new mail|focused inbox|other inbox|respond|收件箱|其他|重点|归档|标记|分类|垃圾邮件|已删除|已发送|新建邮件|回复全部|转发)$/iu;

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

export function normalizeMailSummary(value: string): string {
  return String(value ?? "")
    .replace(/^[●•]\s*/u, "")
    .replace(/^[A-Za-z]\s+(?=\p{Script=Han})/u, "")
    .replace(/^(unread email|unread mail|unread|new mail|new email|未读邮件|未读|新邮件)\s*[:：-]?\s*/iu, "")
    .replace(/^(?:(?:re|fw|fwd)\s*[:：]\s*)+/iu, "")
    .replace(/^\(\d+\)\s*/u, "")
    .replace(/\s+\(\d+\)$/u, "")
    .trim();
}

export function mailSummariesMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = normalizeMailSummary(String(left ?? ""));
  const normalizedRight = normalizeMailSummary(String(right ?? ""));
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }

  const truncatedLeft = normalizedLeft.replace(/(?:\.\.\.|…)\s*$/u, "").trim();
  const truncatedRight = normalizedRight.replace(/(?:\.\.\.|…)\s*$/u, "").trim();
  if (truncatedLeft && truncatedLeft === truncatedRight) {
    return true;
  }

  const foldedLeft = truncatedLeft.toLocaleLowerCase();
  const foldedRight = truncatedRight.toLocaleLowerCase();
  if (foldedLeft.length >= 8 && foldedRight.startsWith(foldedLeft)) {
    return true;
  }
  if (foldedRight.length >= 8 && foldedLeft.startsWith(foldedRight)) {
    return true;
  }

  return false;
}

export function isMailUiChrome(text: string): boolean {
  return MAIL_UI_CHROME_PATTERN.test(String(text ?? "").trim());
}

export function isMailComposerChromeLine(text: string): boolean {
  return /^(send|reply|compose|write|message|editor|发送|回复|撰写|输入)$/iu.test(String(text ?? "").trim());
}

export function isOutlookUiChrome(text: string): boolean {
  const normalized = String(text ?? "").trim();
  return isMailUiChrome(normalized) || OUTLOOK_UI_CHROME_PATTERN.test(normalized);
}

export function scoreMailCandidate({
  candidate,
  worldState
}: {
  candidate: InteractionCandidate;
  worldState: WorldState | null;
}): number | null {
  const hintText = candidateHintText(candidate);
  const summary = normalizeMailSummary(candidate.text || hintText);
  if (!summary || isMailUiChrome(summary) || SEND_PATTERN.test(summary)) {
    return null;
  }

  let score = candidate.isInteractive ? 12 : 4;
  if (candidate.role === "button" || candidate.role === "link" || candidate.role === "text") {
    score += 4;
  }
  if (UNREAD_PATTERN.test(hintText) || /(mail|email|邮件)/iu.test(hintText)) {
    score += 24;
  }

  const lines = visibleLines(worldState);
  for (const [index, line] of lines.entries()) {
    if (!UNREAD_PATTERN.test(line) && !/(mail|email|邮件|收件箱|inbox)/iu.test(line)) {
      continue;
    }
    const nearby = lines
      .slice(Math.max(0, index - 2), index + 6)
      .some((entry) => entry.includes(summary) || summary.includes(normalizeMailSummary(entry)));
    if (nearby) {
      score += 16;
      break;
    }
  }

  if (summary.length >= 4 && summary.length <= 120) {
    score += 3;
  }

  return score;
}

export function findMailUnreadCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  const ranked = candidates
    .map((candidate) => ({ candidate, score: scoreMailCandidate({ candidate, worldState }) }))
    .filter((entry): entry is { candidate: InteractionCandidate; score: number } => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score);
  return ranked[0]?.candidate ?? null;
}

export function pickMailComposeQuery(worldState: WorldState | null, surface: LivePackSurface): string {
  const composeCandidate = findMailComposeCandidate(worldState);

  if (!composeCandidate) {
    return /[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? ""))
      ? "回复"
      : surface === "browser"
        ? "Reply"
        : "Message";
  }

  const hints = (composeCandidate.sourceHints ?? {}) as Record<string, unknown>;
  return (
    String(hints.placeholder ?? hints.ariaLabel ?? composeCandidate.text ?? "").trim() ||
    (/[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? ""))
      ? "回复"
      : surface === "browser"
        ? "Reply"
        : "Message")
  );
}

export function findMailComposeCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  return (
    candidates.find((candidate) => {
      const hintText = candidateHintText(candidate);
      return (
        candidate.role === "textbox" ||
        /(reply|message|compose|write|回复|撰写|输入)/iu.test(hintText) ||
        /(reply|message|compose|write|回复|撰写|输入)/iu.test(candidate.text)
      );
    }) ?? null
  );
}

export function pickMailSendQuery(worldState: WorldState | null, surface: LivePackSurface): string {
  const sendCandidate = findMailSendCandidate(worldState);

  if (!sendCandidate) {
    return /[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? "")) ? "发送" : surface === "browser" ? "Send reply" : "Send";
  }

  return (
    String(sendCandidate.text ?? "").trim() ||
    String(((sendCandidate.sourceHints ?? {}) as Record<string, unknown>).ariaLabel ?? "").trim() ||
    (/[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? "")) ? "发送" : surface === "browser" ? "Send reply" : "Send")
  );
}

export function findMailSendCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  return (
    candidates.find((candidate) => {
      const hintText = candidateHintText(candidate);
      return candidate.role === "button" && (SEND_PATTERN.test(hintText) || SEND_PATTERN.test(candidate.text));
    }) ?? null
  );
}

export function extractMailThreadContext(worldState: WorldState | null, summary: string): string[] {
  const lines = visibleLines(worldState).filter((line) => !isMailUiChrome(line));
  const normalizedSummary = normalizeMailSummary(summary);
  const summaryIndex = lines.findIndex((line) => normalizeMailSummary(line) === normalizedSummary);
  const pool = summaryIndex === -1 ? lines : lines.slice(summaryIndex + 1);
  return dedupeStrings(
    pool.filter((line) => {
      const normalized = normalizeMailSummary(line);
      return normalized && normalized !== normalizedSummary && !UNREAD_PATTERN.test(line) && !isMailComposerChromeLine(line);
    })
  ).slice(0, 5);
}

export function scoreOutlookCandidate({
  candidate,
  worldState
}: {
  candidate: InteractionCandidate;
  worldState: WorldState | null;
}): number | null {
  const hintText = candidateHintText(candidate);
  const summary = normalizeMailSummary(candidate.text || hintText);
  if (!summary || isOutlookUiChrome(summary) || SEND_PATTERN.test(summary)) {
    return null;
  }

  let score = candidate.isInteractive ? 12 : 4;
  if (candidate.role === "row") {
    score += 8;
  }
  if (candidate.role === "button" || candidate.role === "link" || candidate.role === "text") {
    score += 4;
  }
  if (isAccessibilityCandidate(candidate)) {
    score += 16;
  }
  if (UNREAD_PATTERN.test(hintText) || /(mail|email|outlook|邮件|收件箱|focused inbox|focused)/iu.test(hintText)) {
    score += 24;
  }

  const windowTitle = String(((candidate.sourceHints ?? {}) as Record<string, unknown>).windowTitle ?? "");
  if (/(outlook|mail|inbox|focused|other|收件箱|重点)/iu.test(windowTitle)) {
    score += 8;
  }

  const lines = visibleLines(worldState);
  for (const [index, line] of lines.entries()) {
    if (!UNREAD_PATTERN.test(line) && !/(mail|email|outlook|邮件|收件箱|focused|other)/iu.test(line)) {
      continue;
    }
    const nearby = lines
      .slice(Math.max(0, index - 2), index + 6)
      .some((entry) => entry.includes(summary) || summary.includes(normalizeMailSummary(entry)));
    if (nearby) {
      score += 16;
      break;
    }
  }

  if (summary.length >= 3 && summary.length <= 140) {
    score += 3;
  }

  return score;
}

export function findOutlookUnreadCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = conversationCandidates(worldState, {
    desktopRequiresAccessibility: true
  });
  const ranked = candidates
    .map((candidate) => ({ candidate, score: scoreOutlookCandidate({ candidate, worldState }) }))
    .filter((entry): entry is { candidate: InteractionCandidate; score: number } => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score);
  return ranked[0]?.candidate ?? null;
}

export function isOutlookComposeTextboxCandidate(candidate: InteractionCandidate | null | undefined): boolean {
  if (!candidate) {
    return false;
  }
  const hintText = candidateHintText(candidate);
  const text = String(candidate.text ?? "").trim();
  const composeSignal =
    /(message body|compose|write|editor|draft|type here|reply|回复内容|撰写|输入|邮件正文)/iu.test(hintText) ||
    /(message body|compose|write|editor|draft|type here|reply|回复内容|撰写|输入|邮件正文)/iu.test(text);
  if (candidate.role === "textbox") {
    return composeSignal;
  }
  if (candidate.role === "button") {
    return false;
  }
  return composeSignal;
}

export function outlookComposeChromeVisible(worldState: WorldState | null): boolean {
  const lines = visibleLines(worldState).slice(0, 80);
  const hasSend = lines.some((line) => /^send$/iu.test(String(line ?? "").trim()));
  const hasFrom = lines.some((line) => /^from:?$/iu.test(String(line ?? "").trim()));
  const hasTo = lines.some((line) => /^to:?$/iu.test(String(line ?? "").trim()));
  const hasSubject = lines.some((line) => /^subject:?$/iu.test(String(line ?? "").trim()));
  return hasSend && hasFrom && hasTo && hasSubject;
}

export function fallbackOutlookComposeCandidate(worldState: WorldState | null): InteractionCandidate | null {
  if (!outlookComposeChromeVisible(worldState)) {
    return null;
  }
  const windowBounds = findDesktopWindowBounds(worldState, "Microsoft Outlook");
  if (!windowBounds) {
    return null;
  }

  const x = Number(windowBounds.x ?? NaN);
  const y = Number(windowBounds.y ?? NaN);
  const width = Number(windowBounds.width ?? NaN);
  const height = Number(windowBounds.height ?? NaN);
  if (![x, y, width, height].every((value) => Number.isFinite(value)) || width <= 0 || height <= 0) {
    return null;
  }

  const rawComposeBounds: InteractionCandidate["bounds"] = {
    x: x + width * 0.34,
    y: y + height * 0.14,
    width: width * 0.48,
    height: height * 0.72,
    centerX: x + width * 0.58,
    centerY: y + height * 0.5
  };
  const bodyBounds = deriveOutlookComposerBodyBounds(rawComposeBounds) ?? rawComposeBounds;
  return {
    id: "outlook-compose-window-fallback",
    surface: "desktop",
    kind: "text",
    text: "Outlook reply body",
    role: "textbox",
    bounds: bodyBounds,
    confidence: 0.42,
    sourceHints: {
      source: "window_fallback",
      ariaLabel: "Outlook reply body"
    },
    isInteractive: true
  } satisfies InteractionCandidate;
}

export function findOutlookComposeCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = conversationCandidates(worldState, {
    desktopRequiresAccessibility: true
  });
  return candidates.find((candidate) => isOutlookComposeTextboxCandidate(candidate)) ?? fallbackOutlookComposeCandidate(worldState);
}

export function findOutlookReplyButtonCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = conversationCandidates(worldState, {
    desktopRequiresAccessibility: true
  });
  return (
    candidates.find((candidate) => {
      const hintText = candidateHintText(candidate);
      return candidate.role === "button" && (/(reply|回复)/iu.test(hintText) || /(reply|回复)/iu.test(candidate.text));
    }) ?? null
  );
}

export function pickOutlookComposeQuery(worldState: WorldState | null): string {
  const composeCandidate = findOutlookComposeCandidate(worldState);
  if (!composeCandidate) {
    return /[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? "")) ? "回复" : "Reply";
  }

  const hints = (composeCandidate.sourceHints ?? {}) as Record<string, unknown>;
  return (
    String(hints.placeholder ?? hints.ariaLabel ?? composeCandidate.text ?? "").trim() ||
    (/[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? "")) ? "回复" : "Reply")
  );
}

export function findOutlookSendCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = conversationCandidates(worldState, {
    desktopRequiresAccessibility: true
  });
  return (
    candidates.find((candidate) => {
      const hintText = candidateHintText(candidate);
      return candidate.role === "button" && (SEND_PATTERN.test(hintText) || SEND_PATTERN.test(candidate.text));
    }) ?? null
  );
}

export function pickOutlookSendQuery(worldState: WorldState | null): string {
  const sendCandidate = findOutlookSendCandidate(worldState);
  if (!sendCandidate) {
    return /[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? "")) ? "发送" : "Send";
  }

  return (
    String(sendCandidate.text ?? "").trim() ||
    String(((sendCandidate.sourceHints ?? {}) as Record<string, unknown>).ariaLabel ?? "").trim() ||
    (/[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? "")) ? "发送" : "Send")
  );
}

export function extractOutlookThreadContext(worldState: WorldState | null, summary: string): string[] {
  const lines = visibleLines(worldState).filter((line) => !isOutlookUiChrome(line));
  const normalizedSummary = normalizeMailSummary(summary);
  const summaryIndex = lines.findIndex((line) => normalizeMailSummary(line) === normalizedSummary);
  const pool = summaryIndex === -1 ? lines : lines.slice(summaryIndex + 1);
  return dedupeStrings(
    pool.filter((line) => {
      const normalized = normalizeMailSummary(line);
      return (
        normalized &&
        normalized !== normalizedSummary &&
        !UNREAD_PATTERN.test(line) &&
        !isMailComposerChromeLine(line) &&
        !isOutlookUiChrome(line) &&
        !/(microsoft outlook|outlook)$/iu.test(line.trim()) &&
        !/^(inbox|focused inbox|other inbox|收件箱|重点收件箱|其他收件箱)(\s*-\s*(microsoft\s+)?outlook)?$/iu.test(
          line.trim()
        )
      );
    })
  ).slice(0, 5);
}
