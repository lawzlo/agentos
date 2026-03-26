import {
  bossSnippetLooksLikeCandidateName,
  bossSnippetLooksLikeProfileMetadata,
  bossSnippetLooksUsable,
  normalizeBossSummary
} from "./boss-semantic-facts.js";
import { candidateHintText, visibleLines } from "./surface-signal-utils.js";
import type { InteractionCandidate, WorldState } from "../types/runtime-schema.js";

const SEND_PATTERN = /(send|reply|submit|发送|回复|提交)/iu;
const BOSS_TIMESTAMP_PATTERN = /^(?:(?:[01]?\d|2[0-3]):[0-5]\d|昨天|today|yesterday|刚刚)$/iu;
const BOSS_UI_CHROME_PATTERN =
  /^(boss直聘|boss zhipin|boss|搜索|search|筛选|filter|推荐|推荐牛人|消息|message|messages|职位|jobs|候选人列表|沟通|在线沟通|立即沟通|发消息|发送|send|查看简历)$/iu;
const BROWSER_UI_CHROME_PATTERN =
  /^(your repositories|application:\s|new tab|https?:\/\/|www\.|[\w.-]+\.(com|cn|io|ai|co|org|net|app|cloud|info)(\/.*)?$)/iu;
const BOSS_DUPLICATE_LOGIN_MODAL_PATTERN =
  /(账号已经登录过了?|请勿重复登录|重复登录|已在其他窗口登录|已经登录过)/iu;
const BOSS_MODAL_CONFIRM_PATTERN = /^(ok|确定)$/iu;

interface BossVisualThreadSummaryLike {
  approxBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
}

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

function clampUnit(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  if (numeric < 0) {
    return 0;
  }
  if (numeric > 1) {
    return 1;
  }
  return numeric;
}

export function isBossUiChrome(text: string): boolean {
  return BOSS_UI_CHROME_PATTERN.test(String(text ?? "").trim());
}

export function isBrowserUiChrome(text: string): boolean {
  return BROWSER_UI_CHROME_PATTERN.test(String(text ?? "").trim());
}

