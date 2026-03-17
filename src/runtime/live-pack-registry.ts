import crypto from "node:crypto";
import type { ControlPlane } from "./control-plane.js";
import type { SurfaceRegistry } from "./surface-registry.js";
import type {
  InteractionCandidate,
  LivePackInfo,
  RuntimeStep,
  TaskRecord,
  WatchDetection,
  WatchRule,
  WorldState,
  WorkspaceProfile,
  WorkspaceRecord
} from "../types/runtime-schema.js";

interface LivePackControlPlane extends Pick<ControlPlane, "modelClient" | "surfaceRegistry"> {}

interface LivePackActivationArgs {
  rule: WatchRule;
  workspace: WorkspaceProfile;
  surfaceRegistry: SurfaceRegistry;
  controlPlane: LivePackControlPlane;
}

interface LivePackObserveArgs extends LivePackActivationArgs {}

interface LivePackDetectionArgs extends LivePackActivationArgs {
  worldState: WorldState | null;
  dedupeState?: Record<string, unknown>;
}

interface LivePackExtractContextArgs extends LivePackDetectionArgs {
  detection: WatchDetection;
}

interface LivePackDraftArgs {
  rule: WatchRule;
  detection: WatchDetection;
  controlPlane: LivePackControlPlane;
}

interface LivePackMarkHandledArgs {
  rule: WatchRule;
  task: TaskRecord;
  controlPlane: LivePackControlPlane;
}

type LivePackSurface = "browser" | "desktop";

const SEND_PATTERN = /(send|reply|submit|发送|回复|提交)/iu;
const UNREAD_PATTERN = /(unread|mention|new message|new messages|未读|新消息)/iu;
const SLACK_UI_CHROME_PATTERN =
  /^(search|compose|home|later|activity|more|threads|drafts|canvas|huddle|send|reply|message|messages|slack|搜索|撰写|发送|回复|消息)$/iu;
const WECHAT_UI_CHROME_PATTERN =
  /^(wechat|微信|搜索|search|send|发送|reply|回复|聊天信息|聊天记录|通讯录|contacts|发现|moments|我|me|文件传输助手|表情|图片|文件|语音消息)$/iu;
const MAIL_UI_CHROME_PATTERN =
  /^(mail|email|gmail|outlook|邮件|inbox|收件箱|已发送|sent|drafts|草稿|spam|archive|归档|trash|垃圾箱|delete|删除|search|搜索|compose|撰写|reply|回复|send|发送)$/iu;
const GOOGLE_DRIVE_UI_CHROME_PATTERN =
  /^(google drive|my drive|priority|recent|shared with me|shared drives|starred|trash|upload to drive|drive uploaded|search)$/iu;
const GOOGLE_DOCS_UI_CHROME_PATTERN =
  /^(google docs|google docs editor|save google doc|saved in google docs|share|comment|format|insert|tools|extensions)$/iu;
const FEISHU_DOCS_UI_CHROME_PATTERN =
  /^(feishu docs|飞书文档编辑区|保存到飞书|已保存到飞书|分享|评论|工具栏|更多)$/iu;

