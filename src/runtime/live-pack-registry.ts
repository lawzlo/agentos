import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ControlPlane } from "./control-plane.js";
import { packDefaultReplyPolicy } from "./reply-policy.js";
import type { SurfaceRegistry } from "./surface-registry.js";
import type {
  InteractionCandidate,
  LivePackCapability,
  LivePackCategory,
  LivePackInfo,
  RuntimeStep,
  TaskRecord,
  WatchDetection,
  WatchDetectionMetadata,
  WatchRule,
  WorldState,
  WorkspaceProfile,
  WorkspaceRecord
} from "../types/runtime-schema.js";

interface LivePackControlPlane
  extends Pick<ControlPlane, "modelClient" | "surfaceRegistry" | "listReplyStylePreferences"> {}

interface DesktopSurfaceReadinessProbe {
  waitForAppReady?: (args: {
    appName: string;
    timeoutMs?: number;
    pollMs?: number;
    stablePolls?: number;
    requireAccessibility?: boolean;
    minAccessibilityCandidates?: number;
  }) => Promise<{ ready: boolean }>;
}

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

export interface DesktopConversationPackAnalysis {
  packName: string;
  foreground: boolean;
  unreadCandidate: DesktopProbeCandidateSummary | null;
  composeCandidate: DesktopProbeCandidateSummary | null;
  sendCandidate: DesktopProbeCandidateSummary | null;
  topUnreadCandidates: DesktopProbeCandidateSummary[];
}

interface WeChatVisualThreadSummary {
  name: string;
  evidence: string;
  approxSidebarY: number;
  approxBox: WeChatVisualComposerBox | null;
  replyable: boolean;
  threadKind: "chat" | "official_account" | "service" | "unknown";
}

interface WeChatVisualComposerBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WeChatVisualAnalysis {
  openThread: string | null;
  visibleUnreadThreads: WeChatVisualThreadSummary[];
  composer: {
    present: boolean;
    evidence: string;
    approxBox: WeChatVisualComposerBox | null;
  };
  targetThreadOpen?: boolean | null;
  prefillVisible?: boolean | null;
}

interface WeChatVisualThreadGrounding {
  targetVisible: boolean;
  evidence: string;
  clickPoint: {
    x: number;
    y: number;
  } | null;
  rowBox: WeChatVisualComposerBox | null;
}

function defaultDesktopAppTargetForLivePack(livePack: string | null | undefined): string | null {
  switch (String(livePack ?? "")) {
    case "slack-desktop":
      return "Slack";
    case "wechat-desktop":
      return "WeChat";
    case "outlook-desktop":
      return "Microsoft Outlook";
    case "generic-mail-desktop":
      return "Mail";
    default:
      return null;
  }
}

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
const SLACK_NAVIGATION_PATTERN =
  /^(threads|drafts(?:\s*&\s*sent)?|directories|huddles?|starred|direct messages|channels|later|activity|home|canvas|more)$/iu;
const DESKTOP_WINDOW_CONTROL_SUBROLE_PATTERN =
  /(axclosebutton|axminimizebutton|axzoombutton|axfullscreenbutton|axtoolbarbutton)/iu;
const DESKTOP_WINDOW_CONTROL_TEXT_PATTERN =
  /^(close|close button|minimi[sz]e|minimi[sz]e button|zoom|zoom button|full ?screen|enter full ?screen|exit full ?screen|toolbar)$/iu;
const WECHAT_UI_CHROME_PATTERN =
  /^(wechat|微信|搜索|search|send|发送|reply|回复|聊天信息|聊天记录|通讯录|contacts|发现|moments|我|me|文件传输助手|表情|图片|文件|语音消息)$/iu;
const MAIL_UI_CHROME_PATTERN =
  /^(mail|email|gmail|outlook|邮件|inbox|收件箱|已发送|sent|drafts|草稿|spam|archive|归档|trash|垃圾箱|delete|删除|search|搜索|compose|撰写|reply|回复|send|发送)$/iu;
const OUTLOOK_UI_CHROME_PATTERN =
  /^(outlook|focused|other|archive|flag|categories|categorize|junk email|junk|trash|deleted items|drafts|sent items|reply all|forward|new mail|focused inbox|other inbox|respond|收件箱|其他|重点|归档|标记|分类|垃圾邮件|已删除|已发送|新建邮件|回复全部|转发)$/iu;
const BOSS_UI_CHROME_PATTERN =
  /^(boss直聘|boss zhipin|boss|搜索|search|筛选|filter|推荐|推荐牛人|消息|message|messages|职位|jobs|候选人列表|沟通|在线沟通|立即沟通|发消息|发送|send|查看简历)$/iu;
const GOOGLE_DRIVE_UI_CHROME_PATTERN =
  /^(google drive|my drive|priority|recent|shared with me|shared drives|starred|trash|upload to drive|drive uploaded|search)$/iu;
const GOOGLE_DOCS_UI_CHROME_PATTERN =
  /^(google docs|google docs editor|save google doc|saved in google docs|share|comment|format|insert|tools|extensions)$/iu;
const FEISHU_DOCS_UI_CHROME_PATTERN =
  /^(feishu docs|飞书文档编辑区|保存到飞书|已保存到飞书|分享|评论|工具栏|更多)$/iu;
const LOGIN_REQUIRED_PATTERN =
  /(sign in|log in|login|sign into|continue with|重新登录|重新登入|请登录|请先登录|登录继续|登录后继续|登入|登陆|登录|扫码登录)/iu;
const SESSION_EXPIRED_PATTERN =
  /(session expired|sign in again|log in again|reauthenticate|重新登录|会话已过期|登录已过期|登录失效|身份已过期)/iu;
const VERIFICATION_REQUIRED_PATTERN =
  /(captcha|recaptcha|hcaptcha|verify you are human|verify you're human|security check|bot check|are you human|人机验证|验证码|安全验证|验证你是人类|请完成验证)/iu;
const ACCESS_DENIED_PATTERN =
  /(access denied|forbidden|permission denied|unauthorized|not authorized|拒绝访问|无权限|没有权限|访问受限)/iu;

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
  const browserProfilePath = String(
    rule.taskInputs?.browserProfilePath ?? profile.metadata?.browserProfilePath ?? process.env.AGENTOS_BROWSER_PROFILE_PATH ?? ""
  ).trim();
  return {
    id: profile.id,
    taskId: `watch-${rule.id}`,
    rootPath: profile.rootPath,
    profilePath: browserProfilePath
      ? path.isAbsolute(browserProfilePath)
        ? browserProfilePath
        : path.resolve(profile.rootPath, browserProfilePath)
      : profile.profilePath,
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
  context,
  stylePreferences = []
}: {
  family: "chat" | "mail" | "generic";
  goal: string;
  summary: string;
  context: string[];
  stylePreferences?: string[];
}): LivePackDraftResponse {
  const combinedContext = [summary, ...context].filter(Boolean).join("\n");
  const chinese = /[\u4e00-\u9fff]/u.test(`${goal} ${combinedContext}`);
  const styleHints = stylePreferences.join(" ").toLowerCase();
  const wantsConcise = /(short|concise|brief|terse|直接|简短|简洁)/iu.test(styleHints);
  const wantsWarm = /(warm|friendly|polite|礼貌|温和|友好)/iu.test(styleHints);
  const replyText =
    family === "mail"
      ? chinese
        ? wantsConcise
          ? "收到邮件，我会尽快回复。"
          : wantsWarm
            ? "收到你的邮件了，谢谢你，我会尽快处理并回复。"
            : "收到你的邮件，我会尽快处理并回复。"
        : wantsConcise
          ? "Received your email. I will reply shortly."
          : wantsWarm
            ? "Thanks for your email. I received it and will follow up shortly."
            : "Thanks for your email. I received it and will follow up shortly."
      : chinese
        ? wantsConcise
          ? "收到，我尽快处理。"
          : wantsWarm
            ? "收到啦，谢谢你，我会尽快处理。"
            : "收到，我会尽快处理。"
        : wantsConcise
          ? "Got it. Will follow up shortly."
          : wantsWarm
            ? "Got it. I will follow up shortly."
            : "Got it. I will follow up shortly.";
  return {
    replyText,
    metadata: {
      confidence: null,
      rationale: "heuristic fallback",
      source: "heuristic",
      stylePreferences
    }
  };
}

function learnedReplyStylePreferences({
  controlPlane,
  livePack,
  preferredSurface
}: {
  controlPlane: LivePackControlPlane;
  livePack: string;
  preferredSurface: LivePackSurface;
}): string[] {
  return controlPlane.listReplyStylePreferences({
    livePack,
    preferredSurface,
    limit: 6
  });
}

async function draftPackReply({
  controlPlane,
  livePack,
  preferredSurface,
  family,
  goal,
  summary,
  context
}: {
  controlPlane: LivePackControlPlane;
  livePack: string;
  preferredSurface: LivePackSurface;
  family: "chat" | "mail" | "generic";
  goal: string;
  summary: string;
  context: string[];
}): Promise<LivePackDraftResponse> {
  const stylePreferences = learnedReplyStylePreferences({
    controlPlane,
    livePack,
    preferredSurface
  });
  if (controlPlane.modelClient.isConfigured()) {
    const drafted = await controlPlane.modelClient.draftReply({
      goal,
      livePack,
      summary,
      context,
      stylePreferences
    });
    return {
      replyText: String(drafted.replyText ?? "").trim(),
      metadata: {
        confidence: drafted.confidence ?? null,
        rationale: drafted.rationale ?? null,
        source: "model",
        stylePreferences
      }
    };
  }

  if (livePack === "boss-browser") {
    const chinese = /[\u4e00-\u9fff]/u.test(`${goal} ${summary} ${context.join(" ")} ${stylePreferences.join(" ")}`);
    return {
      replyText: chinese
        ? /(?:short|concise|brief|直接|简短|简洁)/iu.test(stylePreferences.join(" "))
          ? "你好，已看到你的信息，我会尽快跟进。"
          : "你好，我已看到你的信息，会尽快查看并和你沟通后续。"
        : /(?:short|concise|brief)/iu.test(stylePreferences.join(" "))
          ? "Thanks, I saw your message and will follow up soon."
          : "Thanks for reaching out. I reviewed your profile and will follow up shortly.",
      metadata: {
        confidence: null,
        rationale: "heuristic recruiting follow-up",
        source: "heuristic",
        stylePreferences
      }
    };
  }

  return draftHeuristicReply({
    family,
    goal,
    summary,
    context,
    stylePreferences
  });
}

function defaultPackCategory(family: LivePackInfo["family"]): LivePackCategory {
  if (family === "chat" || family === "mail") {
    return "conversation";
  }
  if (family === "docs") {
    return "documents";
  }
  if (family === "files") {
    return "files";
  }
  return "generic";
}

function defaultPackCapabilities({
  name,
  family,
  supportsDrafts,
  supportsAutoSend
}: {
  name: string;
  family: LivePackInfo["family"];
  supportsDrafts: boolean;
  supportsAutoSend: boolean;
}): LivePackCapability[] {
  const capabilities: LivePackCapability[] = ["watch_events"];

  if (family === "chat" || family === "mail") {
    capabilities.push("thread_context");
  }
  if (supportsDrafts) {
    capabilities.push("draft_reply");
  }
  if (family === "chat" || family === "mail" || name === "boss-browser") {
    capabilities.push("send_reply");
  }
  if (supportsAutoSend) {
    capabilities.push("auto_send_replies");
  }
  if (family === "docs") {
    capabilities.push("document_edit");
  }
  if (name === "google-drive-browser") {
    capabilities.push("file_upload", "file_download");
  }
  if (name === "boss-browser") {
    capabilities.push("candidate_review");
  }

  return uniqueStrings(capabilities) as LivePackCapability[];
}