export function isLowQualityBossSummary(summary: string): boolean {
  const normalized = normalizeBossSummary(summary);
  if (!normalized) {
    return true;
  }
  if (BOSS_TIMESTAMP_PATTERN.test(normalized)) {
    return true;
  }

  const chars = Array.from(normalized);
  const allowedChars = chars.filter((char) => /[\u4e00-\u9fffA-Za-z0-9\s._&@'’\-+()/]/u.test(char));
  const suspiciousChars = chars.filter((char) => !/[\u4e00-\u9fffA-Za-z0-9\s._&@'’\-+()/]/u.test(char));
  const alphaNumericOrCjkChars = chars.filter((char) => /[\u4e00-\u9fffA-Za-z0-9]/u.test(char));
  const asciiWordTokens = normalized.match(/[A-Za-z]+/gu) ?? [];

  if (alphaNumericOrCjkChars.length === 0) {
    return true;
  }
  if (!/[\u4e00-\u9fff]/u.test(normalized) && asciiWordTokens.length > 0 && asciiWordTokens.every((token) => token.length <= 1)) {
    return true;
  }
  if (allowedChars.length <= Math.floor(chars.length / 2)) {
    return true;
  }
  if (suspiciousChars.length >= 2 && suspiciousChars.length >= Math.ceil(chars.length / 3)) {
    return true;
  }

  return false;
}

export function hasBossThreadContent(worldState: WorldState | null): boolean {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  const threadSignals = candidates.filter((candidate) => {
    const source = String(((candidate.sourceHints ?? {}) as Record<string, unknown>).source ?? "").trim().toLowerCase();
    if (!source.startsWith("boss-thread")) {
      return false;
    }
    const summary = normalizeBossSummary(candidate.text || candidateHintText(candidate));
    return Boolean(summary) && !isLowQualityBossSummary(summary) && !isBossUiChrome(summary);
  });
  if (threadSignals.length >= 2) {
    return true;
  }

  const visible = String(worldState?.visibleText ?? "");
  return /在线沟通/u.test(visible) && /boss/iu.test(String(worldState?.appContext?.title ?? ""));
}

export function deriveBossComposeFallbackPoint(worldState: WorldState | null): { x: number; y: number } | null {
  if (!hasBossThreadContent(worldState)) {
    return null;
  }
  return { x: 0.47, y: 0.87 };
}

export function deriveBossComposeFallbackBounds(worldState: WorldState | null): InteractionCandidate["bounds"] | null {
  if (!hasBossThreadContent(worldState)) {
    return null;
  }
  const frame = ((worldState?.capture as { metadata?: { windowBounds?: InteractionCandidate["bounds"] } } | null)?.metadata
    ?.windowBounds ?? null) as InteractionCandidate["bounds"] | null;
  if (!frame) {
    return null;
  }

  const x = Number(frame.x ?? 0);
  const y = Number(frame.y ?? 0);
  const width = Number(frame.width ?? 0);
  const height = Number(frame.height ?? 0);
  if (!(width > 0 && height > 0)) {
    return null;
  }

  const left = x + width * 0.44;
  const top = y + height * 0.79;
  const right = x + width * 0.95;
  const bottom = y + height * 0.95;
  if (!(right > left && bottom > top)) {
    return null;
  }

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    centerX: left + (right - left) / 2,
    centerY: top + (bottom - top) / 2
  };
}

export function deriveBossOpenTarget(value: string): string {
  const normalized = normalizeBossSummary(value);
  if (!normalized) {
    return "";
  }

  const separatorPrefix = normalized.split(/\s*[·•｜|]\s*/u)[0]?.trim() ?? "";
  if (separatorPrefix && separatorPrefix !== normalized) {
    return separatorPrefix;
  }

  const cjkLead = normalized.match(/^([\u4e00-\u9fff]{2,8})\s+\S+/u);
  if (cjkLead?.[1]) {
    return cjkLead[1];
  }

  return normalized;
}

export function scoreBossTargetNameMatch(candidateText: string, target: string): number | null {
  const summary = normalizeBossSummary(candidateText);
  const normalizedTarget = normalizeBossSummary(target);
  if (!summary || !normalizedTarget) {
    return null;
  }
  if (summary === normalizedTarget) {
    return 120;
  }
  if (summary.startsWith(normalizedTarget) || normalizedTarget.startsWith(summary)) {
    return 108;
  }
  if (summary.includes(normalizedTarget) || normalizedTarget.includes(summary)) {
    return 96;
  }
  return null;
}

export function findBossListCandidateByTarget(
  worldState: WorldState | null,
  target: string
): InteractionCandidate | null {
  const normalizedTarget = normalizeBossSummary(target);
  if (!normalizedTarget) {
    return null;
  }

  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  const ranked = candidates
    .filter((candidate) => {
      const source = String(((candidate.sourceHints ?? {}) as Record<string, unknown>).source ?? "").trim().toLowerCase();
      return source.startsWith("boss-list");
    })
    .map((candidate) => ({
      candidate,
      score: scoreBossTargetNameMatch(candidate.text || candidateHintText(candidate), normalizedTarget)
    }))
    .filter((entry): entry is { candidate: InteractionCandidate; score: number } => Number.isFinite(entry.score))
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      const leftY = Number(left.candidate.bounds?.centerY ?? Number.POSITIVE_INFINITY);
      const rightY = Number(right.candidate.bounds?.centerY ?? Number.POSITIVE_INFINITY);
      return leftY - rightY;
    });
  return ranked[0]?.candidate ?? null;
}

export function isBossLikelyMidListCandidate(
  candidate: InteractionCandidate | null | undefined,
  worldState: WorldState | null
): boolean {
  if (!candidate) {
    return false;
  }
  const source = String(((candidate.sourceHints ?? {}) as Record<string, unknown>).source ?? "").trim().toLowerCase();
  if (!source.startsWith("boss-list")) {
    return false;
  }
  const centerY = Number(candidate.bounds?.centerY ?? Number.NaN);
  const appBounds = ((worldState?.capture?.metadata ?? {}) as {
    windowBounds?: { y?: number; height?: number };
  }).windowBounds;
  const threshold =
    Number.isFinite(Number(appBounds?.y)) && Number.isFinite(Number(appBounds?.height))
      ? Number(appBounds?.y) + Number(appBounds?.height) * 0.38
      : Number.NaN;
  return Number.isFinite(centerY) && Number.isFinite(threshold) && centerY > threshold;
}

export function deriveBossTopVisibleRowPoint(worldState: WorldState | null): { x: number; y: number } | null {
  const frame = ((worldState?.capture as { metadata?: { windowBounds?: InteractionCandidate["bounds"] } } | null)?.metadata
    ?.windowBounds ?? null) as InteractionCandidate["bounds"] | null;
  if (!frame) {
    return null;
  }
  return { x: 0.31, y: 0.275 };
}

export function deriveBossVisionRowPoint(
  visionThread: BossVisualThreadSummaryLike | null | undefined
): { x: number; y: number } | null {
  const box = visionThread?.approxBox ?? null;
  if (!box) {
    return null;
  }
  const centerY = clampUnit(box.y + box.height * 0.5, 0.275);
  return {
    x: 0.31,
    y: centerY
  };
}

export function pickBossThreadName(worldState: WorldState | null, fallback: string): string {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  const frame = ((worldState?.capture as { metadata?: { windowBounds?: InteractionCandidate["bounds"] } } | null)?.metadata
    ?.windowBounds ?? null) as InteractionCandidate["bounds"] | null;
  const headerCutoff =
    Number.isFinite(Number(frame?.y)) && Number.isFinite(Number(frame?.height))
      ? Number(frame?.y) + Number(frame?.height) * 0.26
      : Number.NaN;
  const ranked = candidates
    .filter((candidate) => {
      const source = String(((candidate.sourceHints ?? {}) as Record<string, unknown>).source ?? "").trim().toLowerCase();
      if (!(source.startsWith("boss-thread-name") || source.startsWith("boss-thread"))) {
        return false;
      }
      const summary = normalizeBossSummary(candidate.text || candidateHintText(candidate));
      if (!summary || isLowQualityBossSummary(summary) || isBossUiChrome(summary)) {
        return false;
      }
      const centerY = Number(candidate.bounds?.centerY ?? Number.NaN);
      return !Number.isFinite(headerCutoff) || !Number.isFinite(centerY) || centerY <= headerCutoff;
    })
    .sort((left, right) => {
      const leftY = Number(left.bounds?.centerY ?? Number.POSITIVE_INFINITY);
      const rightY = Number(right.bounds?.centerY ?? Number.POSITIVE_INFINITY);
      return leftY - rightY;
    });
  return normalizeBossSummary(ranked[0]?.text || candidateHintText(ranked[0])) || fallback;
}

export function scoreBossCandidate({
  candidate,
  worldState
}: {
  candidate: InteractionCandidate;
  worldState: WorldState | null;
}): number | null {
  const hintText = candidateHintText(candidate);
  const summary = normalizeBossSummary(candidate.text || hintText);
  if (!summary || isLowQualityBossSummary(summary) || isBossUiChrome(summary) || isBrowserUiChrome(summary) || SEND_PATTERN.test(summary)) {
    return null;
  }

  const centerX = Number(candidate.bounds?.centerX ?? Number.NaN);
  const appBounds = ((worldState?.capture?.metadata ?? {}) as {
    windowBounds?: { x?: number; width?: number };
  }).windowBounds;
  const candidateListRightCutoff =
    Number.isFinite(Number(appBounds?.x)) && Number.isFinite(Number(appBounds?.width))
      ? Number(appBounds?.x) + Number(appBounds?.width) * 0.48
      : Number.NaN;
  if (Number.isFinite(centerX) && Number.isFinite(candidateListRightCutoff) && centerX >= candidateListRightCutoff) {
    return null;
  }

  let score = candidate.isInteractive ? 12 : 4;
  if (candidate.role === "button" || candidate.role === "link") {
    score += 4;
  }
  if (/(candidate|候选人|resume|简历|new candidate|新候选人|待沟通|待跟进|沟通中|message|消息|chat|在线沟通)/iu.test(hintText)) {
    score += 24;
  }

  const lines = visibleLines(worldState);
  for (const [index, line] of lines.entries()) {
    if (!/(candidate|候选人|新候选人|待沟通|待跟进|消息|沟通)/iu.test(line)) {
      continue;
    }
    const nearby = lines
      .slice(Math.max(0, index - 1), index + 6)
      .some((entry) => entry.includes(summary) || summary.includes(normalizeBossSummary(entry)));
    if (nearby) {
      score += 16;
      break;
    }
  }

  if (summary.length >= 2 && summary.length <= 80) {
    score += 3;
  }
  if (/[\u4e00-\u9fff]/u.test(summary)) {
    score += 2;
  }
  const confidence = Number(candidate.confidence ?? Number.NaN);
  const source = String(((candidate.sourceHints ?? {}) as Record<string, unknown>).source ?? "");
  if (source.startsWith("boss-") && Number.isFinite(confidence) && confidence < 0.55) {
    score -= 18;
  }
  if (source === "boss-list-unread") {
    score += 22;
  }
  if (!source.startsWith("boss-list")) {
    score -= 12;
  }

  return score;
}

function bossCandidateSourcePriority(candidate: InteractionCandidate): number {
  const source = String(((candidate.sourceHints ?? {}) as Record<string, unknown>).source ?? "").trim().toLowerCase();
  if (source === "boss-list-unread") {
    return 0;
  }
  if (source.startsWith("boss-list")) {
    return 1;
  }
  if (source.startsWith("boss-thread")) {
    return 3;
  }
  return 2;
}

export function findBossCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  const ranked = candidates
    .map((candidate) => ({ candidate, score: scoreBossCandidate({ candidate, worldState }) }))
    .filter((entry): entry is { candidate: InteractionCandidate; score: number } => Number.isFinite(entry.score))
    .sort((left, right) => {
      const sourceDelta = bossCandidateSourcePriority(left.candidate) - bossCandidateSourcePriority(right.candidate);
      if (sourceDelta !== 0) {
        return sourceDelta;
      }
      const scoreDelta = right.score - left.score;
      if (Math.abs(scoreDelta) >= 8) {
        return scoreDelta;
      }
      const leftY = Number(left.candidate.bounds?.centerY ?? Number.POSITIVE_INFINITY);
      const rightY = Number(right.candidate.bounds?.centerY ?? Number.POSITIVE_INFINITY);
      if (Number.isFinite(leftY) || Number.isFinite(rightY)) {
        return leftY - rightY;
      }
      return scoreDelta;
    });
  return ranked[0]?.candidate ?? null;
}