function createWatchTask(rule: WatchRule): TaskRecord {
  const timestamp = new Date().toISOString();
  return {
    id: `watch-${rule.id}`,
    goal: rule.goal,
    status: "running",
    priority: "normal",
    triggerSource: "watch",
    deadline: null,
    preferredSurface: rule.preferredSurface,
    workspaceId: null,
    traceId: null,
    taskSpec: { goal: rule.goal, preferredSurface: rule.preferredSurface },
    plan: [],
    result: null,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function profileAsWorkspace(rule: WatchRule, profile: WorkspaceProfile): WorkspaceRecord {
  return {
    id: profile.id,
    taskId: `watch-${rule.id}`,
    rootPath: profile.rootPath,
    profilePath: profile.profilePath,
    downloadsPath: profile.downloadsPath,
    artifactsPath: profile.artifactsPath,
    scratchPath: profile.scratchPath,
    createdAt: profile.createdAt
  };
}

export interface LivePackDraftResponse {
  replyText: string;
  metadata: Record<string, unknown>;
}

export interface LivePack {
  name: string;
  info: LivePackInfo;
  activate?(args: LivePackActivationArgs): Promise<void>;
  observeInbox?(args: LivePackObserveArgs): Promise<WorldState | null>;
  detectNewItems?(args: LivePackDetectionArgs): Promise<WatchDetection | null>;
  extractContext?(args: LivePackExtractContextArgs): Promise<Partial<WatchDetection> | null>;
  draftReply?(args: LivePackDraftArgs): Promise<LivePackDraftResponse>;
  markHandled?(args: LivePackMarkHandledArgs): Promise<void>;
}

function uniqueStrings(values: unknown[] = []): string[] {
  const seen = new Set();
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

function collectSignals(worldState: WorldState | null) {
  const signals: Array<{
    text: string;
    source: string;
    interactive: boolean;
    role: string | null;
    index: number;
    score: number;
  }> = [];

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

function visibleLines(worldState: WorldState | null): string[] {
  return uniqueStrings(collectSignals(worldState).map((signal) => signal.text)).slice(0, 120);
}

function fingerprint(value: unknown): string {
  return crypto.createHash("sha1").update(String(value ?? "")).digest("hex");
}

function matchTriggerText(lines: string[], triggerTexts: unknown[] = []): string | null {
  const loweredTriggers = triggerTexts.map((entry) => String(entry).toLowerCase()).filter(Boolean);
  if (!loweredTriggers.length) {
    return lines[0] ?? null;
  }

  return (
    lines.find((line) => loweredTriggers.some((trigger) => line.toLowerCase().includes(trigger))) ?? null
  );
}

function bestSignalMatch({
  worldState,
  triggerTexts = [],
  unreadTokens = [],
  ignoreTokens = []
}: {
  worldState: WorldState | null;
  triggerTexts?: unknown[];
  unreadTokens?: unknown[];
  ignoreTokens?: unknown[];
}) {
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
      if (/^(send|reply|submit|search|发送|回复|提交|搜索)$/iu.test(signal.text.trim())) {
        score -= 6;
      }

      return {
        ...signal,
        score
      };
    })
    .filter((signal): signal is NonNullable<typeof signal> => Boolean(signal))
    .sort((left, right) => right.score - left.score);

  return ranked[0] ?? null;
}

function contextForSignal(
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

function draftHeuristicReply({
  family,
  goal,
  summary,
  context
}: {
  family: "chat" | "mail" | "generic";
  goal: string;
  summary: string;
  context: string[];
}): LivePackDraftResponse {
  const combinedContext = [summary, ...context].filter(Boolean).join("\n");
  const chinese = /[\u4e00-\u9fff]/u.test(`${goal} ${combinedContext}`);
  const replyText =
    family === "mail"
      ? chinese
        ? "收到你的邮件，我会尽快处理并回复。"
        : "Thanks for your email. I received it and will follow up shortly."
      : chinese
        ? "收到，我会尽快处理。"
        : "Got it. I will follow up shortly.";
  return {
    replyText,
    metadata: {
      confidence: null,
      rationale: "heuristic fallback",
      source: "heuristic"
    }
  };
}

function candidateHintStrings(candidate: InteractionCandidate | null | undefined): string[] {
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

function candidateHintText(candidate: InteractionCandidate | null | undefined): string {
  return candidateHintStrings(candidate).join(" ").trim();
}

function normalizeSlackSummary(value: string): string {
  return String(value ?? "")
    .replace(/^[●•]\s*/u, "")
    .replace(/^(unread thread|unread|mention|new message|new messages|未读|新消息)\s*[:：-]?\s*/iu, "")
    .replace(/\s+\(\d+\)$/u, "")
    .trim();
}

function isSlackUiChrome(text: string): boolean {
  return SLACK_UI_CHROME_PATTERN.test(String(text ?? "").trim());
}

function scoreSlackCandidate({
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

function findSlackUnreadCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  const ranked = candidates
    .map((candidate) => ({ candidate, score: scoreSlackCandidate({ candidate, worldState }) }))
    .filter((entry): entry is { candidate: InteractionCandidate; score: number } => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score);
  return ranked[0]?.candidate ?? null;
}

function defaultLocalizedTarget(surface: LivePackSurface, kind: "compose" | "send", worldState: WorldState | null): string {
  const chinese = /[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? ""));
  if (kind === "compose") {
    return chinese ? "消息" : "Message";
  }
  return chinese || surface === "desktop" ? "发送" : "Send";
}

function pickSlackComposeQuery(worldState: WorldState | null, surface: LivePackSurface): string {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  const composeCandidate =
    candidates.find((candidate) => {
      const hintText = candidateHintText(candidate);
      return (
        candidate.role === "textbox" ||
        /(message|reply|消息|回复)/iu.test(hintText) ||
        /(message|reply|消息|回复)/iu.test(candidate.text)
      );
    }) ?? null;

  if (!composeCandidate) {
    return defaultLocalizedTarget(surface, "compose", worldState);
  }

  const hints = (composeCandidate.sourceHints ?? {}) as Record<string, unknown>;
  return (
    String(hints.placeholder ?? hints.ariaLabel ?? composeCandidate.text ?? "").trim() ||
    defaultLocalizedTarget(surface, "compose", worldState)
  );
}

function pickSlackSendQuery(worldState: WorldState | null, surface: LivePackSurface): string {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  const sendCandidate =
    candidates.find((candidate) => {
      const hintText = candidateHintText(candidate);
      return candidate.role === "button" && (SEND_PATTERN.test(hintText) || SEND_PATTERN.test(candidate.text));
    }) ?? null;

  if (!sendCandidate) {
    return defaultLocalizedTarget(surface, "send", worldState);
  }

  return (
    String(sendCandidate.text ?? "").trim() ||
    String(((sendCandidate.sourceHints ?? {}) as Record<string, unknown>).ariaLabel ?? "").trim() ||
    defaultLocalizedTarget(surface, "send", worldState)
  );
}

function extractSlackThreadContext(worldState: WorldState | null, summary: string): string[] {
  const lines = visibleLines(worldState).filter((line) => !isSlackUiChrome(line));
  const normalizedSummary = normalizeSlackSummary(summary);
  const summaryIndex = lines.findIndex((line) => normalizeSlackSummary(line) === normalizedSummary);
  const pool = summaryIndex === -1 ? lines : lines.slice(summaryIndex + 1);
  return uniqueStrings(
    pool.filter((line) => {
      const normalized = normalizeSlackSummary(line);
      return normalized && normalized !== normalizedSummary && !UNREAD_PATTERN.test(line) && !SEND_PATTERN.test(line);
    })
  ).slice(0, 4);
}

function normalizeWeChatSummary(value: string): string {
  return String(value ?? "")
    .replace(/^[●•]\s*/u, "")
    .replace(/^(unread|new message|new messages|未读|新消息)\s*[:：-]?\s*/iu, "")
    .replace(/^\(\d+\)\s*/u, "")
    .replace(/\s+\(\d+\)$/u, "")
    .trim();
}

function isWeChatUiChrome(text: string): boolean {
  return WECHAT_UI_CHROME_PATTERN.test(String(text ?? "").trim());
}

function scoreWeChatCandidate({
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

  let score = candidate.isInteractive ? 12 : 4;
  if (candidate.role === "button" || candidate.role === "link" || candidate.role === "text") {
    score += 3;
  }
  if (UNREAD_PATTERN.test(hintText)) {
    score += 28;
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

  return score;
}

function findWeChatUnreadCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  const ranked = candidates
    .map((candidate) => ({ candidate, score: scoreWeChatCandidate({ candidate, worldState }) }))
    .filter((entry): entry is { candidate: InteractionCandidate; score: number } => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score);
  return ranked[0]?.candidate ?? null;
}

function pickWeChatComposeQuery(worldState: WorldState | null): string {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  const composeCandidate =
    candidates.find((candidate) => {
      const hintText = candidateHintText(candidate);
      return (
        candidate.role === "textbox" ||
        /(message|reply|input|chat|消息|回复|输入|请输入)/iu.test(hintText) ||
        /(message|reply|input|chat|消息|回复|输入|请输入)/iu.test(candidate.text)
      );
    }) ?? null;

  if (!composeCandidate) {
    return /[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? "")) ? "输入" : "Message";
  }

  const hints = (composeCandidate.sourceHints ?? {}) as Record<string, unknown>;
  return (
    String(hints.placeholder ?? hints.ariaLabel ?? composeCandidate.text ?? "").trim() ||
    (/[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? "")) ? "输入" : "Message")
  );
}

function pickWeChatSendQuery(worldState: WorldState | null): string {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  const sendCandidate =
    candidates.find((candidate) => {
      const hintText = candidateHintText(candidate);
      return candidate.role === "button" && (SEND_PATTERN.test(hintText) || SEND_PATTERN.test(candidate.text));
    }) ?? null;

  if (!sendCandidate) {
    return /[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? "")) ? "发送" : "Send";
  }

  return (
    String(sendCandidate.text ?? "").trim() ||
    String(((sendCandidate.sourceHints ?? {}) as Record<string, unknown>).ariaLabel ?? "").trim() ||
    (/[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? "")) ? "发送" : "Send")
  );
}

function extractWeChatThreadContext(worldState: WorldState | null, summary: string): string[] {
  const lines = visibleLines(worldState).filter((line) => !isWeChatUiChrome(line));
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

function buildWeChatReplySteps(): RuntimeStep[] {
  return [
    {
      label: "Open unread WeChat conversation",
      surface: "desktop",
      action: "clickTarget",
      params: { targetQuery: "{{openTarget}}" },
      checkpoint: false
    },
    {
      label: "Wait for WeChat composer",
      surface: "desktop",
      action: "waitForTarget",
      params: { targetQuery: "{{typeTarget}}", timeoutMs: 5000 },
      checkpoint: false
    },
    {
      label: "Type WeChat reply",
      surface: "desktop",
      action: "typeIntoTarget",
      params: { targetQuery: "{{typeTarget}}", text: "{{typeText}}", clear: false },
      checkpoint: false
    },
    {
      label: "Send WeChat reply",
      surface: "desktop",
      action: "clickTarget",
      params: { targetQuery: "{{sendTarget}}" },
      checkpoint: false
    }
  ];
}

function normalizeMailSummary(value: string): string {
  return String(value ?? "")
    .replace(/^[●•]\s*/u, "")
    .replace(/^(unread email|unread mail|unread|new mail|new email|未读邮件|未读|新邮件)\s*[:：-]?\s*/iu, "")
    .replace(/^\(\d+\)\s*/u, "")
    .replace(/\s+\(\d+\)$/u, "")
    .trim();
}

function normalizeDocsSummary(value: string, prefixes: string[] = []): string {
  let summary = String(value ?? "")
    .replace(/^[●•]\s*/u, "")
    .replace(/^\(\d+\)\s*/u, "")
    .replace(/\s+\(\d+\)$/u, "")
    .trim();

  for (const prefix of prefixes) {
    const pattern = new RegExp(`^${prefix}\\s*[:：-]?\\s*`, "iu");
    summary = summary.replace(pattern, "").trim();
  }

  return summary;
}

function isMailUiChrome(text: string): boolean {
  return MAIL_UI_CHROME_PATTERN.test(String(text ?? "").trim());
}

function isDriveUiChrome(text: string): boolean {
  return GOOGLE_DRIVE_UI_CHROME_PATTERN.test(String(text ?? "").trim());
}

function isGoogleDocsUiChrome(text: string): boolean {
  return GOOGLE_DOCS_UI_CHROME_PATTERN.test(String(text ?? "").trim());
}

function isFeishuDocsUiChrome(text: string): boolean {
  return FEISHU_DOCS_UI_CHROME_PATTERN.test(String(text ?? "").trim());
}

function inferBrowserPageUrl(worldState: WorldState | null): string | null {
  const url = String(((worldState?.appContext ?? {}) as { url?: unknown }).url ?? "").trim();
  return /^https?:\/\//u.test(url) ? url : null;
}

function scoreMailCandidate({
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

function findMailUnreadCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  const ranked = candidates
    .map((candidate) => ({ candidate, score: scoreMailCandidate({ candidate, worldState }) }))
    .filter((entry): entry is { candidate: InteractionCandidate; score: number } => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score);
  return ranked[0]?.candidate ?? null;
}

function pickMailComposeQuery(worldState: WorldState | null, surface: LivePackSurface): string {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  const composeCandidate =
    candidates.find((candidate) => {
      const hintText = candidateHintText(candidate);
      return (
        candidate.role === "textbox" ||
        /(reply|message|compose|write|回复|撰写|输入)/iu.test(hintText) ||
        /(reply|message|compose|write|回复|撰写|输入)/iu.test(candidate.text)
      );
    }) ?? null;

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

function pickMailSendQuery(worldState: WorldState | null, surface: LivePackSurface): string {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  const sendCandidate =
    candidates.find((candidate) => {
      const hintText = candidateHintText(candidate);
      return candidate.role === "button" && (SEND_PATTERN.test(hintText) || SEND_PATTERN.test(candidate.text));
    }) ?? null;

  if (!sendCandidate) {
    return /[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? "")) ? "发送" : surface === "browser" ? "Send reply" : "Send";
  }

  return (
    String(sendCandidate.text ?? "").trim() ||
    String(((sendCandidate.sourceHints ?? {}) as Record<string, unknown>).ariaLabel ?? "").trim() ||
    (/[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? "")) ? "发送" : surface === "browser" ? "Send reply" : "Send")
  );
}

function extractMailThreadContext(worldState: WorldState | null, summary: string): string[] {
  const lines = visibleLines(worldState).filter((line) => !isMailUiChrome(line));
  const normalizedSummary = normalizeMailSummary(summary);
  const summaryIndex = lines.findIndex((line) => normalizeMailSummary(line) === normalizedSummary);
  const pool = summaryIndex === -1 ? lines : lines.slice(summaryIndex + 1);
  return uniqueStrings(
    pool.filter((line) => {
      const normalized = normalizeMailSummary(line);
      return (
        normalized &&
        normalized !== normalizedSummary &&
        !UNREAD_PATTERN.test(line) &&
        !SEND_PATTERN.test(line) &&
        !/(reply|message|compose|write|回复|撰写|输入)/iu.test(line)
      );
    })
  ).slice(0, 5);
}

function buildMailReplySteps(surface: LivePackSurface): RuntimeStep[] {
  return [
    {
      label: "Open unread mail thread",
      surface,
      action: "clickTarget",
      params: { targetQuery: "{{openTarget}}" },
      checkpoint: false
    },
    {
      label: "Wait for mail composer",
      surface,
      action: "waitForTarget",
      params: { targetQuery: "{{typeTarget}}", timeoutMs: 5000 },
      checkpoint: false
    },
    {
      label: "Type mail reply",
      surface,
      action: "typeIntoTarget",
      params: { targetQuery: "{{typeTarget}}", text: "{{typeText}}", clear: false },
      checkpoint: false
    },
    {
      label: "Send mail reply",
      surface,
      action: "clickTarget",
      params: { targetQuery: "{{sendTarget}}" },
      checkpoint: false
    }
  ];
}

function buildSlackReplySteps(surface: LivePackSurface): RuntimeStep[] {
  return [
    {
      label: "Open unread Slack thread",
      surface,
      action: "clickTarget",
      params: { targetQuery: "{{openTarget}}" },
      checkpoint: false
    },
    {
      label: "Wait for Slack composer",
      surface,
      action: "waitForTarget",
      params: { targetQuery: "{{typeTarget}}", timeoutMs: 5000 },
      checkpoint: false
    },
    {
      label: "Type Slack reply",
      surface,
      action: "typeIntoTarget",
      params: { targetQuery: "{{typeTarget}}", text: "{{typeText}}", clear: false },
      checkpoint: false
    },
    {
      label: "Send Slack reply",
      surface,
      action: "clickTarget",
      params: { targetQuery: "{{sendTarget}}" },
      checkpoint: false
    }
  ];
}

function createDocumentPack({
  name,
  family,
  description,
  skillName,
  defaultTriggerTexts,
  summaryPrefixes,
  ignoreUiChrome,
  defaultInputs,
  resolveWorkflow = null
}: {
  name: string;
  family: "docs" | "files";
  description: string;
  skillName: string;
  defaultTriggerTexts: string[];
  summaryPrefixes: string[];
  ignoreUiChrome: (text: string) => boolean;
  defaultInputs: Record<string, string>;
  resolveWorkflow?: null | (({
    summary,
    context,
    rule,
    runtimeInputs
  }: {
    summary: string;
    context: string[];
    rule: WatchRule;
    runtimeInputs: Record<string, string>;
  }) => {
    skillName?: string;
    inputs?: Record<string, string>;
  });
}): LivePack {
  return {
    name,
    info: {
      name,
      family,
      surface: "browser",
      supportsDrafts: false,
      supportsAutoSend: false,
      description
    },
    async activate({ rule, workspace, surfaceRegistry }) {
      const adapter = surfaceRegistry.get("browser");
      if (!adapter) {
        return;
      }

      const watchTask = createWatchTask(rule);
      const watchWorkspace = profileAsWorkspace(rule, workspace);
      const startUrl = String(rule.taskInputs?.startUrl ?? rule.taskInputs?.url ?? rule.appTarget ?? "").trim();
      if (/^https?:\/\//u.test(startUrl)) {
        await adapter.act({
          task: watchTask,
          step: {
            id: `watch-goto-${rule.id}`,
            action: "goto",
            surface: "browser",
            params: { url: startUrl, waitUntil: "domcontentloaded", timeoutMs: 15000 }
          },
          workspace: watchWorkspace,
          traceId: null,
          outputs: {}
        });
        return;
      }

      await adapter
        .focus({
          task: watchTask,
          workspace: watchWorkspace,
          traceId: null
        })
        .catch(() => null);
    },
    async observeInbox(args) {
      return observeWatchSurface({ ...args, surface: "browser" });
    },
    async detectNewItems({ rule, worldState, dedupeState = {} }) {
      const matchedSignal = bestSignalMatch({
        worldState,
        triggerTexts: [...defaultTriggerTexts, ...(rule.watchProfile?.triggerTexts ?? [])],
        ignoreTokens: Object.values(defaultInputs)
      });
      const matchedText = String(matchedSignal?.text ?? "").trim();
      const summary = normalizeDocsSummary(matchedText, summaryPrefixes);
      if (!matchedSignal || !summary || ignoreUiChrome(summary)) {
        return null;
      }

      const context = contextForSignal(worldState, matchedSignal).filter((line) => !ignoreUiChrome(line));
      const itemFingerprint = fingerprint(
        `${name}:${rule.workspaceName ?? "default"}:${summary}:${context.join("|")}`
      );
      if (dedupeState.lastFingerprint === itemFingerprint) {
        return null;
      }

      const runtimeInputs = Object.fromEntries(
        Object.entries(defaultInputs).map(([key, value]) => [key, String(rule.taskInputs?.[key] ?? value)])
      );
      if (!String(runtimeInputs.startUrl ?? "").trim()) {
        runtimeInputs.startUrl = inferBrowserPageUrl(worldState) ?? "";
      }
      const resolvedWorkflow = resolveWorkflow?.({
        summary,
        context,
        rule,
        runtimeInputs
      });
      const resolvedSkillName = String(resolvedWorkflow?.skillName ?? skillName).trim() || skillName;
      const resolvedInputs = {
        ...runtimeInputs,
        ...(resolvedWorkflow?.inputs ?? {})
      };

      return {
        fingerprint: itemFingerprint,
        summary,
        goal: `${rule.goal}\n\nDetected item: ${summary}`,
        text: summary,
        context,
        inputs: {
          watchItemText: matchedText || summary,
          watchSummary: summary,
          watchContext: context.join("\n"),
          ...resolvedInputs
        },
        taskSpec: {
          preferredSurface: "browser",
          skillName: resolvedSkillName,
          executionMode: "planned"
        },
        metadata: {
          surface: "browser",
          skillName: resolvedSkillName
        }
      };
    }
  };
}

async function observeWatchSurface({
  rule,
  workspace,
  surfaceRegistry,
  surface
}: LivePackObserveArgs & { surface: LivePackSurface }): Promise<WorldState | null> {
  const adapter = surfaceRegistry.get(surface);
  if (!adapter) {
    return null;
  }

  return (await adapter.observe({
    task: createWatchTask(rule),
    workspace: profileAsWorkspace(rule, workspace),
    traceId: null,
    label: `watch-${rule.id}`
  })) as WorldState;
}

async function openSlackThreadForContext({
  rule,
  workspace,
  surfaceRegistry,
  surface,
  detection
}: LivePackExtractContextArgs & { surface: LivePackSurface }): Promise<WorldState | null> {
  const adapter = surfaceRegistry.get(surface);
  if (!adapter) {
    return null;
  }

  const openTarget = String(detection.inputs?.openTarget ?? detection.summary ?? "").trim();
  if (!openTarget) {
    return null;
  }

  const openCandidate = (detection.metadata?.openCandidate ?? null) as Record<string, unknown> | null;
  await adapter.act({
    task: createWatchTask(rule),
    step: {
      id: `slack-open-${rule.id}`,
      label: "Open Slack thread",
      surface,
      action: "clickTarget",
      params: {
        targetQuery: openTarget,
        ...(openCandidate ? { target: openCandidate } : {})
      }
    },
    workspace: profileAsWorkspace(rule, workspace),
    traceId: null,
    outputs: {}
  });

  if (surface === "browser") {
    await adapter.act({
      task: createWatchTask(rule),
      step: {
        id: `slack-open-wait-${rule.id}`,
        label: "Wait for Slack thread",
        surface,
        action: "wait",
        params: { ms: 100 }
      },
      workspace: profileAsWorkspace(rule, workspace),
      traceId: null,
      outputs: {}
    });
  }

  return observeWatchSurface({
    rule,
    workspace,
    surfaceRegistry,
    controlPlane: {} as LivePackControlPlane,
    surface
  });
}

function createSlackPack({
  name,
  surface,
  description
}: {
  name: string;
  surface: LivePackSurface;
  description: string;
}): LivePack {
  return {
    name,
    info: {
      name,
      family: "chat",
      surface,
      supportsDrafts: true,
      supportsAutoSend: true,
      description
    },
    async activate({ rule, workspace, surfaceRegistry }) {
      const adapter = surfaceRegistry.get(surface);
      if (!adapter) {
        return;
      }

      const watchTask = createWatchTask(rule);
      const watchWorkspace = profileAsWorkspace(rule, workspace);
      if (surface === "desktop") {
        const appName = rule.appTarget ?? "Slack";
        await adapter
          .act({
            task: watchTask,
            step: {
              id: `watch-focus-${rule.id}`,
              action: "focusApp",
              surface,
              params: { name: appName }
            },
            workspace: watchWorkspace,
            traceId: null,
            outputs: {}
          })
          .catch(() => null);
        return;
      }

      const startUrl = String(rule.taskInputs?.startUrl ?? rule.taskInputs?.url ?? rule.appTarget ?? "").trim();
      if (/^https?:\/\//u.test(startUrl)) {
        await adapter.act({
          task: watchTask,
          step: {
            id: `watch-goto-${rule.id}`,
            action: "goto",
            surface,
            params: { url: startUrl, waitUntil: "domcontentloaded", timeoutMs: 15000 }
          },
          workspace: watchWorkspace,
          traceId: null,
          outputs: {}
        });
      } else {
        await adapter.focus({
          task: watchTask,
          workspace: watchWorkspace,
          traceId: null
        }).catch(() => null);
      }
    },
    async observeInbox(args) {
      return observeWatchSurface({ ...args, surface });
    },
    async detectNewItems({ rule, worldState, dedupeState = {} }) {
      const candidate = findSlackUnreadCandidate(worldState);
      if (!candidate) {
        return null;
      }

      const summary = normalizeSlackSummary(candidate.text || candidateHintText(candidate));
      if (!summary) {
        return null;
      }

      const context = contextForSignal(worldState, { text: candidate.text || summary });
      const itemFingerprint = fingerprint(
        `${name}:${surface}:${rule.workspaceName ?? "default"}:${summary}:${context.join("|")}`
      );
      if (dedupeState.lastFingerprint === itemFingerprint) {
        return null;
      }

      return {
        fingerprint: itemFingerprint,
        summary,
        text: summary,
        context,
        inputs: {
          watchItemText: summary,
          watchSummary: summary,
          watchContext: context.join("\n"),
          openTarget: String(candidate.text ?? summary).trim() || summary
        },
        metadata: {
          openCandidate: candidate,
          surface
        }
      };
    },
    async extractContext(args) {
      const threadState = await openSlackThreadForContext({ ...args, surface });
      const composeTarget = pickSlackComposeQuery(threadState, surface);
      const sendTarget = pickSlackSendQuery(threadState, surface);
      const summary = String(args.detection.summary ?? "").trim();
      const context = extractSlackThreadContext(threadState, summary);
      return {
        summary,
        context,
        inputs: {
          ...(args.detection.inputs ?? {}),
          watchContext: context.join("\n"),
          openTarget: String(args.detection.inputs?.openTarget ?? summary).trim() || summary,
          typeTarget: composeTarget,
          sendTarget
        },
        taskSpec: {
          preferredSurface: surface,
          steps: buildSlackReplySteps(surface)
        }
      };
    },
    async draftReply({ rule, detection, controlPlane }) {
      const summary = String(detection?.summary ?? "").trim();
      const context = Array.isArray(detection?.context) ? detection.context : [];
      if (controlPlane.modelClient.isConfigured()) {
        const drafted = await controlPlane.modelClient.draftReply({
          goal: rule.goal,
          livePack: name,
          summary,
          context
        });
        return {
          replyText: String(drafted.replyText ?? "").trim(),
          metadata: {
            confidence: drafted.confidence ?? null,
            rationale: drafted.rationale ?? null,
            source: "model"
          }
        };
      }

      return draftHeuristicReply({
        family: "chat",
        goal: rule.goal,
        summary,
        context
      });
    }
  };
}

function createWeChatPack(): LivePack {
  return {
    name: "wechat-desktop",
    info: {
      name: "wechat-desktop",
      family: "chat",
      surface: "desktop",
      supportsDrafts: true,
      supportsAutoSend: true,
      description: "WeChat desktop watcher that detects unread conversations, extracts context, and sends low-risk replies."
    },
    async activate({ rule, workspace, surfaceRegistry }) {
      const adapter = surfaceRegistry.get("desktop");
      if (!adapter) {
        return;
      }
      await adapter
        .act({
          task: createWatchTask(rule),
          step: {
            id: `watch-focus-${rule.id}`,
            action: "focusApp",
            surface: "desktop",
            params: { name: rule.appTarget ?? "WeChat" }
          },
          workspace: profileAsWorkspace(rule, workspace),
          traceId: null,
          outputs: {}
        })
        .catch(() => null);
    },
    async observeInbox(args) {
      return observeWatchSurface({ ...args, surface: "desktop" });
    },
    async detectNewItems({ rule, worldState, dedupeState = {} }) {
      const candidate = findWeChatUnreadCandidate(worldState);
      if (!candidate) {
        return null;
      }

      const summary = normalizeWeChatSummary(candidate.text || candidateHintText(candidate));
      if (!summary) {
        return null;
      }

      const context = contextForSignal(worldState, { text: candidate.text || summary });
      const itemFingerprint = fingerprint(
        `wechat-desktop:${rule.workspaceName ?? "default"}:${summary}:${context.join("|")}`
      );
      if (dedupeState.lastFingerprint === itemFingerprint) {
        return null;
      }

      return {
        fingerprint: itemFingerprint,
        summary,
        text: summary,
        context,
        inputs: {
          watchItemText: summary,
          watchSummary: summary,
          watchContext: context.join("\n"),
          openTarget: String(candidate.text ?? summary).trim() || summary
        },
        metadata: {
          openCandidate: candidate,
          surface: "desktop"
        }
      };
    },
    async extractContext({ rule, workspace, surfaceRegistry, detection }) {
      const adapter = surfaceRegistry.get("desktop");
      if (!adapter) {
        return null;
      }

      const openTarget = String(detection.inputs?.openTarget ?? detection.summary ?? "").trim();
      if (openTarget) {
        const openCandidate = (detection.metadata?.openCandidate ?? null) as Record<string, unknown> | null;
        await adapter.act({
          task: createWatchTask(rule),
          step: {
            id: `wechat-open-${rule.id}`,
            label: "Open WeChat conversation",
            surface: "desktop",
            action: "clickTarget",
            params: {
              targetQuery: openTarget,
              ...(openCandidate ? { target: openCandidate } : {})
            }
          },
          workspace: profileAsWorkspace(rule, workspace),
          traceId: null,
          outputs: {}
        });
      }

      const threadState = await observeWatchSurface({
        rule,
        workspace,
        surfaceRegistry,
        controlPlane: {} as LivePackControlPlane,
        surface: "desktop"
      });
      const summary = String(detection.summary ?? "").trim();
      const context = extractWeChatThreadContext(threadState, summary);
      return {
        summary,
        context,
        inputs: {
          ...(detection.inputs ?? {}),
          watchContext: context.join("\n"),
          openTarget: String(detection.inputs?.openTarget ?? summary).trim() || summary,
          typeTarget: pickWeChatComposeQuery(threadState),
          sendTarget: pickWeChatSendQuery(threadState)
        },
        taskSpec: {
          preferredSurface: "desktop",
          steps: buildWeChatReplySteps()
        }
      };
    },
    async draftReply({ rule, detection, controlPlane }) {
      const summary = String(detection?.summary ?? "").trim();
      const context = Array.isArray(detection?.context) ? detection.context : [];
      if (controlPlane.modelClient.isConfigured()) {
        const drafted = await controlPlane.modelClient.draftReply({
          goal: rule.goal,
          livePack: "wechat-desktop",
          summary,
          context
        });
        return {
          replyText: String(drafted.replyText ?? "").trim(),
          metadata: {
            confidence: drafted.confidence ?? null,
            rationale: drafted.rationale ?? null,
            source: "model"
          }
        };
      }

      return draftHeuristicReply({
        family: "chat",
        goal: rule.goal,
        summary,
        context
      });
    }
  };
}

async function openMailThreadForContext({
  rule,
  workspace,
  surfaceRegistry,
  surface,
  detection
}: LivePackExtractContextArgs & { surface: LivePackSurface }): Promise<WorldState | null> {
  const adapter = surfaceRegistry.get(surface);
  if (!adapter) {
    return null;
  }

  const openTarget = String(detection.inputs?.openTarget ?? detection.summary ?? "").trim();
  if (!openTarget) {
    return null;
  }

  const openCandidate = (detection.metadata?.openCandidate ?? null) as Record<string, unknown> | null;
  await adapter.act({
    task: createWatchTask(rule),
    step: {
      id: `mail-open-${rule.id}`,
      label: "Open mail thread",
      surface,
      action: "clickTarget",
      params: {
        targetQuery: openTarget,
        ...(openCandidate ? { target: openCandidate } : {})
      }
    },
    workspace: profileAsWorkspace(rule, workspace),
    traceId: null,
    outputs: {}
  });

  if (surface === "browser") {
    await adapter.act({
      task: createWatchTask(rule),
      step: {
        id: `mail-open-wait-${rule.id}`,
        label: "Wait for mail thread",
        surface,
        action: "wait",
        params: { ms: 100 }
      },
      workspace: profileAsWorkspace(rule, workspace),
      traceId: null,
      outputs: {}
    });
  }

  return observeWatchSurface({
    rule,
    workspace,
    surfaceRegistry,
    controlPlane: {} as LivePackControlPlane,
    surface
  });
}

function createMailPack({
  name,
  surface,
  description
}: {
  name: string;
  surface: LivePackSurface;
  description: string;
}): LivePack {
  return {
    name,
    info: {
      name,
      family: "mail",
      surface,
      supportsDrafts: true,
      supportsAutoSend: false,
      description
    },
    async activate({ rule, workspace, surfaceRegistry }) {
      const adapter = surfaceRegistry.get(surface);
      if (!adapter) {
        return;
      }

      const watchTask = createWatchTask(rule);
      const watchWorkspace = profileAsWorkspace(rule, workspace);
      if (surface === "desktop") {
        if (!rule.appTarget) {
          return;
        }
        await adapter
          .act({
            task: watchTask,
            step: {
              id: `watch-focus-${rule.id}`,
              action: "focusApp",
              surface,
              params: { name: rule.appTarget }
            },
            workspace: watchWorkspace,
            traceId: null,
            outputs: {}
          })
          .catch(() => null);
        return;
      }

      const startUrl = String(rule.taskInputs?.startUrl ?? rule.taskInputs?.url ?? rule.appTarget ?? "").trim();
      if (/^https?:\/\//u.test(startUrl)) {
        await adapter.act({
          task: watchTask,
          step: {
            id: `watch-goto-${rule.id}`,
            action: "goto",
            surface,
            params: { url: startUrl, waitUntil: "domcontentloaded", timeoutMs: 15000 }
          },
          workspace: watchWorkspace,
          traceId: null,
          outputs: {}
        });
      } else {
        await adapter.focus({
          task: watchTask,
          workspace: watchWorkspace,
          traceId: null
        }).catch(() => null);
      }
    },
    async observeInbox(args) {
      return observeWatchSurface({ ...args, surface });
    },
    async detectNewItems({ rule, worldState, dedupeState = {} }) {
      const candidate = findMailUnreadCandidate(worldState);
      if (!candidate) {
        return null;
      }

      const summary = normalizeMailSummary(candidate.text || candidateHintText(candidate));
      if (!summary) {
        return null;
      }

      const context = contextForSignal(worldState, { text: candidate.text || summary });
      const itemFingerprint = fingerprint(
        `${name}:${surface}:${rule.workspaceName ?? "default"}:${summary}:${context.join("|")}`
      );
      if (dedupeState.lastFingerprint === itemFingerprint) {
        return null;
      }

      return {
        fingerprint: itemFingerprint,
        summary,
        text: summary,
        context,
        inputs: {
          watchItemText: summary,
          watchSummary: summary,
          watchContext: context.join("\n"),
          openTarget: String(candidate.text ?? summary).trim() || summary
        },
        metadata: {
          openCandidate: candidate,
          surface
        }
      };
    },
    async extractContext(args) {
      const threadState = await openMailThreadForContext({ ...args, surface });
      const summary = String(args.detection.summary ?? "").trim();
      const context = extractMailThreadContext(threadState, summary);
      return {
        summary,
        context,
        inputs: {
          ...(args.detection.inputs ?? {}),
          watchContext: context.join("\n"),
          openTarget: String(args.detection.inputs?.openTarget ?? summary).trim() || summary,
          typeTarget: pickMailComposeQuery(threadState, surface),
          sendTarget: pickMailSendQuery(threadState, surface)
        },
        taskSpec: {
          preferredSurface: surface,
          steps: buildMailReplySteps(surface)
        }
      };
    },
    async draftReply({ rule, detection, controlPlane }) {
      const summary = String(detection?.summary ?? "").trim();
      const context = Array.isArray(detection?.context) ? detection.context : [];
      if (controlPlane.modelClient.isConfigured()) {
        const drafted = await controlPlane.modelClient.draftReply({
          goal: rule.goal,
          livePack: name,
          summary,
          context
        });
        return {
          replyText: String(drafted.replyText ?? "").trim(),
          metadata: {
            confidence: drafted.confidence ?? null,
            rationale: drafted.rationale ?? null,
            source: "model"
          }
        };
      }

      return draftHeuristicReply({
        family: "mail",
        goal: rule.goal,
        summary,
        context
      });
    }
  };
}

function createVisualDesktopPack({
  name,
  family = "generic",
  description = "Visual desktop inbox watcher",
  defaultTriggerTexts = [],
  unreadTokens = [],
  ignoreTokens = []
}: {
  name: string;
  family?: "chat" | "mail" | "generic";
  description?: string;
  defaultTriggerTexts?: string[];
  unreadTokens?: string[];
  ignoreTokens?: string[];
}): LivePack {
  return {
    name,
    info: {
      name,
      family,
      surface: "desktop",
      supportsDrafts: true,
      supportsAutoSend: family === "chat",
      description
    },
    async activate({ rule, workspace, surfaceRegistry }) {
      if (rule.appTarget && rule.preferredSurface === "desktop") {
        const desktop = surfaceRegistry.get("desktop");
        if (!desktop) {
          return;
        }
        const watchTask = createWatchTask(rule);
        const watchWorkspace = profileAsWorkspace(rule, workspace);
        await desktop
          .act({
            task: watchTask,
            step: {
              id: `watch-focus-${rule.id}`,
              action: "focusApp",
              params: { name: rule.appTarget }
            },
            workspace: watchWorkspace,
            traceId: null
          })
          .catch(() => null);
      }
    },
    async observeInbox({ rule, workspace, surfaceRegistry }) {
      const surface = surfaceRegistry.get(rule.preferredSurface ?? "desktop");
      if (!surface) {
        return null;
      }
      return (await surface.observe({
        task: createWatchTask(rule),
        workspace: profileAsWorkspace(rule, workspace),
        traceId: null,
        label: `watch-${rule.id}`
      })) as WorldState;
    },
    async detectNewItems({ rule, worldState, dedupeState = {} }) {
      const lines = visibleLines(worldState);
      const matchedSignal = bestSignalMatch({
        worldState,
        triggerTexts: [...defaultTriggerTexts, ...(rule.watchProfile?.triggerTexts ?? [])],
        unreadTokens,
        ignoreTokens
      });
      const match = matchedSignal?.text ?? matchTriggerText(lines, [...defaultTriggerTexts, ...(rule.watchProfile?.triggerTexts ?? [])]);
      if (!match || !matchedSignal) {
        return null;
      }

      const context = contextForSignal(worldState, matchedSignal);
      const itemFingerprint = fingerprint(`${name}:${match}:${context.join("|")}`);
      if (dedupeState.lastFingerprint === itemFingerprint) {
        return null;
      }

      const liveHints = rule.watchProfile?.liveHints ?? {};
      return {
        fingerprint: itemFingerprint,
        summary: match,
        text: match,
        context,
        inputs: {
          watchItemText: match,
          watchSummary: match,
          watchContext: context.join("\n"),
          openTarget: match,
          ...(liveHints.composeTargetQuery ? { typeTarget: liveHints.composeTargetQuery } : {}),
          ...(liveHints.sendTargetQuery ? { sendTarget: liveHints.sendTargetQuery } : {})
        }
      };
    },
    async extractContext({ detection, rule }) {
      return {
        summary: detection.summary,
        inputs: {
          ...(detection.inputs ?? {}),
          watchProfileMode: rule.watchProfile?.executionMode ?? "planned"
        }
      };
    },
    async draftReply({ rule, detection, controlPlane }) {
      const summary = String(detection?.summary ?? "").trim();
      const context = Array.isArray(detection?.context) ? detection.context : [];
      if (controlPlane.modelClient.isConfigured()) {
        const drafted = await controlPlane.modelClient.draftReply({
          goal: rule.goal,
          livePack: name,
          summary,
          context
        });
        return {
          replyText: String(drafted.replyText ?? "").trim(),
          metadata: {
            confidence: drafted.confidence ?? null,
            rationale: drafted.rationale ?? null,
            source: "model"
          }
        };
      }

      return draftHeuristicReply({
        family,
        goal: rule.goal,
        summary,
        context
      });
    }
  };
}

export class LivePackRegistry {
  surfaceRegistry: SurfaceRegistry | undefined;
  packs: Map<string, LivePack>;

  constructor({
    surfaceRegistry,
    extraPacks = {}
  }: {
    surfaceRegistry?: SurfaceRegistry;
    extraPacks?: Record<string, LivePack>;
  } = {}) {
    this.surfaceRegistry = surfaceRegistry;
    this.packs = new Map();

    for (const pack of [
      createVisualDesktopPack({
        name: "generic-desktop",
        family: "generic",
        description: "Generic desktop watcher with OCR-based trigger detection."
      }),
      createSlackPack({
        name: "slack-desktop",
        surface: "desktop",
        description: "Slack desktop watcher that detects unread threads, extracts context, and sends low-risk replies."
      }),
      createSlackPack({
        name: "slack-browser",
        surface: "browser",
        description: "Slack browser watcher that detects unread threads, extracts context, and sends low-risk replies."
      }),
      createWeChatPack(),
      createMailPack({
        name: "generic-mail-desktop",
        surface: "desktop",
        description: "Generic desktop mail watcher that detects unread threads, extracts context, and drafts approval-first replies."
      }),
      createMailPack({
        name: "generic-mail-browser",
        surface: "browser",
        description: "Generic browser mail watcher that detects unread threads, extracts context, and drafts approval-first replies."
      }),
      createDocumentPack({
        name: "google-drive-browser",
        family: "files",
        description: "Google Drive browser watcher that detects pending file intake and triggers upload or download workflows.",
        skillName: "google-drive-upload-file",
        defaultTriggerTexts: [
          "pending upload",
          "upload request",
          "pending download",
          "download request",
          "shared with you",
          "needs review",
          "需要下载",
          "需要上传"
        ],
        summaryPrefixes: [
          "pending upload",
          "upload request",
          "pending download",
          "download request",
          "shared with you",
          "needs review",
          "需要下载",
          "需要上传"
        ],
        ignoreUiChrome: isDriveUiChrome,
        defaultInputs: {
          startUrl: "https://drive.google.com",
          uploadTarget: "Upload to Drive",
          uploadPath: "workspace/sample.txt",
          downloadTarget: "Download shared file",
          downloadFileName: "drive-shared-file.txt"
        },
        resolveWorkflow: ({ summary, context, rule, runtimeInputs }) => {
          const goalText = String(rule.goal ?? "").toLowerCase();
          const contextText = `${summary}\n${context.join("\n")}`.toLowerCase();
          const forceUpload = /(upload|上传)/iu.test(goalText) && !/(download|下载|拉取)/iu.test(goalText);
          const forceDownload = /(download|下载|拉取)/iu.test(goalText) && !/(upload|上传)/iu.test(goalText);

          if (forceDownload || (!forceUpload && /(download|shared report|shared file|下载|拉取)/iu.test(contextText))) {
            return {
              skillName: "google-drive-download-file",
              inputs: {
                startUrl: runtimeInputs.startUrl ?? "https://drive.google.com",
                downloadTarget: runtimeInputs.downloadTarget ?? "Download shared file",
                downloadFileName: runtimeInputs.downloadFileName ?? "drive-shared-file.txt"
              }
            };
          }

          return {
            skillName: "google-drive-upload-file",
            inputs: {
              startUrl: runtimeInputs.startUrl ?? "https://drive.google.com",
              uploadTarget: runtimeInputs.uploadTarget ?? "Upload to Drive",
              uploadPath: runtimeInputs.uploadPath ?? "workspace/sample.txt"
            }
          };
        }
      }),
      createDocumentPack({
        name: "google-docs-browser",
        family: "docs",
        description: "Google Docs browser watcher that detects documents needing updates and triggers edit workflows.",
        skillName: "google-docs-edit-document",
        defaultTriggerTexts: ["needs update", "review doc", "document update requested"],
        summaryPrefixes: ["needs update", "review doc", "document update requested"],
        ignoreUiChrome: isGoogleDocsUiChrome,
        defaultInputs: {
          startUrl: "https://docs.google.com",
          documentTarget: "Google Docs editor",
          documentText: "Updated Google Docs text",
          saveTarget: "Save Google Doc"
        }
      }),
      createDocumentPack({
        name: "feishu-docs-browser",
        family: "docs",
        description: "Feishu Docs browser watcher that detects pending document updates and triggers edit workflows.",
        skillName: "feishu-docs-edit-document",
        defaultTriggerTexts: ["待处理文档", "需要更新", "飞书文档待办", "review doc"],
        summaryPrefixes: ["待处理文档", "需要更新", "飞书文档待办", "review doc"],
        ignoreUiChrome: isFeishuDocsUiChrome,
        defaultInputs: {
          startUrl: "https://feishu.cn/docx",
          documentTarget: "飞书文档编辑区",
          documentText: "更新后的飞书文档内容",
          saveTarget: "保存到飞书"
        }
      })
    ]) {
      this.register(pack.name, pack);
    }

    for (const [name, pack] of Object.entries(extraPacks ?? {})) {
      this.register(name, { name, ...pack });
    }
  }

  register(name: string, pack: LivePack): void {
    this.packs.set(name, pack);
  }

  get(name: string): LivePack | null {
    return this.packs.get(name) ?? null;
  }

  list(): string[] {
    return [...this.packs.keys()].sort();
  }

  listInfo(): LivePackInfo[] {
    return [...this.packs.values()]
      .map((pack) => pack.info)
      .sort((left, right) => String(left.name).localeCompare(String(right.name)));
  }
}