function inferPackSurface(name: string, surface: LivePackInfo["surface"] | null | undefined): LivePackInfo["surface"] {
  if (surface === "browser" || surface === "desktop") {
    return surface;
  }
  return /desktop/iu.test(name) ? "desktop" : "browser";
}

function normalizePackInfo(name: string, info: Partial<LivePackInfo> | null | undefined): LivePackInfo {
  const family = (info?.family ?? "generic") as LivePackInfo["family"];
  const supportsDrafts = Boolean(info?.supportsDrafts);
  const supportsAutoSend = Boolean(info?.supportsAutoSend);

  return {
    name,
    family,
    category: info?.category ?? defaultPackCategory(family),
    surface: inferPackSurface(name, info?.surface),
    supportsDrafts,
    supportsAutoSend,
    capabilities:
      (Array.isArray(info?.capabilities) && info?.capabilities.length
        ? uniqueStrings(info.capabilities)
        : defaultPackCapabilities({ name, family, supportsDrafts, supportsAutoSend })) as LivePackCapability[],
    defaultReplyPolicy: info?.defaultReplyPolicy ?? packDefaultReplyPolicy(name),
    description: String(info?.description ?? "Custom live pack"),
    ...(typeof info?.ready === "boolean" ? { ready: info.ready } : {}),
    ...(Array.isArray(info?.healthChecks) ? { healthChecks: info.healthChecks } : {})
  };
}

function normalizeThreadKeyValue(value: unknown): string | null {
  const normalized = String(value ?? "").trim().replace(/\s+/gu, " ");
  return normalized ? normalized.toLowerCase() : null;
}

function parseConversationSender(lines: string[] = []): string | null {
  for (const line of lines) {
    const match = String(line ?? "").trim().match(/^([^:：]{1,40})\s*[:：]\s*\S/u);
    const candidate = match?.[1]?.trim() ?? "";
    if (
      candidate &&
      !/^(conversation|chat|unread|unread thread|new message|new messages|未读|新消息|新候选人|candidate|new candidate)$/iu.test(candidate)
    ) {
      return candidate;
    }
  }
  return null;
}

function inferConversationDirection(sender: string | null): WatchDetectionMetadata["direction"] {
  if (!sender) {
    return "unknown";
  }
  return /^(agentos|assistant|me|我|本人|自己)$/iu.test(sender) ? "outbound" : "inbound";
}