export function sanitizeBossOpenCandidate(
  candidate: Record<string, unknown> | InteractionCandidate | null
): Record<string, unknown> | null {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  const text = String((candidate as { text?: unknown }).text ?? "").trim();
  if (!text) {
    return null;
  }
  const sourceHints = ((candidate as { sourceHints?: unknown }).sourceHints ?? null) as Record<string, unknown> | null;
  const source = String(sourceHints?.source ?? "").trim().toLowerCase();
  if (source && source !== "vision") {
    return candidate as Record<string, unknown>;
  }
  return {
    id: String((candidate as { id?: unknown }).id ?? "boss-open-target").trim() || "boss-open-target",
    surface: "browser",
    kind: "text",
    text,
    role: String((candidate as { role?: unknown }).role ?? "text").trim() || "text",
    isInteractive: true,
    ...(((candidate as { bounds?: unknown }).bounds && typeof (candidate as { bounds?: unknown }).bounds === "object")
      ? { bounds: (candidate as { bounds?: unknown }).bounds as Record<string, unknown> }
      : {}),
    ...(sourceHints ? { sourceHints } : {})
  };
}

export function extractBossContext(worldState: WorldState | null, summary: string): string[] {
  const lines = visibleLines(worldState).filter((line) => !isBossUiChrome(line));
  const normalizedSummary = normalizeBossSummary(summary);
  const summaryIndex = lines.findIndex((line) => normalizeBossSummary(line) === normalizedSummary);
  const pool = summaryIndex === -1 ? lines : lines.slice(Math.max(0, summaryIndex - 1), summaryIndex + 5);
  return uniqueStrings(
    pool.filter((line) => {
      const normalized = normalizeBossSummary(line);
      return (
        normalized &&
        normalized !== normalizedSummary &&
        !SEND_PATTERN.test(line) &&
        !isBossUiChrome(line) &&
        !bossSnippetLooksLikeCandidateName(line) &&
        !bossSnippetLooksLikeProfileMetadata(line) &&
        bossSnippetLooksUsable(line)
      );
    })
  ).slice(0, 5);
}

