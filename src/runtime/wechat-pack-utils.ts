import { normalizeWeChatSummary } from "./wechat-semantic-facts.js";
import {
  candidateHintText,
  conversationCandidates,
  visibleLines,
  wechatCandidates
} from "./surface-signal-utils.js";
import { findDesktopWindowBounds } from "./vision-frame-utils.js";
import type { InteractionCandidate, WorldState } from "../types/runtime-schema.js";

const SEND_PATTERN = /(send|reply|submit|发送|回复|提交)/iu;
const UNREAD_PATTERN = /(unread|mention|new message|new messages|未读|新消息)/iu;
const WECHAT_UI_CHROME_PATTERN =
  /^(wechat|微信|搜索|search|send|发送|reply|回复|聊天信息|聊天记录|通讯录|contacts|发现|moments|我|me|文件传输助手|表情|图片|文件|语音消息)$/iu;
const WECHAT_THREAD_PANE_REGION = {
  x: 0.18,
  y: 0.05,
  width: 0.82,
  height: 0.74
};
const WECHAT_THREAD_BODY_REGION = {
  x: 0.32,
  y: 0.14,
  width: 0.64,
  height: 0.56
};
const WECHAT_COMPOSER_REGION = {
  x: 0.28,
  y: 0.76,
  width: 0.68,
  height: 0.22
};

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

export function isWeChatUiChrome(text: string): boolean {
  return WECHAT_UI_CHROME_PATTERN.test(String(text ?? "").trim());
}

function looksLikeDateOrTimeToken(value: string): boolean {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return false;
  }

  return (
    /^\d{1,4}[/:.-]\d{1,2}(?:[/:.-]\d{1,4})?$/u.test(normalized) ||
    /^\d{1,2}:\d{2}(?::\d{2})?$/u.test(normalized)
  );
}

function looksLikeUrlOrDomainToken(value: string): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes("http://") ||
    normalized.includes("https://") ||
    normalized.includes("www.") ||
    /\b[a-z0-9-]+\.(?:com|cn|net|org|io|co|app)\b/u.test(normalized)
  );
}

function symbolNoiseRatio(value: string): number {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return 1;
  }

  const signalCount = (normalized.match(/[\p{L}\p{N}\u4e00-\u9fff]/gu) ?? []).length;
  return Math.max(0, normalized.length - signalCount) / normalized.length;
}

function isScreenSource(value: unknown) {
  return String(value ?? "").trim().toLowerCase().startsWith("screen");
}

export function findWeChatWindowGeometry(worldState: WorldState | null): {
  windowBounds: InteractionCandidate["bounds"] | null;
  captureWindowNumber: number | null;
  windowNumber: number | null;
} {
  const appContext = (worldState?.appContext ?? null) as Record<string, unknown> | null;
  const windows = Array.isArray(appContext?.windows)
    ? (appContext.windows as Array<Record<string, unknown>>).filter((entry) => {
        const owner = String(entry?.ownerName ?? "").toLowerCase();
        return owner.includes("wechat") || owner.includes("微信");
      })
    : [];
  const primaryWindow = windows[0] ?? null;
  return {
    windowBounds: (primaryWindow?.bounds ?? null) as InteractionCandidate["bounds"] | null,
    captureWindowNumber: Number.isFinite(Number(appContext?.captureWindowNumber ?? Number.NaN))
      ? Number(appContext?.captureWindowNumber ?? Number.NaN)
      : null,
    windowNumber: Number.isFinite(Number((primaryWindow as Record<string, unknown> | null)?.windowNumber ?? Number.NaN))
      ? Number((primaryWindow as Record<string, unknown> | null)?.windowNumber ?? Number.NaN)
      : null
  };
}

function relativeWeChatCandidatePosition(
  candidate: InteractionCandidate | null,
  worldState: WorldState | null
): { x: number; y: number; width: number; height: number } | null {
  if (!candidate?.bounds) {
    return null;
  }

  const { windowBounds, captureWindowNumber, windowNumber } = findWeChatWindowGeometry(worldState);
  if (!windowBounds) {
    return null;
  }

  const width = Math.max(1, Number(windowBounds.width ?? 1));
  const height = Math.max(1, Number(windowBounds.height ?? 1));
  const usingWindowLocalCoordinates =
    Number.isFinite(Number(captureWindowNumber)) &&
    Number(captureWindowNumber) > 0 &&
    Number.isFinite(Number(windowNumber)) &&
    Number(captureWindowNumber) === Number(windowNumber);
  const x = usingWindowLocalCoordinates
    ? Number(candidate.bounds.centerX ?? 0)
    : Number(candidate.bounds.centerX ?? 0) - Number(windowBounds.x ?? 0);
  const y = usingWindowLocalCoordinates
    ? Number(candidate.bounds.centerY ?? 0)
    : Number(candidate.bounds.centerY ?? 0) - Number(windowBounds.y ?? 0);

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  return { x, y, width, height };
}