function buildConversationMetadata({
  packName,
  surface,
  summary,
  context = [],
  openTarget = null,
  candidate = null
}: {
  packName: string;
  surface: LivePackInfo["surface"];
  summary: string;
  context?: string[];
  openTarget?: string | null;
  candidate?: InteractionCandidate | Record<string, unknown> | null;
}): WatchDetectionMetadata {
  const sender = parseConversationSender(context);
  const threadKey =
    normalizeThreadKeyValue(summary) ??
    normalizeThreadKeyValue(openTarget) ??
    normalizeThreadKeyValue(candidate && typeof candidate === "object" ? (candidate as { text?: unknown }).text : null) ??
    normalizeThreadKeyValue(context[0]) ??
    normalizeThreadKeyValue(packName);
  const messageSeed = [packName, threadKey ?? "", summary, context.join("|")].join("|");

  return {
    threadKey,
    replyThreadKey: threadKey,
    messageId: fingerprint(messageSeed),
    sender,
    direction: inferConversationDirection(sender),
    receivedAt: new Date().toISOString(),
    requiresAttention: true,
    openCandidate: candidate ?? null,
    surface
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

function summarizeProbeCandidate(
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

function rankProbeCandidates(
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

function frontmostAppExpectation(appName: string): Record<string, unknown> {
  return { frontmostApp: appName };
}

function prefillVerificationExpectation(appName: string): Record<string, unknown> {
  return {
    frontmostApp: appName,
    textVisible: "{{typeTextPreview}}"
  };
}

function wechatVisionThreadExpectation(): Record<string, unknown> {
  return {
    frontmostApp: "WeChat",
    visualCheck: {
      type: "wechat_thread",
      targetThread: "{{threadTitle}}"
    }
  };
}

function wechatVisionPrefillExpectation(): Record<string, unknown> {
  return {
    frontmostApp: "WeChat",
    visualCheck: {
      type: "wechat_prefill",
      targetThread: "{{threadTitle}}",
      replyPreview: "{{typeTextPreview}}"
    }
  };
}

const WECHAT_THREAD_HEADER_REGION = {
  x: 0.34,
  y: 0.02,
  width: 0.6,
  height: 0.26
} as const;

const WECHAT_THREAD_PANE_REGION = {
  x: 0.34,
  y: 0.02,
  width: 0.62,
  height: 0.72
} as const;

const WECHAT_THREAD_BODY_REGION = {
  x: 0.34,
  y: 0.14,
  width: 0.62,
  height: 0.58
} as const;

const WECHAT_COMPOSER_REGION = {
  x: 0.34,
  y: 0.78,
  width: 0.6,
  height: 0.18
} as const;

function wechatThreadOpenedExpectation(): Record<string, unknown> {
  return {
    frontmostApp: "WeChat",
    regionTextAnyVisible: [
      {
        text: "{{threadTitle}}",
        region: WECHAT_THREAD_HEADER_REGION,
        scale: 2.2
      },
      {
        text: "{{threadTitle}}",
        region: WECHAT_THREAD_PANE_REGION,
        scale: 2.2
      }
    ]
  };
}

function wechatPrefillVerificationExpectation(): Record<string, unknown> {
  return {
    frontmostApp: "WeChat",
    regionTextVisible: {
      text: "{{typeTextPreview}}",
      region: WECHAT_COMPOSER_REGION,
      scale: 2.2
    }
  };
}

function normalizeSlackSummary(value: string): string {
  return String(value ?? "")
    .replace(/^[●•]\s*/u, "")
    .replace(/^(unread thread|unread|mention|new message|new messages|未读|新消息)\s*[:：-]?\s*/iu, "")
    .replace(/\s+\(\d+\)$/u, "")
    .trim();
}

function slackChromeKey(text: string): string {
  return normalizeSlackSummary(text)
    .replace(/^[*@]\s*/u, "")
    .replace(/^\d+[a-z]?\s+/iu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function isSlackUiChrome(text: string): boolean {
  const raw = String(text ?? "").trim();
  const key = slackChromeKey(raw);
  return (
    SLACK_UI_CHROME_PATTERN.test(raw) ||
    SLACK_UI_CHROME_PATTERN.test(key) ||
    SLACK_NAVIGATION_PATTERN.test(key)
  );
}

function isSlackDesktopForeground(worldState: WorldState | null): boolean {
  if (!worldState || worldState.surface !== "desktop") {
    return true;
  }

  const appContext = (worldState.appContext ?? {}) as Record<string, unknown>;
  const appName = String(appContext.appName ?? "").trim().toLowerCase();
  return appName.includes("slack");
}

function isWeChatDesktopForeground(worldState: WorldState | null): boolean {
  if (!worldState || worldState.surface !== "desktop") {
    return true;
  }

  const appContext = (worldState.appContext ?? {}) as Record<string, unknown>;
  const appName = String(appContext.appName ?? "").trim().toLowerCase();
  return appName.includes("wechat") || appName.includes("微信");
}

function isOutlookDesktopForeground(worldState: WorldState | null): boolean {
  if (!worldState || worldState.surface !== "desktop") {
    return true;
  }

  const appContext = (worldState.appContext ?? {}) as Record<string, unknown>;
  const appName = String(appContext.appName ?? "").trim().toLowerCase();
  return appName.includes("outlook");
}

function isAccessibilityCandidate(candidate: InteractionCandidate | null | undefined): boolean {
  return String((candidate?.sourceHints ?? {}).source ?? "").toLowerCase() === "accessibility";
}

function isDesktopWindowControlCandidate(candidate: InteractionCandidate | null | undefined): boolean {
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

function conversationCandidates(
  worldState: WorldState | null,
  { desktopRequiresAccessibility = false }: { desktopRequiresAccessibility?: boolean } = {}
): InteractionCandidate[] {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  const accessibilityCandidates = candidates.filter(isAccessibilityCandidate).filter((candidate) => !isDesktopWindowControlCandidate(candidate));
  if (worldState?.surface === "desktop" && desktopRequiresAccessibility) {
    return accessibilityCandidates;
  }

  return accessibilityCandidates.length ? accessibilityCandidates : candidates.filter((candidate) => !isDesktopWindowControlCandidate(candidate));
}

function wechatCandidates(worldState: WorldState | null): InteractionCandidate[] {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  return candidates.filter((candidate) => !isDesktopWindowControlCandidate(candidate));
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

function findSlackUnreadCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = conversationCandidates(worldState, {
    desktopRequiresAccessibility: worldState?.surface === "desktop"
  });
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

function findSlackComposeCandidate(worldState: WorldState | null, surface: LivePackSurface): InteractionCandidate | null {
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

function pickSlackComposeQuery(worldState: WorldState | null, surface: LivePackSurface): string {
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

function findSlackSendCandidate(worldState: WorldState | null, surface: LivePackSurface): InteractionCandidate | null {
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

function pickSlackSendQuery(worldState: WorldState | null, surface: LivePackSurface): string {
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

function normalizeWeChatVisualName(value: unknown): string {
  return normalizeWeChatSummary(String(value ?? ""))
    .replace(/[【】]/gu, "")
    .replace(/[（）()]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function looksLikeWeChatBadgeOnlyName(value: unknown): boolean {
  return /^(?:\d{1,4}|\d{1,4}\+)$/.test(String(value ?? "").trim());
}

function clampUnit(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, numeric));
}

function normalizeWeChatVisualAnalysis(raw: Record<string, unknown> | null | undefined): WeChatVisualAnalysis | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const unreadThreads = Array.isArray(raw.visibleUnreadThreads)
    ? raw.visibleUnreadThreads
        .map((entry) => {
          if (!entry || typeof entry !== "object") {
            return null;
          }
          const name = String((entry as { name?: unknown }).name ?? "").trim();
          if (!name || looksLikeWeChatBadgeOnlyName(name)) {
            return null;
          }
          const approxBoxRaw = ((entry as { approxBox?: unknown }).approxBox ?? null) as Record<string, unknown> | null;
          const approxBox =
            approxBoxRaw &&
            ["x", "y", "width", "height"].every((key) => Number.isFinite(Number(approxBoxRaw[key])))
              ? {
                  x: clampUnit(approxBoxRaw.x, 0),
                  y: clampUnit(approxBoxRaw.y, 0),
                  width: clampUnit(approxBoxRaw.width, 0),
                  height: clampUnit(approxBoxRaw.height, 0)
                }
              : null;
          return {
            name,
            evidence: String((entry as { evidence?: unknown }).evidence ?? "").trim(),
            approxSidebarY: clampUnit((entry as { approxSidebarY?: unknown }).approxSidebarY, 0),
            approxBox,
            replyable:
              typeof (entry as { replyable?: unknown }).replyable === "boolean"
                ? Boolean((entry as { replyable?: unknown }).replyable)
                : true,
            threadKind: (() => {
              const kind = String((entry as { threadKind?: unknown }).threadKind ?? "").trim().toLowerCase();
              if (kind === "chat" || kind === "official_account" || kind === "service") {
                return kind;
              }
              return "chat";
            })()
          } as WeChatVisualThreadSummary;
        })
        .filter((entry): entry is WeChatVisualThreadSummary => Boolean(entry))
    : [];

  const composerRaw = (raw.composer ?? null) as Record<string, unknown> | null;
  const composerBoxRaw = (composerRaw?.approxBox ?? null) as Record<string, unknown> | null;
  const composerBox =
    composerBoxRaw &&
    ["x", "y", "width", "height"].every((key) => Number.isFinite(Number(composerBoxRaw[key])))
      ? {
          x: clampUnit(composerBoxRaw.x, 0),
          y: clampUnit(composerBoxRaw.y, 0),
          width: clampUnit(composerBoxRaw.width, 0),
          height: clampUnit(composerBoxRaw.height, 0)
        }
      : null;

  return {
    openThread: String(raw.openThread ?? "").trim() || null,
    visibleUnreadThreads: unreadThreads,
    composer: {
      present: Boolean(composerRaw?.present),
      evidence: String(composerRaw?.evidence ?? "").trim(),
      approxBox: composerBox
    },
    targetThreadOpen:
      typeof raw.targetThreadOpen === "boolean"
        ? raw.targetThreadOpen
        : null,
    prefillVisible:
      typeof raw.prefillVisible === "boolean"
        ? raw.prefillVisible
        : null
  };
}

function normalizeWeChatVisualThreadGrounding(
  raw: Record<string, unknown> | null | undefined
): WeChatVisualThreadGrounding | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const clickPointRaw = (raw.clickPoint ?? null) as Record<string, unknown> | null;
  const clickPoint =
    clickPointRaw && ["x", "y"].every((key) => Number.isFinite(Number(clickPointRaw[key])))
      ? {
          x: clampUnit(clickPointRaw.x, 0.22),
          y: clampUnit(clickPointRaw.y, 0.2)
        }
      : null;
  const rowBoxRaw = (raw.rowBox ?? null) as Record<string, unknown> | null;
  const rowBox =
    rowBoxRaw && ["x", "y", "width", "height"].every((key) => Number.isFinite(Number(rowBoxRaw[key])))
      ? {
          x: clampUnit(rowBoxRaw.x, 0),
          y: clampUnit(rowBoxRaw.y, 0),
          width: clampUnit(rowBoxRaw.width, 0),
          height: clampUnit(rowBoxRaw.height, 0)
        }
      : null;

  return {
    targetVisible: Boolean(raw.targetVisible),
    evidence: String(raw.evidence ?? "").trim(),
    clickPoint,
    rowBox
  };
}

function resolveWeChatGroundedOpenPoint(
  bounds: InteractionCandidate["bounds"] | null,
  groundedTarget: WeChatVisualThreadGrounding | null,
  fallbackOpenPoint: { x?: number; y?: number } | null
): { x: number; y: number } | null {
  if (bounds && groundedTarget?.targetVisible && groundedTarget.rowBox) {
    const box = groundedTarget.rowBox;
    const anchorXNorm = box.x + Math.min(Math.max(box.width * 0.22, 0.04), box.width * 0.5);
    const anchorYNorm = box.y + box.height * 0.5;
    const x = Number(bounds.x ?? 0) + Number(bounds.width ?? 0) * anchorXNorm;
    const y = Number(bounds.y ?? 0) + Number(bounds.height ?? 0) * anchorYNorm;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { x, y };
    }
  }

  if (bounds && groundedTarget?.targetVisible && groundedTarget.clickPoint) {
    const x = Number(bounds.x ?? 0) + Number(bounds.width ?? 0) * groundedTarget.clickPoint.x;
    const y = Number(bounds.y ?? 0) + Number(bounds.height ?? 0) * groundedTarget.clickPoint.y;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { x, y };
    }
  }

  if (
    fallbackOpenPoint
    && Number.isFinite(Number(fallbackOpenPoint.x ?? NaN))
    && Number.isFinite(Number(fallbackOpenPoint.y ?? NaN))
  ) {
    return {
      x: Number(fallbackOpenPoint.x),
      y: Number(fallbackOpenPoint.y)
    };
  }

  return null;
}

async function analyzeWeChatDesktopVisualState({
  modelClient,
  worldState,
  targetThread = null,
  replyPreview = null,
  timeoutMs = 25000
}: {
  modelClient: Pick<LivePackControlPlane["modelClient"], "supportsImageJson" | "analyzeImageJson"> | null | undefined;
  worldState: WorldState | null;
  targetThread?: string | null;
  replyPreview?: string | null;
  timeoutMs?: number;
}): Promise<WeChatVisualAnalysis | null> {
  if (!modelClient?.supportsImageJson?.()) {
    return null;
  }

  const imagePath = String(worldState?.capture?.path ?? "").trim();
  if (!imagePath) {
    return null;
  }

  const candidateNames = wechatCandidates(worldState)
    .map((candidate) => String(candidate.text ?? "").trim())
    .filter(Boolean)
    .slice(0, 12);
  const lines = visibleLines(worldState).slice(0, 24);
  const target = String(targetThread ?? "").trim();
  const preview = String(replyPreview ?? "").trim();
  const payload = [
    "Analyze this WeChat desktop screenshot for grounded UI state.",
    "Only rely on what is visible in the image.",
    "Focus on the left conversation sidebar for unread rows and the bottom-right composer area for reply input.",
    "Treat red unread count badges, red mention pills such as [@AI], red dots, or red unread markers on a row as unread evidence.",
    "Do not return a standalone red badge number like 33 as the thread name. Always return the conversation title text from the row.",
    "For each unread row, return an approximate normalized bounding box for the full clickable row in the left sidebar.",
    "Unread row boxes must stay inside the left sidebar. Their horizontal center must remain within the left-most 40% of the screenshot.",
    "Do not mark a row as unread from timestamps, snippets, or plain row text alone.",
    "Classify each unread row as threadKind=chat, official_account, service, or unknown.",
    "Set replyable=true only for normal person/group chat rows that AgentOS should answer in the main composer.",
    "Set replyable=false for Official Accounts, article feeds, subscription feeds, payment/service inboxes, or any non-conversational row.",
    candidateNames.length ? `Visible candidate texts:\n${candidateNames.join("\n")}` : "",
    lines.length ? `Visible OCR lines:\n${lines.join("\n")}` : "",
    target ? `Target thread to verify: ${target}` : "",
    preview ? `Reply preview to verify in the composer: ${preview}` : "",
    "Return strict JSON."
  ]
    .filter(Boolean)
    .join("\n\n");

  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    const result = await Promise.race([
      modelClient.analyzeImageJson<Record<string, unknown>>({
        schemaName: "agentos_wechat_desktop_visual",
        schema: {
          type: "object",
          properties: {
            openThread: { type: ["string", "null"] },
            visibleUnreadThreads: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  evidence: { type: "string" },
                  approxSidebarY: { type: "number" },
                  replyable: { type: "boolean" },
                  threadKind: { type: "string", enum: ["chat", "official_account", "service", "unknown"] },
                  approxBox: {
                    type: ["object", "null"],
                    properties: {
                      x: { type: "number" },
                      y: { type: "number" },
                      width: { type: "number" },
                      height: { type: "number" }
                    },
                    required: ["x", "y", "width", "height"],
                    additionalProperties: false
                  }
                },
                required: ["name", "evidence", "approxSidebarY", "replyable", "threadKind", "approxBox"],
                additionalProperties: false
              }
            },
            composer: {
              type: "object",
              properties: {
                present: { type: "boolean" },
                evidence: { type: "string" },
                approxBox: {
                  type: ["object", "null"],
                  properties: {
                    x: { type: "number" },
                    y: { type: "number" },
                    width: { type: "number" },
                    height: { type: "number" }
                  },
                  required: ["x", "y", "width", "height"],
                  additionalProperties: false
                }
              },
              required: ["present", "evidence", "approxBox"],
              additionalProperties: false
            },
            targetThreadOpen: { type: ["boolean", "null"] },
            prefillVisible: { type: ["boolean", "null"] }
          },
          required: ["openThread", "visibleUnreadThreads", "composer"],
          additionalProperties: false
        },
        systemPrompt:
          "You are a strict UI grounding model for AgentOS. Identify the currently open WeChat thread, any clearly visible unread conversation rows in the left sidebar, and the bottom composer area. Only mark a thread as unread when there is visible red badge, red mention tag, red unread count, or red highlight evidence on that row. For each unread row, estimate the clickable row box in normalized screenshot coordinates and classify whether it is a replyable chat versus an official/service feed. Return JSON only.",
        userPrompt: payload,
        imagePath,
        temperature: 0
      }),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`WeChat desktop vision analysis timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);

    return normalizeWeChatVisualAnalysis(result);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function groundWeChatTargetThreadClickPoint({
  modelClient,
  worldState,
  targetThread,
  timeoutMs = 12000
}: {
  modelClient: Pick<LivePackControlPlane["modelClient"], "supportsImageJson" | "analyzeImageJson"> | null | undefined;
  worldState: WorldState | null;
  targetThread: string;
  timeoutMs?: number;
}): Promise<WeChatVisualThreadGrounding | null> {
  if (!modelClient?.supportsImageJson?.()) {
    return null;
  }

  const imagePath = String(worldState?.capture?.path ?? "").trim();
  const target = String(targetThread ?? "").trim();
  if (!imagePath || !target) {
    return null;
  }

  const lines = visibleLines(worldState).slice(0, 24);
  const payload = [
    "Analyze this WeChat desktop screenshot and ground the target conversation row in the left sidebar.",
    "Return a click point that safely selects the target row inside the left conversation list.",
    "The click point must stay inside the left sidebar, on the same horizontal band as the target row, and must not land in the right thread pane or on article cards.",
    `Target thread: ${target}`,
    lines.length ? `Visible OCR lines:\n${lines.join("\n")}` : "",
    "Return strict JSON."
  ]
    .filter(Boolean)
    .join("\n\n");

  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    const result = await Promise.race([
      modelClient.analyzeImageJson<Record<string, unknown>>({
        schemaName: "agentos_wechat_thread_grounding",
        schema: {
          type: "object",
          properties: {
            targetVisible: { type: "boolean" },
            evidence: { type: "string" },
            clickPoint: {
              type: ["object", "null"],
              properties: {
                x: { type: "number" },
                y: { type: "number" }
              },
              required: ["x", "y"],
              additionalProperties: false
            },
            rowBox: {
              type: ["object", "null"],
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                width: { type: "number" },
                height: { type: "number" }
              },
              required: ["x", "y", "width", "height"],
              additionalProperties: false
            }
          },
          required: ["targetVisible", "evidence", "clickPoint", "rowBox"],
          additionalProperties: false
        },
        systemPrompt:
          "You are a strict UI grounding model for AgentOS. Find the target WeChat conversation row in the left sidebar and return JSON only.",
        userPrompt: payload,
        imagePath,
        temperature: 0
      }),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`WeChat thread grounding timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);

    return normalizeWeChatVisualThreadGrounding((result as Record<string, unknown> | null) ?? null);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function isWeChatUiChrome(text: string): boolean {
  return WECHAT_UI_CHROME_PATTERN.test(String(text ?? "").trim());
}

function looksLikeDateOrTimeToken(value: string): boolean {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return false;
  }

  return (
    /^\d{1,4}[/:.-]\d{1,2}(?:[/:.-]\d{1,4})?$/u.test(normalized)
    || /^\d{1,2}:\d{2}(?::\d{2})?$/u.test(normalized)
  );
}

function looksLikeUrlOrDomainToken(value: string): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes("http://")
    || normalized.includes("https://")
    || normalized.includes("www.")
    || /\b[a-z0-9-]+\.(?:com|cn|net|org|io|co|app)\b/u.test(normalized)
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

function isOcrSource(value: unknown) {
  return String(value ?? "").trim().toLowerCase().startsWith("ocr");
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
  if (isOcrSource(source)) {
    score += 6;
  }
  if (source.includes("ocr-wechat-list")) {
    score += 18;
  }
  if (source.includes("ocr-wechat-compose")) {
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
  if (isOcrSource(source)) {
    const appContext = (worldState?.appContext ?? null) as Record<string, unknown> | null;
    const windows = Array.isArray(appContext?.windows)
      ? (appContext.windows as Array<Record<string, unknown>>).filter((entry) => {
          const owner = String(entry?.ownerName ?? "").toLowerCase();
          return owner.includes("wechat") || owner.includes("微信");
        })
      : [];
    const primaryWindow = windows[0] ?? null;
    const captureWindowNumber = Number(appContext?.captureWindowNumber ?? NaN);
    const bounds = candidate.bounds ?? null;
    const windowBounds = (primaryWindow?.bounds ?? null) as InteractionCandidate["bounds"] | null;
    if (bounds && windowBounds) {
      const windowNumber = Number((primaryWindow as Record<string, unknown> | null)?.windowNumber ?? NaN);
      const windowWidth = Math.max(1, Number(windowBounds.width ?? 1));
      const windowHeight = Math.max(1, Number(windowBounds.height ?? 1));
      const usingWindowLocalCoordinates =
        Number.isFinite(captureWindowNumber)
        && captureWindowNumber > 0
        && Number.isFinite(windowNumber)
        && captureWindowNumber === windowNumber;
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

function rankWeChatUnreadCandidates(worldState: WorldState | null): Array<{
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

function findWeChatUnreadCandidate(worldState: WorldState | null): InteractionCandidate | null {
  return rankWeChatUnreadCandidates(worldState)[0]?.candidate ?? null;
}

function findWeChatVisionUnreadCandidate(
  frameBounds: InteractionCandidate["bounds"] | null,
  analysis: WeChatVisualAnalysis | null
): {
  candidate: InteractionCandidate | null;
  openTarget: string | null;
  openPoint: { x: number; y: number } | null;
} | null {
  if (!analysis?.visibleUnreadThreads?.length) {
    return null;
  }

  for (const thread of analysis.visibleUnreadThreads) {
    if (!thread.replyable || thread.threadKind !== "chat") {
      continue;
    }
    const openTarget = String(thread.name ?? "").trim();
    if (!openTarget) {
      continue;
    }
    if (frameBounds) {
      const rowBox = thread.approxBox ?? null;
      const rowCenterXUnit = rowBox ? clampUnit(rowBox.x + rowBox.width / 2, 0.22) : 0.22;
      const safeXUnit = rowCenterXUnit >= 0.05 && rowCenterXUnit <= 0.4 ? rowCenterXUnit : 0.22;
      const rowCenterYUnit = rowBox ? clampUnit(rowBox.y + rowBox.height / 2, clampUnit(thread.approxSidebarY, 0.2)) : clampUnit(thread.approxSidebarY, 0.2);
      const x = Number(frameBounds.x ?? 0) + Number(frameBounds.width ?? 0) * safeXUnit;
      const y = Number(frameBounds.y ?? 0) + Number(frameBounds.height ?? 0) * rowCenterYUnit;
      return {
        candidate: null,
        openTarget,
        openPoint: { x, y }
      };
    }

    return {
      candidate: null,
      openTarget,
      openPoint: null
    };
  }

  return null;
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

function hasWeChatUnreadEvidence(candidate: InteractionCandidate, worldState: WorldState | null): boolean {
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

function findWeChatWindowGeometry(worldState: WorldState | null): {
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
    captureWindowNumber: Number.isFinite(Number(appContext?.captureWindowNumber ?? NaN))
      ? Number(appContext?.captureWindowNumber ?? NaN)
      : null,
    windowNumber: Number.isFinite(Number((primaryWindow as Record<string, unknown> | null)?.windowNumber ?? NaN))
      ? Number((primaryWindow as Record<string, unknown> | null)?.windowNumber ?? NaN)
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
    Number.isFinite(Number(captureWindowNumber))
    && Number(captureWindowNumber) > 0
    && Number.isFinite(Number(windowNumber))
    && Number(captureWindowNumber) === Number(windowNumber);
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

function isWeChatCandidateInThreadBody(candidate: InteractionCandidate | null, worldState: WorldState | null): boolean {
  return isWeChatCandidateInRegion(candidate, worldState, WECHAT_THREAD_BODY_REGION);
}

function findWeChatThreadTargetCandidate(worldState: WorldState | null, summary: string): InteractionCandidate | null {
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
        candidateSummary === normalizedSummary
        || candidateSummary.includes(normalizedSummary)
        || normalizedSummary.includes(candidateSummary)
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

function findWeChatComposeCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = conversationCandidates(worldState);
  return (
    candidates.find((candidate) => {
      const source = String((candidate.sourceHints ?? {}).source ?? "").toLowerCase();
      const hintText = candidateHintText(candidate);
      const inComposeRegion = isWeChatCandidateInComposeRegion(candidate, worldState);
      const placeholderSignal =
        looksLikeWeChatComposePlaceholder(hintText) || looksLikeWeChatComposePlaceholder(candidate.text);
      const sourceIsComposeRegion = source.includes("ocr-wechat-compose");
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

function pickWeChatComposeQuery(worldState: WorldState | null): string {
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

function findWeChatSendCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = conversationCandidates(worldState);
  return (
    candidates.find((candidate) => {
      const hintText = candidateHintText(candidate);
      const source = String((candidate.sourceHints ?? {}).source ?? "").toLowerCase();
      return (
        (candidate.role === "button" || isOcrSource(source)) &&
        (SEND_PATTERN.test(hintText) || SEND_PATTERN.test(candidate.text))
      );
    }) ?? null
  );
}

function pickWeChatSendQuery(worldState: WorldState | null): string {
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

function buildWorldStateFingerprint(worldState: WorldState | null): string {
  const candidateSignature = Array.isArray(worldState?.interactionCandidates)
    ? worldState.interactionCandidates
        .slice(0, 12)
        .map((candidate) => `${candidate.id}:${String(candidate.text ?? "").trim()}`)
        .join("|")
    : "";
  return fingerprint(`${String(worldState?.visibleText ?? "").trim()}|${candidateSignature}`);
}

function deriveWeChatConversationListPoint(worldState: WorldState | null): { x: number; y: number } | null {
  const windowBounds = findDesktopWindowBounds(worldState, "WeChat");
  if (windowBounds) {
    return {
      x: Math.round(Number(windowBounds.x ?? 0) + Number(windowBounds.width ?? 0) * 0.22),
      y: Math.round(Number(windowBounds.y ?? 0) + Number(windowBounds.height ?? 0) * 0.3)
    };
  }

  const candidate = findWeChatUnreadCandidate(worldState);
  if (candidate?.bounds) {
    return {
      x: Math.round(Number(candidate.bounds.centerX ?? 0)),
      y: Math.round(Number(candidate.bounds.centerY ?? 0))
    };
  }

  return null;
}

async function scanWeChatUnreadConversation({
  rule,
  workspace,
  surfaceRegistry,
  initialWorldState
}: LivePackDetectionArgs & { initialWorldState: WorldState | null }): Promise<{
  candidate: InteractionCandidate | null;
  worldState: WorldState | null;
  scrollPasses: number;
}> {
  const initialCandidate = findWeChatUnreadCandidate(initialWorldState);
  if (initialCandidate) {
    return {
      candidate: initialCandidate,
      worldState: initialWorldState,
      scrollPasses: 0
    };
  }

  const adapter = surfaceRegistry.get("desktop");
  if (
    !adapter
    || typeof (adapter as { act?: unknown }).act !== "function"
    || typeof (adapter as { observe?: unknown }).observe !== "function"
  ) {
    return {
      candidate: null,
      worldState: initialWorldState,
      scrollPasses: 0
    };
  }

  const watchTask = createWatchTask(rule);
  const watchWorkspace = profileAsWorkspace(rule, workspace);
  const act = (adapter as { act: (args: unknown) => Promise<unknown> }).act.bind(adapter);
  const observe = (adapter as { observe: (args: unknown) => Promise<WorldState> }).observe.bind(adapter);
  const seenStates = new Set<string>();
  let currentState = initialWorldState;

  for (let pass = 1; pass <= 4; pass += 1) {
    const signature = buildWorldStateFingerprint(currentState);
    if (seenStates.has(signature)) {
      break;
    }
    seenStates.add(signature);

    const listPoint = deriveWeChatConversationListPoint(currentState);
    if (!listPoint) {
      break;
    }

    await act({
      task: watchTask,
      workspace: watchWorkspace,
      traceId: null,
      outputs: {},
      step: {
        id: `watch-wechat-list-focus-${rule.id}-${pass}`,
        label: "Focus WeChat conversation list",
        surface: "desktop",
        action: "clickAt",
        params: listPoint,
        checkpoint: false
      }
    } as never).catch(() => null);

    await act({
      task: watchTask,
      workspace: watchWorkspace,
      traceId: null,
      outputs: {},
      step: {
        id: `watch-wechat-list-scroll-${rule.id}-${pass}`,
        label: "Scroll WeChat conversation list",
        surface: "desktop",
        action: "scroll",
        params: { dx: 0, dy: -420 },
        checkpoint: false
      }
    } as never).catch(() => null);

    currentState = await observe({
      task: watchTask,
      workspace: watchWorkspace,
      traceId: null,
      label: `watch-${rule.id}-wechat-scroll-${pass}`
    } as never).catch(() => currentState);

    const candidate = findWeChatUnreadCandidate(currentState);
    if (candidate) {
      return {
        candidate,
        worldState: currentState,
        scrollPasses: pass
      };
    }
  }

  return {
    candidate: null,
    worldState: currentState,
    scrollPasses: seenStates.size
  };
}

function extractWeChatThreadContext(worldState: WorldState | null, summary: string): string[] {
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

function buildWeChatReplySteps(): RuntimeStep[] {
  return [
    {
      label: "Open unread WeChat conversation",
      surface: "desktop",
      action: "clickTarget",
      params: { targetQuery: "{{openTarget}}" },
      expect: wechatVisionThreadExpectation(),
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
      expect: wechatVisionPrefillExpectation(),
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

function buildWeChatReplyStepsWithComposerFallback({
  includeSendStep = false
}: {
  includeSendStep?: boolean;
} = {}): RuntimeStep[] {
  const steps: RuntimeStep[] = [
    {
      label: "Focus WeChat",
      surface: "desktop",
      action: "focusApp",
      params: { name: "WeChat" },
      expect: frontmostAppExpectation("WeChat"),
      checkpoint: false
    },
    {
      label: "Dismiss stray WeChat overlay",
      surface: "desktop",
      action: "pressKey",
      params: { key: "Escape" },
      checkpoint: false
    },
    {
      label: "Open unread WeChat conversation",
      surface: "desktop",
      action: "clickTarget",
      params: { targetQuery: "{{openTarget}}" },
      checkpoint: false
    },
    {
      label: "Wait for WeChat thread to open",
      surface: "desktop",
      action: "wait",
      params: { ms: 500, timeoutMs: 8000, pollMs: 500 },
      expect: wechatVisionThreadExpectation(),
      checkpoint: false
    },
    {
      label: "Focus WeChat composer area",
      surface: "desktop",
      action: "clickAt",
      params: { x: "{{composeX}}", y: "{{composeY}}" },
      expect: frontmostAppExpectation("WeChat"),
      checkpoint: false
    },
    {
      label: "Type WeChat reply",
      surface: "desktop",
      action: "typeText",
      params: { text: "{{typeText}}" },
      checkpoint: false
    },
    {
      label: "Verify WeChat prefill",
      surface: "desktop",
      action: "wait",
      params: { ms: 250, timeoutMs: 4000, pollMs: 400 },
      expect: wechatVisionPrefillExpectation(),
      checkpoint: false
    }
  ];
  if (includeSendStep) {
    steps.push({
      label: "Send WeChat reply",
      surface: "desktop",
      action: "clickTarget",
      params: { targetQuery: "{{sendTarget}}" },
      checkpoint: false
    });
  }
  return steps;
}

function findDesktopWindowBounds(worldState: WorldState | null, appName: string): InteractionCandidate["bounds"] | null {
  const windows = Array.isArray((worldState?.appContext as { windows?: unknown[] } | null)?.windows)
    ? (((worldState?.appContext as { windows?: unknown[] } | null)?.windows ?? []) as Array<Record<string, unknown>>)
    : [];
  const matched = windows.find((windowInfo) => {
    const ownerName = String(windowInfo?.ownerName ?? "");
    const windowName = String(windowInfo?.windowName ?? "");
    return appName && (ownerName.includes(appName) || windowName.includes(appName));
  });
  return (matched?.bounds ?? null) as InteractionCandidate["bounds"] | null;
}

async function readCaptureImageSize(
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

async function resolveDesktopVisionFrame(
  worldState: WorldState | null,
  appName: string
): Promise<InteractionCandidate["bounds"] | null> {
  const windowBounds = findDesktopWindowBounds(worldState, appName);
  const appContext = (worldState?.appContext ?? null) as Record<string, unknown> | null;
  const windows = Array.isArray(appContext?.windows) ? (appContext.windows as Array<Record<string, unknown>>) : [];
  const matchedWindow = windows.find((windowInfo) => {
    const ownerName = String(windowInfo?.ownerName ?? "");
    const windowName = String(windowInfo?.windowName ?? "");
    return appName && (ownerName.includes(appName) || windowName.includes(appName));
  }) ?? null;
  // Vision boxes are normalized against the screenshot, but click/prefill actions
  // must land in desktop screen coordinates. When we know the target window bounds,
  // prefer those on-screen bounds even if the capture itself is window-local.
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

function deriveWeChatComposerFallback(worldState: WorldState | null): { x: number; y: number } | null {
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

async function deriveWeChatVisualComposerFallback(
  worldState: WorldState | null,
  analysis: WeChatVisualAnalysis | null
): Promise<{ x: number; y: number } | null> {
  const box = analysis?.composer?.approxBox ?? null;
  const bounds = await resolveDesktopVisionFrame(worldState, "WeChat");
  if (!box || !bounds) {
    return null;
  }

  const x = Number(bounds.x ?? 0) + Number(bounds.width ?? 0) * (box.x + box.width / 2);
  const y = Number(bounds.y ?? 0) + Number(bounds.height ?? 0) * (box.y + box.height / 2);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  return { x, y };
}

function normalizeMailSummary(value: string): string {
  return String(value ?? "")
    .replace(/^[●•]\s*/u, "")
    .replace(/^(unread email|unread mail|unread|new mail|new email|未读邮件|未读|新邮件)\s*[:：-]?\s*/iu, "")
    .replace(/^\(\d+\)\s*/u, "")
    .replace(/\s+\(\d+\)$/u, "")
    .trim();
}

function normalizeBossSummary(value: string): string {
  return String(value ?? "")
    .replace(/^[●•]\s*/u, "")
    .replace(/^(new candidate|candidate update|candidate|新候选人|候选人|待沟通|待跟进)\s*[:：-]?\s*/iu, "")
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

function isMailComposerChromeLine(text: string): boolean {
  return /^(send|reply|compose|write|message|editor|发送|回复|撰写|输入)$/iu.test(String(text ?? "").trim());
}

function isOutlookUiChrome(text: string): boolean {
  const normalized = String(text ?? "").trim();
  return isMailUiChrome(normalized) || OUTLOOK_UI_CHROME_PATTERN.test(normalized);
}

function isBossUiChrome(text: string): boolean {
  return BOSS_UI_CHROME_PATTERN.test(String(text ?? "").trim());
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

function browserPackLabel(packName: string): string {
  if (packName === "slack-browser") {
    return "Slack";
  }
  if (packName === "generic-mail-browser") {
    return "mail";
  }
  if (packName === "boss-browser") {
    return "BOSS";
  }
  if (packName === "google-drive-browser") {
    return "Google Drive";
  }
  if (packName === "google-docs-browser") {
    return "Google Docs";
  }
  if (packName === "feishu-docs-browser") {
    return "Feishu Docs";
  }
  return packName.replace(/-browser$/u, "");
}

export function detectBrowserManualIntervention({
  packName,
  worldState,
  rule,
  dedupeState = {}
}: {
  packName: string;
  worldState: WorldState | null;
  rule: WatchRule;
  dedupeState?: Record<string, unknown>;
}): WatchDetection | null {
  const lines = visibleLines(worldState).slice(0, 40);
  const pageText = lines.join("\n");
  if (!pageText.trim()) {
    return null;
  }

  const url = inferBrowserPageUrl(worldState);
  const packLabel = browserPackLabel(packName);
  const baseInputs = {
    startUrl: String(rule.taskInputs?.startUrl ?? rule.taskInputs?.url ?? url ?? "").trim()
  };

  let kind: WatchDetectionMetadata["manualInterventionKind"] = null;
  let detail = "";
  let action = "";
  let summary = "";

  if (VERIFICATION_REQUIRED_PATTERN.test(pageText)) {
    kind = "verification";
    summary = `${packLabel} needs a human verification step`;
    detail = `${packLabel} is showing a verification or CAPTCHA page. AgentOS should pause this watch until you clear it manually.`;
    action = `Open ${packLabel} in the AgentOS browser workspace, complete the verification once, then let the watch continue.`;
  } else if (SESSION_EXPIRED_PATTERN.test(pageText)) {
    kind = "session_expired";
    summary = `${packLabel} session expired`;
    detail = `${packLabel} looks signed out or the browser session expired. AgentOS cannot continue this watch until the session is restored.`;
    action = `Open ${packLabel} in the AgentOS browser workspace and sign in again, then retry the watch.`;
  } else if (LOGIN_REQUIRED_PATTERN.test(pageText)) {
    kind = "login";
    summary = `${packLabel} needs sign-in`;
    detail = `${packLabel} is asking for sign-in before AgentOS can continue watching it.`;
    action = `Open ${packLabel} in the AgentOS browser workspace and sign in once, then retry the watch.`;
  } else if (ACCESS_DENIED_PATTERN.test(pageText)) {
    kind = "access_denied";
    summary = `${packLabel} access is blocked`;
    detail = `${packLabel} is showing an access or permission error. AgentOS cannot continue until the account or page access is fixed.`;
    action = `Check the current ${packLabel} account and permissions in the AgentOS browser workspace, then retry the watch.`;
  }

  if (!kind) {
    return null;
  }

  const fingerprintValue = fingerprint(`${packName}:manual:${kind}:${url ?? ""}:${pageText.slice(0, 500)}`);
  if (dedupeState.lastFingerprint === fingerprintValue) {
    return null;
  }

  return {
    fingerprint: fingerprintValue,
    summary,
    goal: `${summary}. ${action}`,
    text: summary,
    context: lines.slice(0, 6),
    inputs: {
      watchSummary: summary,
      watchContext: lines.slice(0, 6).join("\n"),
      ...baseInputs
    },
    metadata: {
      surface: "browser",
      requiresAttention: true,
      requiresManualIntervention: true,
      manualInterventionKind: kind,
      manualInterventionDetail: detail,
      manualInterventionAction: action
    }
  };
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

function scoreOutlookCandidate({
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

function findOutlookUnreadCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = conversationCandidates(worldState, {
    desktopRequiresAccessibility: true
  });
  const ranked = candidates
    .map((candidate) => ({ candidate, score: scoreOutlookCandidate({ candidate, worldState }) }))
    .filter((entry): entry is { candidate: InteractionCandidate; score: number } => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score);
  return ranked[0]?.candidate ?? null;
}

function scoreBossCandidate({
  candidate,
  worldState
}: {
  candidate: InteractionCandidate;
  worldState: WorldState | null;
}): number | null {
  const hintText = candidateHintText(candidate);
  const summary = normalizeBossSummary(candidate.text || hintText);
  if (!summary || isBossUiChrome(summary) || SEND_PATTERN.test(summary)) {
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

  return score;
}

function findBossCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  const ranked = candidates
    .map((candidate) => ({ candidate, score: scoreBossCandidate({ candidate, worldState }) }))
    .filter((entry): entry is { candidate: InteractionCandidate; score: number } => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score);
  return ranked[0]?.candidate ?? null;
}

function pickMailComposeQuery(worldState: WorldState | null, surface: LivePackSurface): string {
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

function findMailComposeCandidate(worldState: WorldState | null): InteractionCandidate | null {
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

function pickMailSendQuery(worldState: WorldState | null, surface: LivePackSurface): string {
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

function findMailSendCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  return (
    candidates.find((candidate) => {
      const hintText = candidateHintText(candidate);
      return candidate.role === "button" && (SEND_PATTERN.test(hintText) || SEND_PATTERN.test(candidate.text));
    }) ?? null
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
        !isMailComposerChromeLine(line)
      );
    })
  ).slice(0, 5);
}

function findOutlookComposeCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = conversationCandidates(worldState, {
    desktopRequiresAccessibility: true
  });
  return (
    candidates.find((candidate) => {
      const hintText = candidateHintText(candidate);
      return (
        candidate.role === "textbox" ||
        /(reply|message|compose|write|editor|回复|撰写|输入)/iu.test(hintText) ||
        /(reply|message|compose|write|editor|回复|撰写|输入)/iu.test(candidate.text)
      );
    }) ?? null
  );
}

function pickOutlookComposeQuery(worldState: WorldState | null): string {
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

function findOutlookSendCandidate(worldState: WorldState | null): InteractionCandidate | null {
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

function pickOutlookSendQuery(worldState: WorldState | null): string {
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

function extractOutlookThreadContext(worldState: WorldState | null, summary: string): string[] {
  const lines = visibleLines(worldState).filter((line) => !isOutlookUiChrome(line));
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

function extractBossContext(worldState: WorldState | null, summary: string): string[] {
  const lines = visibleLines(worldState).filter((line) => !isBossUiChrome(line));
  const normalizedSummary = normalizeBossSummary(summary);
  const summaryIndex = lines.findIndex((line) => normalizeBossSummary(line) === normalizedSummary);
  const pool = summaryIndex === -1 ? lines : lines.slice(Math.max(0, summaryIndex - 1), summaryIndex + 5);
  return uniqueStrings(
    pool.filter((line) => {
      const normalized = normalizeBossSummary(line);
      return normalized && normalized !== normalizedSummary && !SEND_PATTERN.test(line) && !isBossUiChrome(line);
    })
  ).slice(0, 5);
}

function wantsBossReplyWorkflow(goal: string): boolean {
  return /(reply|respond|contact|message|chat|follow up|outreach|沟通|回复|联系|跟进|发消息)/iu.test(String(goal ?? ""));
}

function pickBossComposeQuery(worldState: WorldState | null): string {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  const composeCandidate =
    candidates.find((candidate) => {
      const hintText = candidateHintText(candidate);
      const tag = String(((candidate.sourceHints ?? {}) as Record<string, unknown>).tag ?? "").toLowerCase();
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
    }) ?? null;

  if (!composeCandidate) {
    return /[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? "")) ? "发送消息" : "Message";
  }

  const hints = (composeCandidate.sourceHints ?? {}) as Record<string, unknown>;
  return (
    String(hints.placeholder ?? hints.ariaLabel ?? composeCandidate.text ?? "").trim() ||
    (/[\u4e00-\u9fff]/u.test(String(worldState?.visibleText ?? "")) ? "发送消息" : "Message")
  );
}

function pickBossSendQuery(worldState: WorldState | null): string {
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

function extractBossThreadContext(worldState: WorldState | null, summary: string): string[] {
  const lines = visibleLines(worldState).filter((line) => !isBossUiChrome(line));
  const normalizedSummary = normalizeBossSummary(summary);
  const summaryIndex = lines.findIndex((line) => normalizeBossSummary(line) === normalizedSummary);
  const pool = summaryIndex === -1 ? lines : lines.slice(Math.max(0, summaryIndex - 1), summaryIndex + 8);
  return uniqueStrings(
    pool.filter((line) => {
      const normalized = normalizeBossSummary(line);
      return (
        normalized &&
        normalized !== normalizedSummary &&
        !SEND_PATTERN.test(line) &&
        !isBossUiChrome(line) &&
        !/^(发送消息|message|reply|chat|contact|沟通|回复|输入|联系)/iu.test(line.trim())
      );
    })
  ).slice(0, 6);
}

function buildMailReplySteps(surface: LivePackSurface): RuntimeStep[] {
  return [
    {
      label: "Open unread mail thread",
      surface,
      action: "clickTarget",
      params: { targetQuery: "{{openTarget}}" },
      ...(surface === "desktop" ? { expect: frontmostAppExpectation("Mail") } : {}),
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
      ...(surface === "desktop" ? { expect: prefillVerificationExpectation("Mail") } : { expect: { textVisible: "{{typeTextPreview}}" } }),
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

function buildOutlookReplySteps(): RuntimeStep[] {
  return [
    {
      label: "Open unread Outlook thread",
      surface: "desktop",
      action: "clickTarget",
      params: { targetQuery: "{{openTarget}}" },
      expect: frontmostAppExpectation("Outlook"),
      checkpoint: false
    },
    {
      label: "Open Outlook reply composer",
      surface: "desktop",
      action: "pressKey",
      params: { key: "r", modifiers: ["meta"] },
      expect: frontmostAppExpectation("Outlook"),
      checkpoint: false
    },
    {
      label: "Wait for Outlook composer",
      surface: "desktop",
      action: "waitForTarget",
      params: { targetQuery: "{{typeTarget}}", timeoutMs: 5000 },
      checkpoint: false
    },
    {
      label: "Type Outlook reply",
      surface: "desktop",
      action: "typeIntoTarget",
      params: { targetQuery: "{{typeTarget}}", text: "{{typeText}}", clear: false },
      expect: prefillVerificationExpectation("Outlook"),
      checkpoint: false
    },
    {
      label: "Send Outlook reply",
      surface: "desktop",
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
      ...(surface === "desktop" ? { expect: frontmostAppExpectation("Slack") } : {}),
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
      ...(surface === "desktop" ? { expect: prefillVerificationExpectation("Slack") } : { expect: { textVisible: "{{typeTextPreview}}" } }),
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

function buildBossReplySteps(): RuntimeStep[] {
  return [
    {
      label: "Open BOSS candidate detail",
      surface: "browser",
      action: "clickTarget",
      params: { targetQuery: "{{openTarget}}" },
      checkpoint: false
    },
    {
      label: "Wait for BOSS candidate thread",
      surface: "browser",
      action: "waitForTarget",
      params: { targetQuery: "{{typeTarget}}", timeoutMs: 5000 },
      checkpoint: false
    },
    {
      label: "Type BOSS reply",
      surface: "browser",
      action: "typeIntoTarget",
      params: { targetQuery: "{{typeTarget}}", text: "{{typeText}}", clear: false },
      checkpoint: false
    },
    {
      label: "Send BOSS reply",
      surface: "browser",
      action: "clickTarget",
      params: { targetQuery: "{{sendTarget}}" },
      checkpoint: false
    }
  ];
}

export function analyzeConversationPack(
  packName: string,
  worldState: WorldState | null
): DesktopConversationPackAnalysis | null {
  const normalizedPackName = String(packName ?? "").trim();
  if (!normalizedPackName) {
    return null;
  }

  if (normalizedPackName === "slack-desktop") {
    const candidates = conversationCandidates(worldState, { desktopRequiresAccessibility: true });
    return {
      packName: normalizedPackName,
      foreground: isSlackDesktopForeground(worldState),
      unreadCandidate: summarizeProbeCandidate(findSlackUnreadCandidate(worldState)),
      composeCandidate: summarizeProbeCandidate(findSlackComposeCandidate(worldState, "desktop")),
      sendCandidate: summarizeProbeCandidate(findSlackSendCandidate(worldState, "desktop")),
      topUnreadCandidates: rankProbeCandidates(worldState, scoreSlackCandidate, candidates)
    };
  }

  if (normalizedPackName === "slack-browser") {
    const candidates = conversationCandidates(worldState);
    return {
      packName: normalizedPackName,
      foreground: true,
      unreadCandidate: summarizeProbeCandidate(findSlackUnreadCandidate(worldState)),
      composeCandidate: summarizeProbeCandidate(findSlackComposeCandidate(worldState, "browser")),
      sendCandidate: summarizeProbeCandidate(findSlackSendCandidate(worldState, "browser")),
      topUnreadCandidates: rankProbeCandidates(worldState, scoreSlackCandidate, candidates)
    };
  }

  if (normalizedPackName === "wechat-desktop") {
    const candidates = conversationCandidates(worldState);
    return {
      packName: normalizedPackName,
      foreground: isWeChatDesktopForeground(worldState),
      unreadCandidate: summarizeProbeCandidate(findWeChatUnreadCandidate(worldState)),
      composeCandidate: summarizeProbeCandidate(findWeChatComposeCandidate(worldState)),
      sendCandidate: summarizeProbeCandidate(findWeChatSendCandidate(worldState)),
      topUnreadCandidates: rankWeChatUnreadCandidates(worldState)
        .slice(0, 5)
        .map((entry) => summarizeProbeCandidate(entry.candidate, entry.score))
        .filter((entry): entry is DesktopProbeCandidateSummary => Boolean(entry))
    };
  }

  if (normalizedPackName === "outlook-desktop") {
    const candidates = conversationCandidates(worldState, { desktopRequiresAccessibility: true });
    return {
      packName: normalizedPackName,
      foreground: isOutlookDesktopForeground(worldState),
      unreadCandidate: summarizeProbeCandidate(findOutlookUnreadCandidate(worldState)),
      composeCandidate: summarizeProbeCandidate(findOutlookComposeCandidate(worldState)),
      sendCandidate: summarizeProbeCandidate(findOutlookSendCandidate(worldState)),
      topUnreadCandidates: rankProbeCandidates(worldState, scoreOutlookCandidate, candidates)
    };
  }

  if (normalizedPackName === "generic-mail-desktop") {
    const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
    return {
      packName: normalizedPackName,
      foreground: true,
      unreadCandidate: summarizeProbeCandidate(findMailUnreadCandidate(worldState)),
      composeCandidate: summarizeProbeCandidate(findMailComposeCandidate(worldState)),
      sendCandidate: summarizeProbeCandidate(findMailSendCandidate(worldState)),
      topUnreadCandidates: rankProbeCandidates(worldState, scoreMailCandidate, candidates)
    };
  }

  if (normalizedPackName === "generic-mail-browser") {
    const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
    return {
      packName: normalizedPackName,
      foreground: true,
      unreadCandidate: summarizeProbeCandidate(findMailUnreadCandidate(worldState)),
      composeCandidate: summarizeProbeCandidate(findMailComposeCandidate(worldState)),
      sendCandidate: summarizeProbeCandidate(findMailSendCandidate(worldState)),
      topUnreadCandidates: rankProbeCandidates(worldState, scoreMailCandidate, candidates)
    };
  }

  if (normalizedPackName === "boss-browser") {
    const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
    return {
      packName: normalizedPackName,
      foreground: true,
      unreadCandidate: summarizeProbeCandidate(findBossCandidate(worldState)),
      composeCandidate: null,
      sendCandidate: null,
      topUnreadCandidates: rankProbeCandidates(worldState, scoreBossCandidate, candidates)
    };
  }

  return null;
}

export function analyzeDesktopConversationPack(
  packName: string,
  worldState: WorldState | null
): DesktopConversationPackAnalysis | null {
  if (!String(packName ?? "").includes("-desktop")) {
    return null;
  }

  return analyzeConversationPack(packName, worldState);
}

export async function analyzeDesktopConversationPackWithVision({
  packName,
  worldState,
  modelClient
}: {
  packName: string;
  worldState: WorldState | null;
  modelClient?: Pick<LivePackControlPlane["modelClient"], "supportsImageJson" | "analyzeImageJson"> | null;
}): Promise<DesktopConversationPackAnalysis | null> {
  const base = analyzeDesktopConversationPack(packName, worldState);
  if (packName !== "wechat-desktop") {
    return base;
  }

  const vision = await analyzeWeChatDesktopVisualState({
    modelClient: modelClient ?? null,
    worldState
  }).catch(() => null);
  if (!vision) {
    return {
      packName: "wechat-desktop",
      foreground: base?.foreground ?? isWeChatDesktopForeground(worldState),
      unreadCandidate: null,
      composeCandidate: null,
      sendCandidate: null,
      topUnreadCandidates: []
    };
  }

  const wechatVisionFrame = await resolveDesktopVisionFrame(worldState, "WeChat");
  const unreadMatch = findWeChatVisionUnreadCandidate(wechatVisionFrame, vision);
  const composeCandidate = vision.composer.present
    ? {
        id: "wechat-vision-composer",
        text: vision.composer.evidence || "WeChat composer",
        role: "textbox",
        interactive: true,
        source: "vision",
        score: 100,
        bounds:
          wechatVisionFrame && vision.composer.approxBox
            ? (() => {
                const bounds = wechatVisionFrame;
                const box = vision.composer.approxBox;
                if (!bounds) {
                  return undefined;
                }
                const x = Number(bounds.x ?? 0) + Number(bounds.width ?? 0) * box.x;
                const y = Number(bounds.y ?? 0) + Number(bounds.height ?? 0) * box.y;
                const width = Number(bounds.width ?? 0) * box.width;
                const height = Number(bounds.height ?? 0) * box.height;
                return {
                  x,
                  y,
                  width,
                  height,
                  centerX: x + width / 2,
                  centerY: y + height / 2
                };
              })()
            : undefined,
        hints: [vision.composer.evidence].filter(Boolean)
      } satisfies DesktopProbeCandidateSummary
    : null;
  const visionThreadCandidates = vision.visibleUnreadThreads.map((thread) => ({
    id: "wechat-vision-unread",
    text: thread.name,
    role: "text",
    interactive: true,
    source: "vision",
    score: 100,
    bounds:
      wechatVisionFrame && thread.approxBox
        ? {
            x: Number(wechatVisionFrame.x ?? 0) + Number(wechatVisionFrame.width ?? 0) * thread.approxBox.x,
            y: Number(wechatVisionFrame.y ?? 0) + Number(wechatVisionFrame.height ?? 0) * thread.approxBox.y,
            width: Number(wechatVisionFrame.width ?? 0) * thread.approxBox.width,
            height: Number(wechatVisionFrame.height ?? 0) * thread.approxBox.height,
            centerX:
              Number(wechatVisionFrame.x ?? 0) +
              Number(wechatVisionFrame.width ?? 0) * (thread.approxBox.x + thread.approxBox.width / 2),
            centerY:
              Number(wechatVisionFrame.y ?? 0) +
              Number(wechatVisionFrame.height ?? 0) * (thread.approxBox.y + thread.approxBox.height / 2)
          }
        : undefined,
    hints: [thread.evidence, `kind:${thread.threadKind}`, thread.replyable ? "replyable" : "non-replyable"].filter(Boolean)
  })) satisfies DesktopProbeCandidateSummary[];

  return {
    packName: "wechat-desktop",
    foreground: base?.foreground ?? isWeChatDesktopForeground(worldState),
    unreadCandidate: unreadMatch
      ? {
          id: "wechat-vision-unread",
          text: unreadMatch.openTarget ?? "",
          role: "text",
          interactive: true,
          source: "vision",
          score: 100,
          bounds:
            visionThreadCandidates.find((candidate) => candidate.text === unreadMatch.openTarget)?.bounds,
          hints: []
        }
      : null,
    composeCandidate,
    sendCandidate: base?.sendCandidate ?? null,
    topUnreadCandidates: visionThreadCandidates
  };
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
    info: normalizePackInfo(name, {
      name,
      family,
      surface: "browser",
      supportsDrafts: false,
      supportsAutoSend: false,
      defaultReplyPolicy: packDefaultReplyPolicy(name),
      description
    }),
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
      const manualIntervention = detectBrowserManualIntervention({
        packName: name,
        worldState,
        rule,
        dedupeState
      });
      if (manualIntervention) {
        return manualIntervention;
      }

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
  surface,
  desktopRequireAccessibility = false
}: LivePackObserveArgs & { surface: LivePackSurface; desktopRequireAccessibility?: boolean }): Promise<WorldState | null> {
  const adapter = surfaceRegistry.get(surface);
  if (!adapter) {
    return null;
  }

  const effectiveDesktopAppTarget =
    surface === "desktop" ? (rule.appTarget ?? defaultDesktopAppTargetForLivePack(rule.livePack)) : null;

  if (surface === "desktop" && effectiveDesktopAppTarget) {
    const watchTask = createWatchTask(rule);
    const watchWorkspace = profileAsWorkspace(rule, workspace);
    const focusStep = {
      id: `watch-refocus-${rule.id}`,
      action: "focusApp",
      surface,
      params: { name: effectiveDesktopAppTarget }
    };
    if (typeof (adapter as { focus?: unknown }).focus === "function") {
      await (adapter as { focus: (args: unknown) => Promise<unknown> })
        .focus({
          task: watchTask,
          workspace: watchWorkspace,
          traceId: null,
          step: focusStep
        })
        .catch(() => null);
    } else {
      await adapter
        .act({
          task: watchTask,
          workspace: watchWorkspace,
          traceId: null,
          outputs: {},
          step: focusStep
        } as never)
        .catch(() => null);
    }

    if (typeof (adapter as DesktopSurfaceReadinessProbe).waitForAppReady === "function") {
      const readiness = await (adapter as DesktopSurfaceReadinessProbe).waitForAppReady?.({
        appName: effectiveDesktopAppTarget,
        timeoutMs: desktopRequireAccessibility ? 1800 : 1200,
        pollMs: 150,
        stablePolls: 2,
        requireAccessibility: desktopRequireAccessibility,
        minAccessibilityCandidates: desktopRequireAccessibility ? 1 : 0
      });
      if (desktopRequireAccessibility && readiness && !readiness.ready) {
        return null;
      }
    }

    if (rule.livePack === "wechat-desktop") {
      await new Promise((resolve) => setTimeout(resolve, 450));
    }
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
    surface,
    desktopRequireAccessibility: surface === "desktop"
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
    info: normalizePackInfo(name, {
      name,
      family: "chat",
      surface,
      supportsDrafts: true,
      supportsAutoSend: true,
      defaultReplyPolicy: packDefaultReplyPolicy(name),
      description
    }),
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
      return observeWatchSurface({
        ...args,
        surface,
        desktopRequireAccessibility: surface === "desktop"
      });
    },
    async detectNewItems({ rule, worldState, dedupeState = {} }) {
      if (surface === "browser") {
        const manualIntervention = detectBrowserManualIntervention({
          packName: name,
          worldState,
          rule,
          dedupeState
        });
        if (manualIntervention) {
          return manualIntervention;
        }
      }

      if (surface === "desktop" && !isSlackDesktopForeground(worldState)) {
        return null;
      }

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

      const metadata = buildConversationMetadata({
        packName: "wechat-desktop",
        surface: "desktop",
        summary,
        context,
        openTarget: String(candidate.text ?? summary).trim() || summary,
        candidate
      });

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
        metadata: buildConversationMetadata({
          packName: name,
          surface,
          summary,
          context,
          openTarget: String(candidate.text ?? summary).trim() || summary,
          candidate
        })
      };
    },
    async extractContext(args) {
      const threadState = await openSlackThreadForContext({ ...args, surface });
      if (surface === "desktop" && !findSlackComposeCandidate(threadState, surface)) {
        return null;
      }
      const composeTarget = pickSlackComposeQuery(threadState, surface);
      const sendTarget = pickSlackSendQuery(threadState, surface);
      const summary = String(args.detection.summary ?? "").trim();
      const context = extractSlackThreadContext(threadState, summary);
      const openTarget = String(args.detection.inputs?.openTarget ?? summary).trim() || summary;
      return {
        summary,
        context,
        inputs: {
          ...(args.detection.inputs ?? {}),
          watchContext: context.join("\n"),
          openTarget,
          typeTarget: composeTarget,
          sendTarget
        },
        metadata: {
          ...(args.detection.metadata ?? {}),
          ...buildConversationMetadata({
            packName: name,
            surface,
            summary,
            context,
            openTarget,
            candidate: (args.detection.metadata?.openCandidate ?? null) as InteractionCandidate | Record<string, unknown> | null
          })
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
      return draftPackReply({
        controlPlane,
        livePack: name,
        preferredSurface: surface,
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
    info: normalizePackInfo("wechat-desktop", {
      name: "wechat-desktop",
      family: "chat",
      surface: "desktop",
      supportsDrafts: true,
      supportsAutoSend: true,
      defaultReplyPolicy: packDefaultReplyPolicy("wechat-desktop"),
      description: "WeChat desktop watcher that detects unread conversations, extracts context, and sends low-risk replies."
    }),
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
      return observeWatchSurface({
        ...args,
        surface: "desktop",
        desktopRequireAccessibility: false
      });
    },
    async detectNewItems({ rule, worldState, dedupeState = {}, controlPlane }) {
      const vision = await analyzeWeChatDesktopVisualState({
        modelClient: controlPlane.modelClient,
        worldState
      }).catch(() => null);
      if (!vision) {
        return null;
      }
      const wechatVisionFrame = await resolveDesktopVisionFrame(worldState, "WeChat");
      const visualMatch = findWeChatVisionUnreadCandidate(wechatVisionFrame, vision);
      const candidate = visualMatch?.candidate ?? null;
      const openTarget = String(visualMatch?.openTarget ?? candidate?.text ?? "").trim();
      if (!candidate && !openTarget) {
        return null;
      }

      const summary = normalizeWeChatSummary(openTarget || candidate?.text || candidateHintText(candidate));
      if (!summary) {
        return null;
      }
      const composerFallback =
        (await deriveWeChatVisualComposerFallback(worldState, vision)) ?? deriveWeChatComposerFallback(worldState);
      if (!composerFallback) {
        return null;
      }

      const groundedTarget = await groundWeChatTargetThreadClickPoint({
        modelClient: controlPlane.modelClient,
        worldState,
        targetThread: openTarget || summary
      }).catch(() => null);

      const context = contextForSignal(worldState, { text: openTarget || candidate?.text || summary });
      const itemFingerprint = fingerprint(
        `wechat-desktop:${rule.workspaceName ?? "default"}:${summary}:${context.join("|")}`
      );
      if (dedupeState.lastFingerprint === itemFingerprint) {
        return null;
      }

      const metadata = buildConversationMetadata({
        packName: "wechat-desktop",
        surface: "desktop",
        summary,
        context,
        openTarget: openTarget || summary,
        candidate
      });
      const openPoint = resolveWeChatGroundedOpenPoint(wechatVisionFrame, groundedTarget, visualMatch?.openPoint ?? null);
      const steps = buildWeChatReplyStepsWithComposerFallback({
        includeSendStep: false
      });
      const openStepIndex = steps.findIndex((step) => String(step.label ?? "").includes("Open unread WeChat conversation"));
      if (openStepIndex >= 0 && steps[openStepIndex]) {
        steps[openStepIndex] = {
          ...steps[openStepIndex],
          ...(Number.isFinite(Number(openPoint?.x ?? NaN)) && Number.isFinite(Number(openPoint?.y ?? NaN))
            ? {
                action: "clickAt",
                params: {
                  x: Number(openPoint?.x),
                  y: Number(openPoint?.y)
                }
              }
            : {
                params: {
                  ...(steps[openStepIndex].params ?? {}),
                  ...(candidate ? { target: candidate } : {})
                }
              })
        };
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
          openTarget: openTarget || summary,
          threadTitle: summary,
          composeX: composerFallback.x,
          composeY: composerFallback.y
        },
        metadata: {
          ...(openPoint ? { openPoint } : {}),
          ...(groundedTarget ? { threadGrounding: groundedTarget } : {}),
          ...(vision ? { visualAnalysis: vision } : {}),
          threadVerificationDeferred: true,
          ...metadata
        },
        taskSpec: {
          preferredSurface: "desktop",
          steps
        }
      };
    },
    async extractContext({ detection, worldState }) {
      const summary = String(detection.summary ?? "").trim();
      const priorVision = normalizeWeChatVisualAnalysis(
        ((detection.metadata as Record<string, unknown> | undefined)?.visualAnalysis ?? null) as Record<string, unknown> | null
      );
      if (!priorVision) {
        return null;
      }

      const context = Array.isArray(detection.context) ? detection.context : [];
      const openTarget = String(detection.inputs?.openTarget ?? summary).trim() || summary;
      return {
        summary,
        context,
        inputs: {
          ...(detection.inputs ?? {}),
          watchContext: context.join("\n"),
          openTarget,
          threadTitle: summary
        },
        metadata: {
          ...(detection.metadata ?? {}),
          ...(priorVision ? { visualAnalysis: priorVision } : {}),
          threadVerificationDeferred: true,
          ...buildConversationMetadata({
            packName: "wechat-desktop",
            surface: "desktop",
            summary,
            context,
            openTarget,
            candidate: (detection.metadata?.openCandidate ?? null) as InteractionCandidate | Record<string, unknown> | null
          })
        },
        taskSpec: detection.taskSpec ?? undefined
      };
    },
    async draftReply({ rule, detection, controlPlane }) {
      const summary = String(detection?.summary ?? "").trim();
      const context = Array.isArray(detection?.context) ? detection.context : [];
      return draftPackReply({
        controlPlane,
        livePack: "wechat-desktop",
        preferredSurface: "desktop",
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
  detection,
  desktopReplyShortcut = null
}: LivePackExtractContextArgs & {
  surface: LivePackSurface;
  desktopReplyShortcut?: { key: string; modifiers?: string[] } | null;
}): Promise<WorldState | null> {
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

  let threadState = await observeWatchSurface({
    rule,
    workspace,
    surfaceRegistry,
    controlPlane: {} as LivePackControlPlane,
    surface,
    desktopRequireAccessibility: surface === "desktop"
  });

  if (
    surface === "desktop" &&
    desktopReplyShortcut &&
    !findOutlookComposeCandidate(threadState)
  ) {
    await adapter.act({
      task: createWatchTask(rule),
      step: {
        id: `mail-reply-shortcut-${rule.id}`,
        label: "Open mail reply composer",
        surface,
        action: "pressKey",
        params: {
          key: desktopReplyShortcut.key,
          modifiers: desktopReplyShortcut.modifiers ?? []
        }
      },
      workspace: profileAsWorkspace(rule, workspace),
      traceId: null,
      outputs: {}
    });

    threadState = await observeWatchSurface({
      rule,
      workspace,
      surfaceRegistry,
      controlPlane: {} as LivePackControlPlane,
      surface,
      desktopRequireAccessibility: surface === "desktop"
    });
  }

  return threadState;
}

async function openBossCandidateForContext({
  rule,
  workspace,
  surfaceRegistry,
  detection
}: LivePackExtractContextArgs): Promise<WorldState | null> {
  const adapter = surfaceRegistry.get("browser");
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
      id: `boss-open-${rule.id}`,
      label: "Open BOSS candidate detail",
      surface: "browser",
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

  const detailReadyTarget = String(detection.inputs?.detailReadyTarget ?? rule.taskInputs?.detailReadyTarget ?? "").trim();
  if (detailReadyTarget) {
    await adapter.act({
      task: createWatchTask(rule),
      step: {
        id: `boss-open-wait-${rule.id}`,
        label: "Wait for BOSS candidate detail",
        surface: "browser",
        action: "waitFor",
        params: {
          text: detailReadyTarget,
          timeoutMs: 5000
        }
      },
      workspace: profileAsWorkspace(rule, workspace),
      traceId: null,
      outputs: {}
    });
  } else {
    await adapter.act({
      task: createWatchTask(rule),
      step: {
        id: `boss-open-delay-${rule.id}`,
        label: "Wait for BOSS candidate detail",
        surface: "browser",
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
    surface: "browser"
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
    info: normalizePackInfo(name, {
      name,
      family: "mail",
      surface,
      supportsDrafts: true,
      supportsAutoSend: false,
      defaultReplyPolicy: packDefaultReplyPolicy(name),
      description
    }),
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
      return observeWatchSurface({
        ...args,
        surface,
        desktopRequireAccessibility: surface === "desktop"
      });
    },
    async detectNewItems({ rule, worldState, dedupeState = {} }) {
      if (surface === "browser") {
        const manualIntervention = detectBrowserManualIntervention({
          packName: name,
          worldState,
          rule,
          dedupeState
        });
        if (manualIntervention) {
          return manualIntervention;
        }
      }

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
        metadata: buildConversationMetadata({
          packName: name,
          surface,
          summary,
          context,
          openTarget: String(candidate.text ?? summary).trim() || summary,
          candidate
        })
      };
    },
    async extractContext(args) {
      const threadState = await openMailThreadForContext({ ...args, surface });
      const summary = String(args.detection.summary ?? "").trim();
      const context = extractMailThreadContext(threadState, summary);
      const openTarget = String(args.detection.inputs?.openTarget ?? summary).trim() || summary;
      return {
        summary,
        context,
        inputs: {
          ...(args.detection.inputs ?? {}),
          watchContext: context.join("\n"),
          openTarget,
          typeTarget: pickMailComposeQuery(threadState, surface),
          sendTarget: pickMailSendQuery(threadState, surface)
        },
        metadata: {
          ...(args.detection.metadata ?? {}),
          ...buildConversationMetadata({
            packName: name,
            surface,
            summary,
            context,
            openTarget,
            candidate: (args.detection.metadata?.openCandidate ?? null) as InteractionCandidate | Record<string, unknown> | null
          })
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
      return draftPackReply({
        controlPlane,
        livePack: name,
        preferredSurface: surface,
        family: "mail",
        goal: rule.goal,
        summary,
        context
      });
    }
  };
}

function createOutlookDesktopPack(): LivePack {
  return {
    name: "outlook-desktop",
    info: normalizePackInfo("outlook-desktop", {
      name: "outlook-desktop",
      family: "mail",
      surface: "desktop",
      supportsDrafts: true,
      supportsAutoSend: false,
      defaultReplyPolicy: packDefaultReplyPolicy("outlook-desktop"),
      description: "Outlook desktop watcher that detects unread mail, extracts thread context, and pre-fills approval-first replies."
    }),
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
            params: { name: rule.appTarget ?? "Microsoft Outlook" }
          },
          workspace: profileAsWorkspace(rule, workspace),
          traceId: null,
          outputs: {}
        })
        .catch(() => null);
    },
    async observeInbox(args) {
      return observeWatchSurface({
        ...args,
        surface: "desktop",
        desktopRequireAccessibility: true
      });
    },
    async detectNewItems({ rule, worldState, dedupeState = {} }) {
      if (!isOutlookDesktopForeground(worldState)) {
        return null;
      }

      const candidate = findOutlookUnreadCandidate(worldState);
      if (!candidate) {
        return null;
      }

      const summary = normalizeMailSummary(candidate.text || candidateHintText(candidate));
      if (!summary || isOutlookUiChrome(summary)) {
        return null;
      }

      const context = contextForSignal(worldState, { text: candidate.text || summary });
      const itemFingerprint = fingerprint(`outlook-desktop:${rule.workspaceName ?? "default"}:${summary}:${context.join("|")}`);
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
        metadata: buildConversationMetadata({
          packName: "outlook-desktop",
          surface: "desktop",
          summary,
          context,
          openTarget: String(candidate.text ?? summary).trim() || summary,
          candidate
        })
      };
    },
    async extractContext({ rule, workspace, surfaceRegistry, detection }) {
      const threadState = await openMailThreadForContext({
        rule,
        workspace,
        surfaceRegistry,
        controlPlane: {} as LivePackControlPlane,
        worldState: null,
        detection,
        surface: "desktop",
        desktopReplyShortcut: {
          key: "r",
          modifiers: ["meta"]
        }
      });
      if (!findOutlookComposeCandidate(threadState)) {
        return null;
      }
      const summary = String(detection.summary ?? "").trim();
      const context = extractOutlookThreadContext(threadState, summary);
      const openTarget = String(detection.inputs?.openTarget ?? summary).trim() || summary;
      return {
        summary,
        context,
        inputs: {
          ...(detection.inputs ?? {}),
          watchContext: context.join("\n"),
          openTarget,
          typeTarget: pickOutlookComposeQuery(threadState),
          sendTarget: pickOutlookSendQuery(threadState)
        },
        metadata: {
          ...(detection.metadata ?? {}),
          ...buildConversationMetadata({
            packName: "outlook-desktop",
            surface: "desktop",
            summary,
            context,
            openTarget,
            candidate: (detection.metadata?.openCandidate ?? null) as InteractionCandidate | Record<string, unknown> | null
          })
        },
        taskSpec: {
          preferredSurface: "desktop",
          steps: buildOutlookReplySteps()
        }
      };
    },
    async draftReply({ rule, detection, controlPlane }) {
      const summary = String(detection?.summary ?? "").trim();
      const context = Array.isArray(detection?.context) ? detection.context : [];
      return draftPackReply({
        controlPlane,
        livePack: "outlook-desktop",
        preferredSurface: "desktop",
        family: "mail",
        goal: rule.goal,
        summary,
        context
      });
    }
  };
}

function createBossPack(): LivePack {
  return {
    name: "boss-browser",
    info: normalizePackInfo("boss-browser", {
      name: "boss-browser",
      family: "generic",
      surface: "browser",
      supportsDrafts: true,
      supportsAutoSend: false,
      defaultReplyPolicy: packDefaultReplyPolicy("boss-browser"),
      description: "BOSS browser watcher that detects new candidates, opens conversation context, and drafts approval-first follow-ups."
    }),
    async activate({ rule, workspace, surfaceRegistry }) {
      const adapter = surfaceRegistry.get("browser");
      if (!adapter) {
        return;
      }

      const startUrl = String(rule.taskInputs?.startUrl ?? rule.taskInputs?.url ?? rule.appTarget ?? "").trim();
      if (/^https?:\/\//u.test(startUrl)) {
        await adapter.act({
          task: createWatchTask(rule),
          step: {
            id: `watch-goto-${rule.id}`,
            action: "goto",
            surface: "browser",
            params: { url: startUrl, waitUntil: "domcontentloaded", timeoutMs: 15000 }
          },
          workspace: profileAsWorkspace(rule, workspace),
          traceId: null,
          outputs: {}
        });
        return;
      }

      await adapter.focus({
        task: createWatchTask(rule),
        workspace: profileAsWorkspace(rule, workspace),
        traceId: null
      }).catch(() => null);
    },
    async observeInbox(args) {
      return observeWatchSurface({ ...args, surface: "browser" });
    },
    async detectNewItems({ rule, worldState, dedupeState = {} }) {
      const manualIntervention = detectBrowserManualIntervention({
        packName: "boss-browser",
        worldState,
        rule,
        dedupeState
      });
      if (manualIntervention) {
        return manualIntervention;
      }

      const candidate = findBossCandidate(worldState);
      if (!candidate) {
        return null;
      }

      const summary = normalizeBossSummary(candidate.text || candidateHintText(candidate));
      if (!summary) {
        return null;
      }

      const context = extractBossContext(worldState, candidate.text || summary);
      const itemFingerprint = fingerprint(
        `boss-browser:${rule.workspaceName ?? "default"}:${summary}:${context.join("|")}`
      );
      if (dedupeState.lastFingerprint === itemFingerprint) {
        return null;
      }

      const startUrl = String(rule.taskInputs?.startUrl ?? rule.taskInputs?.url ?? inferBrowserPageUrl(worldState) ?? "").trim();
      return {
        fingerprint: itemFingerprint,
        summary,
        goal: `${rule.goal}\n\nDetected candidate: ${summary}`,
        text: summary,
        context,
        inputs: {
          watchItemText: summary,
          watchSummary: summary,
          watchContext: context.join("\n"),
          startUrl,
          openTarget: String(candidate.text ?? summary).trim() || summary,
          detailReadyTarget: String(rule.taskInputs?.detailReadyTarget ?? "在线沟通")
        },
        taskSpec: {
          preferredSurface: "browser",
          skillName: "boss-open-candidate",
          executionMode: "planned"
        },
        metadata: {
          ...buildConversationMetadata({
            packName: "boss-browser",
            surface: "browser",
            summary,
            context,
            openTarget: String(candidate.text ?? summary).trim() || summary,
            candidate
          }),
          skillName: "boss-open-candidate"
        }
      };
    },
    async extractContext(args) {
      const threadState = await openBossCandidateForContext(args);
      const summary = String(args.detection.summary ?? "").trim();
      const context = extractBossThreadContext(threadState, summary);
      const replyWorkflow = wantsBossReplyWorkflow(args.rule.goal);
      const openTarget = String(args.detection.inputs?.openTarget ?? summary).trim() || summary;

      return {
        summary,
        context,
        inputs: {
          ...(args.detection.inputs ?? {}),
          watchContext: context.join("\n"),
          openTarget,
          detailReadyTarget: String(args.detection.inputs?.detailReadyTarget ?? "在线沟通"),
          ...(replyWorkflow
            ? {
                typeTarget: pickBossComposeQuery(threadState),
                sendTarget: pickBossSendQuery(threadState)
              }
            : {})
        },
        metadata: {
          ...(args.detection.metadata ?? {}),
          ...buildConversationMetadata({
            packName: "boss-browser",
            surface: "browser",
            summary,
            context,
            openTarget,
            candidate: (args.detection.metadata?.openCandidate ?? null) as InteractionCandidate | Record<string, unknown> | null
          }),
          ...(args.detection.metadata?.skillName ? { skillName: args.detection.metadata.skillName } : {})
        },
        ...(replyWorkflow
          ? {
              taskSpec: {
                preferredSurface: "browser",
                skillName: null,
                steps: buildBossReplySteps()
              }
            }
          : {})
      };
    },
    async draftReply({ rule, detection, controlPlane }) {
      const summary = String(detection?.summary ?? "").trim();
      const context = Array.isArray(detection?.context) ? detection.context : [];
      return draftPackReply({
        controlPlane,
        livePack: "boss-browser",
        preferredSurface: "browser",
        family: "generic",
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
    info: normalizePackInfo(name, {
      name,
      family,
      surface: "desktop",
      supportsDrafts: true,
      supportsAutoSend: family === "chat",
      defaultReplyPolicy: packDefaultReplyPolicy(name),
      description
    }),
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
      return draftPackReply({
        controlPlane,
        livePack: name,
        preferredSurface: "desktop",
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
      createOutlookDesktopPack(),
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
      createBossPack(),
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
    this.packs.set(name, {
      ...pack,
      info: normalizePackInfo(name, pack.info)
    });
  }

  get(name: string): LivePack | null {
    return this.packs.get(name) ?? null;
  }

  list(): string[] {
    return [...this.packs.keys()].sort();
  }

  listInfo(): LivePackInfo[] {
    return [...this.packs.values()]
      .map((pack) => normalizePackInfo(pack.name, pack.info))
      .sort((left, right) => String(left.name).localeCompare(String(right.name)));
  }
}