export function findBossComposeCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  return (
    candidates.find((candidate) => {
      const hintText = candidateHintText(candidate);
      const summary = normalizeBossSummary(candidate.text || hintText);
      const tag = String(((candidate.sourceHints ?? {}) as Record<string, unknown>).tag ?? "").toLowerCase();
      const source = String(((candidate.sourceHints ?? {}) as Record<string, unknown>).source ?? "").toLowerCase();
      const centerY = Number(candidate.bounds?.centerY ?? Number.NaN);
      const appBounds = ((worldState?.capture?.metadata ?? {}) as {
        windowBounds?: { y?: number; height?: number };
      }).windowBounds;
      const upperChromeCutoff =
        Number.isFinite(Number(appBounds?.y)) && Number.isFinite(Number(appBounds?.height))
          ? Number(appBounds?.y) + Number(appBounds?.height) * 0.22
          : Number.NaN;
      if (
        !summary ||
        isBossUiChrome(summary) ||
        isBrowserUiChrome(summary) ||
        /zhipin\.com\/web\/chat/iu.test(summary) ||
        (Number.isFinite(centerY) && Number.isFinite(upperChromeCutoff) && centerY <= upperChromeCutoff)
      ) {
        return false;
      }
      if (source.startsWith("boss-compose")) {
        return true;
      }
      if (candidate.role === "textbox" || ["input", "textarea"].includes(tag)) {
        return true;
      }
      if (candidate.role === "button") {
        return false;
      }
      return (
        /(message|reply|chat|contact|消息|回复|输入|联系)/iu.test(hintText) ||
        /(message|reply|chat|contact|消息|回复|输入|联系)/iu.test(candidate.text)
      );
    }) ?? null
  );
}