function isWeChatBadgeLikeText(value: unknown): boolean {
  return /^(?:\d{1,3}|\d{1,3}\+)$/.test(String(value ?? "").trim());
}

function hasWeChatUnreadBadgeNearCandidate(candidate: InteractionCandidate, worldState: WorldState | null): boolean {
  const position = relativeWeChatCandidatePosition(candidate, worldState);
  if (!position) {
    return false;
  }

  return wechatCandidates(worldState).some((other) => {
    if (!other || other.id === candidate.id || !isWeChatBadgeLikeText(other.text)) {
      return false;
    }
    const otherPosition = relativeWeChatCandidatePosition(other, worldState);
    if (!otherPosition) {
      return false;
    }
    const rowAligned = Math.abs(otherPosition.y - position.y) <= Math.max(28, position.height * 0.9);
    const nearLeft = otherPosition.x >= 0 && otherPosition.x < position.x && position.x - otherPosition.x <= 96;
    return rowAligned && nearLeft;
  });
}

export function hasWeChatUnreadEvidence(candidate: InteractionCandidate, worldState: WorldState | null): boolean {
  const hintText = candidateHintText(candidate);
  const summary = normalizeWeChatSummary(candidate.text || hintText);
  if (!summary) {
    return false;
  }
  if (UNREAD_PATTERN.test(hintText) || UNREAD_PATTERN.test(candidate.text)) {
    return true;
  }
  if (hasWeChatUnreadBadgeNearCandidate(candidate, worldState)) {
    return true;
  }

  const lines = visibleLines(worldState);
  for (const [index, line] of lines.entries()) {
    if (!UNREAD_PATTERN.test(line)) {
      continue;
    }
    const nearby = lines
      .slice(Math.max(0, index - 2), index + 6)
      .some((entry) => entry.includes(summary) || summary.includes(normalizeWeChatSummary(entry)));
    if (nearby) {
      return true;
    }
  }

  return false;
}

export function scoreWeChatCandidate({
  candidate,
  worldState
}: {
  candidate: InteractionCandidate;
  worldState: WorldState | null;
}): number | null {
  const hintText = candidateHintText(candidate);
  const summary = normalizeWeChatSummary(candidate.text || hintText);
  if (!summary || isWeChatUiChrome(summary) || SEND_PATTERN.test(summary)) {
    return null;
  }

  const source = String((candidate.sourceHints ?? {}).source ?? "").toLowerCase();
  let score = candidate.isInteractive ? 12 : 4;
  if (candidate.role === "button" || candidate.role === "link" || candidate.role === "text") {
    score += 3;
  }
  if (candidate.role === "row") {
    score += 6;
  }
  if (source === "accessibility") {
    score += 12;
  }
  if (isScreenSource(source)) {
    score += 6;
  }
  if (source.includes("screen-wechat-list")) {
    score += 18;
  }
  if (source.includes("screen-wechat-compose")) {
    score -= 32;
  }
  const unreadEvidence = hasWeChatUnreadEvidence(candidate, worldState);
  if (UNREAD_PATTERN.test(hintText)) {
    score += 28;
  }
  if (unreadEvidence) {
    score += 18;
  } else {
    score -= 18;
  }

  const lines = visibleLines(worldState);
  for (const [index, line] of lines.entries()) {
    if (!UNREAD_PATTERN.test(line)) {
      continue;
    }
    const nearby = lines
      .slice(Math.max(0, index - 2), index + 6)
      .some((entry) => entry.includes(summary) || summary.includes(normalizeWeChatSummary(entry)));
    if (nearby) {
      score += 18;
      break;
    }
  }

  if (/[\u4e00-\u9fff]/u.test(summary)) {
    score += 2;
  }
  if (summary.length >= 2 && summary.length <= 48) {
    score += 3;
  }
  if (looksLikeDateOrTimeToken(summary)) {
    score -= 16;
  }
  if (looksLikeUrlOrDomainToken(summary)) {
    score -= 18;
  }
  if (symbolNoiseRatio(summary) >= 0.35) {
    score -= 10;
  }
  if (/[\p{L}\u4e00-\u9fff]/u.test(summary) && !looksLikeUrlOrDomainToken(summary) && !looksLikeDateOrTimeToken(summary)) {
    score += 6;
  }
  if (isScreenSource(source)) {
    const appContext = (worldState?.appContext ?? null) as Record<string, unknown> | null;
    const windows = Array.isArray(appContext?.windows)
      ? (appContext.windows as Array<Record<string, unknown>>).filter((entry) => {
          const owner = String(entry?.ownerName ?? "").toLowerCase();
          return owner.includes("wechat") || owner.includes("微信");
        })
      : [];
    const primaryWindow = windows[0] ?? null;
    const captureWindowNumber = Number(appContext?.captureWindowNumber ?? Number.NaN);
    const bounds = candidate.bounds ?? null;
    const windowBounds = (primaryWindow?.bounds ?? null) as InteractionCandidate["bounds"] | null;
    if (bounds && windowBounds) {
      const windowNumber = Number((primaryWindow as Record<string, unknown> | null)?.windowNumber ?? Number.NaN);
      const windowWidth = Math.max(1, Number(windowBounds.width ?? 1));
      const windowHeight = Math.max(1, Number(windowBounds.height ?? 1));
      const usingWindowLocalCoordinates =
        Number.isFinite(captureWindowNumber) &&
        captureWindowNumber > 0 &&
        Number.isFinite(windowNumber) &&
        captureWindowNumber === windowNumber;
      const relativeX = usingWindowLocalCoordinates
        ? Number(bounds.centerX ?? 0)
        : Number(bounds.centerX ?? 0) - Number(windowBounds.x ?? 0);
      const relativeY = usingWindowLocalCoordinates
        ? Number(bounds.centerY ?? 0)
        : Number(bounds.centerY ?? 0) - Number(windowBounds.y ?? 0);
      if (relativeX >= 0 && relativeX <= windowWidth * 0.45) {
        score += 12;
      }
      if (relativeX > windowWidth * 0.5) {
        score -= 10;
      }
      if (relativeY >= 0 && relativeY <= windowHeight * 0.12) {
        score -= 18;
      }
      if (relativeY >= 0 && relativeY <= windowHeight * 0.82) {
        score += 4;
      }
      if (relativeY >= windowHeight * 0.86) {
        score -= 10;
      }
    }
  }

  return score;
}

export function rankWeChatUnreadCandidates(worldState: WorldState | null): Array<{
  candidate: InteractionCandidate;
  score: number;
}> {
  const candidates = conversationCandidates(worldState);
  return candidates
    .map((candidate) => ({ candidate, score: scoreWeChatCandidate({ candidate, worldState }) }))
    .filter(
      (entry): entry is { candidate: InteractionCandidate; score: number } =>
        Number.isFinite(entry.score) && hasWeChatUnreadEvidence(entry.candidate, worldState)
    )
    .sort((left, right) => right.score - left.score);
}

export function findWeChatUnreadCandidate(worldState: WorldState | null): InteractionCandidate | null {
  return rankWeChatUnreadCandidates(worldState)[0]?.candidate ?? null;
}

function isWeChatCandidateInRegion(
  candidate: InteractionCandidate | null,
  worldState: WorldState | null,
  region: { x: number; y: number; width: number; height: number }
): boolean {
  const position = relativeWeChatCandidatePosition(candidate, worldState);
  if (!position) {
    return false;
  }

  return (
    position.x >= position.width * region.x &&
    position.x <= position.width * (region.x + region.width) &&
    position.y >= position.height * region.y &&
    position.y <= position.height * (region.y + region.height)
  );
}

function isWeChatCandidateInComposeRegion(candidate: InteractionCandidate | null, worldState: WorldState | null): boolean {
  return isWeChatCandidateInRegion(candidate, worldState, WECHAT_COMPOSER_REGION);
}

function isWeChatCandidateInThreadPane(candidate: InteractionCandidate | null, worldState: WorldState | null): boolean {
  return isWeChatCandidateInRegion(candidate, worldState, WECHAT_THREAD_PANE_REGION);
}

export function isWeChatCandidateInThreadBody(candidate: InteractionCandidate | null, worldState: WorldState | null): boolean {
  return isWeChatCandidateInRegion(candidate, worldState, WECHAT_THREAD_BODY_REGION);
}

export function findWeChatThreadTargetCandidate(worldState: WorldState | null, summary: string): InteractionCandidate | null {
  const normalizedSummary = normalizeWeChatSummary(summary);
  if (!normalizedSummary) {
    return null;
  }

  const candidates = wechatCandidates(worldState);
  return (
    candidates.find((candidate) => {
      if (!isWeChatCandidateInThreadPane(candidate, worldState)) {
        return false;
      }
      const candidateSummary = normalizeWeChatSummary(candidate.text || candidateHintText(candidate));
      return (
        candidateSummary === normalizedSummary ||
        candidateSummary.includes(normalizedSummary) ||
        normalizedSummary.includes(candidateSummary)
      );
    }) ?? null
  );
}

function looksLikeWeChatComposePlaceholder(value: unknown): boolean {
  return /(input message|type a message|message input|enter message|write a message|输入消息|请输入|发消息|回复)/iu.test(
    String(value ?? "")
  );
}