export function pickBossComposeQuery(worldState: WorldState | null): string {
  const composeCandidate = findBossComposeCandidate(worldState);

  if (!composeCandidate) {
    return /[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? "")) ? "发送消息" : "Message";
  }

  const hints = (composeCandidate.sourceHints ?? {}) as Record<string, unknown>;
  return (
    String(hints.placeholder ?? hints.ariaLabel ?? composeCandidate.text ?? "").trim() ||
    (/[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? "")) ? "发送消息" : "Message")
  );
}

export function findBossSendCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  return (
    candidates.find((candidate) => {
      const hintText = candidateHintText(candidate);
      const source = String(((candidate.sourceHints ?? {}) as Record<string, unknown>).source ?? "").toLowerCase();
      return (source.startsWith("boss-send") || candidate.role === "button") && (SEND_PATTERN.test(hintText) || SEND_PATTERN.test(candidate.text));
    }) ?? null
  );
}

export function pickBossSendQuery(worldState: WorldState | null): string {
  const sendCandidate = findBossSendCandidate(worldState);

  if (!sendCandidate) {
    return /[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? "")) ? "发送" : "Send";
  }

  return (
    String(sendCandidate.text ?? "").trim() ||
    String(((sendCandidate.sourceHints ?? {}) as Record<string, unknown>).ariaLabel ?? "").trim() ||
    (/[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? "")) ? "发送" : "Send")
  );
}

export function hasBossDuplicateLoginModal(worldState: WorldState | null): boolean {
  const lines = visibleLines(worldState)
    .slice(0, 60)
    .map((line) => String(line ?? "").trim())
    .filter(Boolean);
  const pageText = lines.join("\n");
  if (BOSS_DUPLICATE_LOGIN_MODAL_PATTERN.test(pageText)) {
    return true;
  }

  const hasBossSiteAlert = lines.some((line) => /(www\.zhipin\.com says|zhipin\.com says)/iu.test(line));
  const hasConfirm = lines.some((line) => BOSS_MODAL_CONFIRM_PATTERN.test(line));
  return hasBossSiteAlert && hasConfirm;
}

export function isBossSiteAlertConfirmModal(worldState: WorldState | null): boolean {
  const lines = visibleLines(worldState)
    .slice(0, 60)
    .map((line) => String(line ?? "").trim())
    .filter(Boolean);
  const hasBossSiteAlert = lines.some((line) => /(www\.zhipin\.com says|zhipin\.com says)/iu.test(line));
  const hasConfirm = lines.some((line) => BOSS_MODAL_CONFIRM_PATTERN.test(line));
  return hasBossSiteAlert && hasConfirm;
}

export function findBossDuplicateLoginConfirmCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  const ranked = candidates
    .filter((candidate) => {
      const text = String(candidate.text ?? "").trim();
      const hintText = candidateHintText(candidate);
      return (
        BOSS_MODAL_CONFIRM_PATTERN.test(text) ||
        (candidate.role === "button" && BOSS_MODAL_CONFIRM_PATTERN.test(hintText))
      );
    })
    .sort((left, right) => Number(right.confidence ?? 0) - Number(left.confidence ?? 0));
  return ranked[0] ?? null;
}

export function extractBossThreadContext(worldState: WorldState | null, summary: string): string[] {
  const lines = visibleLines(worldState).filter((line) => !isBossUiChrome(line));
  const normalizedSummary = normalizeBossSummary(summary);
  const summaryIndex = lines.findIndex((line) => normalizeBossSummary(line) === normalizedSummary);
  const pool = summaryIndex === -1 ? lines : lines.slice(Math.max(0, summaryIndex - 1), summaryIndex + 8);
  return uniqueStrings(
    pool
      .filter((line) => !/^(发送消息|message|reply|chat|contact|沟通|回复|输入|联系)/iu.test(line.trim()))
      .filter((line) => {
        const normalized = normalizeBossSummary(line);
        return (
          normalized &&
          normalized !== normalizedSummary &&
          !SEND_PATTERN.test(line) &&
          !isBossUiChrome(line) &&
          !bossSnippetLooksLikeCandidateName(line) &&
          !bossSnippetLooksLikeProfileMetadata(line) &&
          bossSnippetLooksUsable(line)
        );
      })
  ).slice(0, 6);
}