function looksLikeWeChatComposeNoise(value: unknown): boolean {
  return /(\b\d+\s+message(?:\(s\)|s)?\b|\[(video|link|photo|image)\]|https?:\/\/|official accounts|公众号)/iu.test(
    String(value ?? "")
  );
}

export function findWeChatComposeCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = conversationCandidates(worldState);
  return (
    candidates.find((candidate) => {
      const source = String((candidate.sourceHints ?? {}).source ?? "").toLowerCase();
      const hintText = candidateHintText(candidate);
      const inComposeRegion = isWeChatCandidateInComposeRegion(candidate, worldState);
      const placeholderSignal =
        looksLikeWeChatComposePlaceholder(hintText) || looksLikeWeChatComposePlaceholder(candidate.text);
      const sourceIsComposeRegion = source.includes("screen-wechat-compose");
      if (looksLikeWeChatComposeNoise(hintText) || looksLikeWeChatComposeNoise(candidate.text)) {
        return false;
      }
      return (
        (candidate.role === "textbox" && inComposeRegion) ||
        (sourceIsComposeRegion && placeholderSignal && inComposeRegion) ||
        (placeholderSignal && inComposeRegion)
      );
    }) ?? null
  );
}

export function pickWeChatComposeQuery(worldState: WorldState | null): string {
  const composeCandidate = findWeChatComposeCandidate(worldState);

  if (!composeCandidate) {
    return /[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? "")) ? "输入" : "Message";
  }

  const hints = (composeCandidate.sourceHints ?? {}) as Record<string, unknown>;
  return (
    String(hints.placeholder ?? hints.ariaLabel ?? composeCandidate.text ?? "").trim() ||
    (/[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? "")) ? "输入" : "Message")
  );
}

export function findWeChatSendCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = conversationCandidates(worldState);
  return (
    candidates.find((candidate) => {
      const hintText = candidateHintText(candidate);
      const source = String((candidate.sourceHints ?? {}).source ?? "").toLowerCase();
      return (
        (candidate.role === "button" || isScreenSource(source)) &&
        (SEND_PATTERN.test(hintText) || SEND_PATTERN.test(candidate.text))
      );
    }) ?? null
  );
}

export function pickWeChatSendQuery(worldState: WorldState | null): string {
  const sendCandidate = findWeChatSendCandidate(worldState);

  if (!sendCandidate) {
    return /[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? "")) ? "发送" : "Send";
  }

  return (
    String(sendCandidate.text ?? "").trim() ||
    String(((sendCandidate.sourceHints ?? {}) as Record<string, unknown>).ariaLabel ?? "").trim() ||
    (/[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? "")) ? "发送" : "Send")
  );
}

export function deriveWeChatConversationListPoint(worldState: WorldState | null): { x: number; y: number } | null {
  const windowBounds = findDesktopWindowBounds(worldState, "WeChat");
  if (windowBounds) {
    return {
      x: Math.round(Number(windowBounds.x ?? 0) + Number(windowBounds.width ?? 0) * 0.22),
      y: Math.round(Number(windowBounds.y ?? 0) + Number(windowBounds.height ?? 0) * 0.3)
    };
  }

  return null;
}

export function extractWeChatThreadContext(worldState: WorldState | null, summary: string): string[] {
  const threadRegionLines = wechatCandidates(worldState)
    .filter((candidate) => isWeChatCandidateInThreadBody(candidate, worldState))
    .map((candidate) => String(candidate.text ?? "").trim())
    .filter(Boolean);
  const lines = uniqueStrings(threadRegionLines.length >= 2 ? threadRegionLines : visibleLines(worldState)).filter(
    (line) => !isWeChatUiChrome(line)
  );
  const normalizedSummary = normalizeWeChatSummary(summary);
  const summaryIndex = lines.findIndex((line) => normalizeWeChatSummary(line) === normalizedSummary);
  const pool = summaryIndex === -1 ? lines : lines.slice(summaryIndex + 1);
  return uniqueStrings(
    pool.filter((line) => {
      const normalized = normalizeWeChatSummary(line);
      return (
        normalized &&
        normalized !== normalizedSummary &&
        !UNREAD_PATTERN.test(line) &&
        !SEND_PATTERN.test(line) &&
        !/(message|reply|input|chat|消息|回复|输入|请输入)/iu.test(line)
      );
    })
  ).slice(0, 4);
}

export function deriveWeChatComposerFallback(worldState: WorldState | null): { x: number; y: number } | null {
  const bounds = findDesktopWindowBounds(worldState, "WeChat");
  if (!bounds) {
    return null;
  }
  const x = Number(bounds.x ?? 0);
  const y = Number(bounds.y ?? 0);
  const width = Number(bounds.width ?? 0);
  const height = Number(bounds.height ?? 0);
  if (!(width > 0 && height > 0)) {
    return null;
  }

  return {
    x: x + width * 0.64,
    y: y + height * 0.9
  };
}
