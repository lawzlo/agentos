import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { minimumLicenseTierForPack } from "../license.js";
import type { ControlPlane } from "./control-plane.js";
import {
  browserPackLabel,
  defaultBrowserStartUrlForPack,
  inferBrowserManualInterventionFromUrl
} from "./browser-pack-defaults.js";
import { inferReplyLanguage } from "./reply-language.js";
import { packDefaultReplyPolicy } from "./reply-policy.js";
import type { SurfaceRegistry } from "./surface-registry.js";
import type {
  InteractionCandidate,
  LivePackCapability,
  LivePackCategory,
  LivePackInfo,
  RuntimeStep,
  SceneType,
  SurfaceRecoveryAction,
  SurfaceRunnerType,
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
  runnerType?: SurfaceRunnerType;
  scene?: SceneType;
  selectedTarget?: string | null;
  skipReasons?: string[];
  recoveryAction?: SurfaceRecoveryAction | null;
}

interface WeChatVisualThreadSummary {
  name: string;
  evidence: string;
  approxSidebarY: number;
  approxBox: WeChatVisualComposerBox | null;
  replyable: boolean;
  threadKind: "chat" | "official_account" | "service" | "unknown";
  conversationKind: "direct" | "group" | "official_account" | "service" | "unknown";
  shouldReply: boolean;
  replyReason: string;
  subjectCue: string;
  latestSnippet: string;
  priority: "high" | "medium" | "low";
}

interface WeChatVisualComposerBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DesktopVisualThreadSummary {
  name: string;
  evidence: string;
  approxBox: WeChatVisualComposerBox | null;
  replyable: boolean;
  conversationKind: string;
  shouldReply: boolean;
  replyReason: string;
  subjectCue: string;
  latestSnippet: string;
  priority: "high" | "medium" | "low";
}

interface DesktopVisualAnalysis {
  openThread: string | null;
  selectedRow?: string | null;
  visibleUnreadThreads: DesktopVisualThreadSummary[];
  composer: {
    present: boolean;
    evidence: string;
    approxBox: WeChatVisualComposerBox | null;
    entryPoint: { x: number; y: number } | null;
    hasDraftText: boolean | null;
    draftPreview: string | null;
  };
  scene: SceneType;
  sceneEvidence: string;
  recommendedRecoveryAction: SurfaceRecoveryAction | null;
  recoveryControl: {
    present: boolean;
    evidence: string;
    approxBox: WeChatVisualComposerBox | null;
  };
  targetThreadOpen?: boolean | null;
  prefillVisible?: boolean | null;
}

interface WeChatVisualAnalysis {
  openThread: string | null;
  visibleUnreadThreads: WeChatVisualThreadSummary[];
  composer: {
    present: boolean;
    evidence: string;
    approxBox: WeChatVisualComposerBox | null;
    entryPoint: { x: number; y: number } | null;
    hasDraftText: boolean | null;
    draftPreview: string | null;
  };
  scene: SceneType;
  sceneEvidence: string;
  recommendedRecoveryAction: SurfaceRecoveryAction | null;
  recoveryControl: {
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
  coordinateMode?: "normalized" | "pixel";
  clickPoint: {
    x: number;
    y: number;
  } | null;
  rowBox: WeChatVisualComposerBox | null;
}

interface VisionImageSize {
  width: number;
  height: number;
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

export function runnerTypeForPack(packName: string | null | undefined, surface: LivePackSurface | null = null): SurfaceRunnerType {
  const normalized = String(packName ?? "").trim();
  if (normalized === "wechat-desktop" || normalized === "slack-desktop" || normalized === "outlook-desktop") {
    return "desktop_vlm";
  }
  if (surface === "desktop" || normalized.endsWith("-desktop")) {
    return "desktop_ax";
  }
  return "browser_native";
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
  const replyLanguageHint = inferReplyLanguage({ summary, context });
  const chinese =
    replyLanguageHint === "zh"
    || (replyLanguageHint === null && /[\u4e00-\u9fff]/u.test(`${goal} ${combinedContext}`));
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
  let modelError: string | null = null;
  if (controlPlane.modelClient.isConfigured()) {
    try {
      const drafted = await controlPlane.modelClient.draftReply({
        goal,
        livePack,
        summary,
        context,
        stylePreferences,
        replyLanguageHint: inferReplyLanguage({ summary, context })
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
    } catch (error) {
      modelError = error instanceof Error ? error.message : String(error ?? "model draft failed");
    }
  }

  if (livePack === "boss-browser") {
    const replyLanguageHint = inferReplyLanguage({ summary, context });
    const chinese =
      replyLanguageHint === "zh"
      || (replyLanguageHint === null && /[\u4e00-\u9fff]/u.test(`${goal} ${summary} ${context.join(" ")} ${stylePreferences.join(" ")}`));
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
        rationale: modelError ? `heuristic recruiting follow-up after model failure: ${modelError}` : "heuristic recruiting follow-up",
        source: "heuristic",
        stylePreferences,
        ...(modelError ? { modelError } : {})
      }
    };
  }

  const heuristic = draftHeuristicReply({
    family,
    goal,
    summary,
    context,
    stylePreferences
  });
  return {
    ...heuristic,
    metadata: {
      ...(heuristic.metadata ?? {}),
      ...(modelError ? { modelError, rationale: `heuristic fallback after model failure: ${modelError}` } : {})
    }
  };
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
    minimumLicenseTier: info?.minimumLicenseTier ?? minimumLicenseTierForPack(name),
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

function desktopVisionThreadExpectation(appName: string, type: string): Record<string, unknown> {
  return {
    frontmostApp: appName,
    visualCheck: {
      type,
      targetThread: "{{threadTitle}}"
    }
  };
}

function desktopVisionPrefillExpectation(appName: string, type: string): Record<string, unknown> {
  return {
    frontmostApp: appName,
    visualCheck: {
      type,
      targetThread: "{{threadTitle}}",
      replyPreview: "{{typeTextPreview}}"
    }
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

function isExpectedDesktopForeground(worldState: WorldState | null, targetAppName: string): boolean {
  if (!worldState || worldState.surface !== "desktop") {
    return true;
  }

  const appContext = (worldState.appContext ?? {}) as Record<string, unknown>;
  const currentAppName = String(appContext.appName ?? "").trim().toLowerCase();
  const normalizedTarget = String(targetAppName ?? "").trim().toLowerCase();
  if (!normalizedTarget) {
    return true;
  }

  const aliases =
    normalizedTarget.includes("outlook")
      ? ["outlook"]
      : normalizedTarget.includes("wechat") || normalizedTarget.includes("微信")
        ? ["wechat", "微信"]
        : normalizedTarget.includes("slack")
          ? ["slack"]
          : [normalizedTarget];
  return aliases.some((alias) => currentAppName.includes(alias));
}

function isWeChatDesktopForeground(worldState: WorldState | null): boolean {
  return isExpectedDesktopForeground(worldState, "WeChat");
}

function isOutlookDesktopForeground(worldState: WorldState | null): boolean {
  return isExpectedDesktopForeground(worldState, "Microsoft Outlook");
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

function normalizeWeChatConversationKind(
  value: unknown
): "direct" | "group" | "official_account" | "service" | "unknown" {
  const kind = String(value ?? "").trim().toLowerCase();
  if (kind === "direct" || kind === "group" || kind === "official_account" || kind === "service") {
    return kind;
  }
  return "unknown";
}

function normalizeWeChatPriority(value: unknown, fallback: "high" | "medium" | "low" = "low"): "high" | "medium" | "low" {
  const priority = String(value ?? "").trim().toLowerCase();
  if (priority === "high" || priority === "medium" || priority === "low") {
    return priority;
  }
  return fallback;
}

function parseWeChatMemberCount(name: string): number | null {
  const match = String(name ?? "").match(/\((\d{1,5})\)\s*$/u);
  if (!match) {
    return null;
  }
  const value = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(value) ? value : null;
}

function weChatThreadNeedsReply(thread: WeChatVisualThreadSummary): boolean {
  if (!thread.replyable || thread.threadKind !== "chat" || !thread.shouldReply) {
    return false;
  }

  if (thread.conversationKind !== "group") {
    return true;
  }

  const signals = [thread.evidence, thread.replyReason, thread.latestSnippet, thread.name].join(" ");
  const explicitlyAddressed = /@|提到你|asked you|needs your reply|question|请问|求助|回复|回下|帮忙|吗|？|\?/iu.test(signals);
  if (explicitlyAddressed) {
    return true;
  }

  const memberCount = parseWeChatMemberCount(thread.name);
  if (memberCount != null && memberCount >= 40) {
    return false;
  }

  return normalizeWeChatPriority(thread.priority, "low") !== "low";
}

function compareWeChatThreadPriority(left: WeChatVisualThreadSummary, right: WeChatVisualThreadSummary): number {
  const priorityRank = (thread: WeChatVisualThreadSummary): number => {
    const priority = normalizeWeChatPriority(thread.priority, "low");
    if (priority === "high") {
      return 3;
    }
    if (priority === "medium") {
      return 2;
    }
    return 1;
  };
  const kindRank = (thread: WeChatVisualThreadSummary): number => {
    if (thread.conversationKind === "direct") {
      return 3;
    }
    if (thread.conversationKind === "group") {
      return 2;
    }
    return 1;
  };
  return priorityRank(right) - priorityRank(left) || kindRank(right) - kindRank(left);
}

function clampUnit(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, numeric));
}

function normalizeVisionBox(
  raw: Record<string, unknown> | null | undefined,
  imageSize: VisionImageSize | null = null
): WeChatVisualComposerBox | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  if (!["x", "y", "width", "height"].every((key) => Number.isFinite(Number(raw[key])))) {
    return null;
  }
  const x = Number(raw.x);
  const y = Number(raw.y);
  const width = Number(raw.width);
  const height = Number(raw.height);
  if ([x, y, width, height].some((value) => value > 1) && imageSize && imageSize.width > 0 && imageSize.height > 0) {
    return {
      x: clampUnit(x / imageSize.width, 0),
      y: clampUnit(y / imageSize.height, 0),
      width: clampUnit(width / imageSize.width, 0),
      height: clampUnit(height / imageSize.height, 0)
    };
  }
  return {
    x: clampUnit(x, 0),
    y: clampUnit(y, 0),
    width: clampUnit(width, 0),
    height: clampUnit(height, 0)
  };
}

function normalizeVisualScene(raw: Record<string, unknown>, unreadCount: number, composerPresent: boolean): SceneType {
  const scene = String(raw.scene ?? "").trim().toLowerCase();
  if (scene === "chat_list" || scene === "list") {
    return "list";
  }
  if (scene === "thread_open" || scene === "thread") {
    return "thread";
  }
  if (scene === "foreign_view") {
    return "foreign_view";
  }
  if (scene === "signin") {
    return "signin";
  }
  if (scene === "verification") {
    return "verification";
  }
  if (typeof raw.targetThreadOpen === "boolean" && raw.targetThreadOpen) {
    return "thread";
  }
  if (composerPresent && String(raw.openThread ?? "").trim()) {
    return "thread";
  }
  if (unreadCount > 0) {
    return "list";
  }
  return "unknown";
}

function normalizeRecoveryAction(raw: Record<string, unknown>, scene: SceneType): SurfaceRecoveryAction | null {
  const action = String(raw.recommendedRecoveryAction ?? "").trim().toLowerCase();
  if (action === "recover_to_list" || action === "complete_signin" || action === "complete_verification" || action === "takeover") {
    return action as SurfaceRecoveryAction;
  }
  if (action === "none") {
    return "none" as const;
  }
  return scene === "foreign_view" ? "recover_to_list" : null;
}

function normalizeDesktopVisualThreads(
  raw: Record<string, unknown> | null | undefined,
  {
    normalizeName = (value: unknown) => String(value ?? "").trim(),
    imageSize = null
  }: {
    normalizeName?: (value: unknown) => string;
    imageSize?: VisionImageSize | null;
  } = {}
): DesktopVisualThreadSummary[] {
  const rawThreads = Array.isArray(raw?.visibleUnreadThreads)
    ? raw.visibleUnreadThreads
    : raw?.bestUnreadThread && typeof raw.bestUnreadThread === "object"
      ? [raw.bestUnreadThread]
      : [];

  return rawThreads
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      if (
        "present" in entry &&
        typeof (entry as { present?: unknown }).present === "boolean" &&
        !Boolean((entry as { present?: unknown }).present)
      ) {
        return null;
      }
      const name = normalizeName((entry as { name?: unknown }).name);
      if (!name) {
        return null;
      }
      return {
        name,
        evidence: String((entry as { evidence?: unknown }).evidence ?? "").trim(),
        approxBox: normalizeVisionBox(
          ((entry as { approxBox?: unknown }).approxBox ?? null) as Record<string, unknown> | null,
          imageSize
        ),
        replyable:
          typeof (entry as { replyable?: unknown }).replyable === "boolean"
            ? Boolean((entry as { replyable?: unknown }).replyable)
            : true,
        conversationKind: String((entry as { conversationKind?: unknown }).conversationKind ?? "unknown").trim() || "unknown",
        shouldReply:
          typeof (entry as { shouldReply?: unknown }).shouldReply === "boolean"
            ? Boolean((entry as { shouldReply?: unknown }).shouldReply)
            : typeof (entry as { replyable?: unknown }).replyable === "boolean"
              ? Boolean((entry as { replyable?: unknown }).replyable)
              : true,
        replyReason: String((entry as { replyReason?: unknown }).replyReason ?? "").trim(),
        subjectCue: String((entry as { subjectCue?: unknown }).subjectCue ?? "").trim(),
        latestSnippet: String((entry as { latestSnippet?: unknown }).latestSnippet ?? "").trim(),
        priority: normalizeWeChatPriority((entry as { priority?: unknown }).priority, "low")
      } satisfies DesktopVisualThreadSummary;
    })
    .filter((entry): entry is DesktopVisualThreadSummary => Boolean(entry));
}

function normalizeDesktopVisualAnalysis(
  raw: Record<string, unknown> | null | undefined,
  {
    normalizeName = (value: unknown) => String(value ?? "").trim(),
    imageSize = null
  }: {
    normalizeName?: (value: unknown) => string;
    imageSize?: VisionImageSize | null;
  } = {}
): DesktopVisualAnalysis | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const visibleUnreadThreads = normalizeDesktopVisualThreads(raw, { normalizeName, imageSize });
  const composerRaw = (raw.composer ?? null) as Record<string, unknown> | null;
  const recoveryRaw = (raw.recoveryControl ?? null) as Record<string, unknown> | null;
  const composerBox = normalizeVisionBox((composerRaw?.approxBox ?? null) as Record<string, unknown> | null, imageSize);
  const composerEntryPointRaw = (composerRaw?.entryPoint ?? null) as Record<string, unknown> | null;
  const composerEntryPoint =
    composerEntryPointRaw &&
    Number.isFinite(Number(composerEntryPointRaw.x)) &&
    Number.isFinite(Number(composerEntryPointRaw.y))
      ? {
          x: clampUnit(composerEntryPointRaw.x, 0),
          y: clampUnit(composerEntryPointRaw.y, 0)
        }
      : null;
  const recoveryBox = normalizeVisionBox((recoveryRaw?.approxBox ?? null) as Record<string, unknown> | null, imageSize);
  const composerPresent = Boolean(composerRaw?.present);
  const scene = normalizeVisualScene(raw, visibleUnreadThreads.length, composerPresent);

  return {
    openThread: normalizeName(raw.openThread) || null,
    selectedRow: normalizeName(raw.selectedRow) || null,
    visibleUnreadThreads,
    composer: {
      present: composerPresent,
      evidence: String(composerRaw?.evidence ?? "").trim(),
      approxBox: composerBox,
      entryPoint: composerEntryPoint,
      hasDraftText:
        typeof composerRaw?.hasDraftText === "boolean"
          ? composerRaw.hasDraftText
          : null,
      draftPreview: String(composerRaw?.draftPreview ?? "").trim() || null
    },
    scene,
    sceneEvidence: String(raw.sceneEvidence ?? raw.openThread ?? composerRaw?.evidence ?? "").trim(),
    recommendedRecoveryAction: normalizeRecoveryAction(raw, scene),
    recoveryControl: {
      present: Boolean(recoveryRaw?.present) || Boolean(recoveryBox),
      evidence: String(recoveryRaw?.evidence ?? "").trim(),
      approxBox: recoveryBox
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
            })(),
            conversationKind: normalizeWeChatConversationKind(
              (entry as { conversationKind?: unknown }).conversationKind
            ),
            shouldReply:
              typeof (entry as { shouldReply?: unknown }).shouldReply === "boolean"
                ? Boolean((entry as { shouldReply?: unknown }).shouldReply)
                : typeof (entry as { replyable?: unknown }).replyable === "boolean"
                  ? Boolean((entry as { replyable?: unknown }).replyable)
                  : true,
            replyReason: String((entry as { replyReason?: unknown }).replyReason ?? "").trim(),
            subjectCue: String((entry as { subjectCue?: unknown }).subjectCue ?? "").trim(),
            latestSnippet: String((entry as { latestSnippet?: unknown }).latestSnippet ?? "").trim(),
            priority: normalizeWeChatPriority(
              (entry as { priority?: unknown }).priority,
              typeof (entry as { shouldReply?: unknown }).shouldReply === "boolean"
                && Boolean((entry as { shouldReply?: unknown }).shouldReply)
                ? "medium"
                : "low"
            )
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
  const composerEntryPointRaw = (composerRaw?.entryPoint ?? null) as Record<string, unknown> | null;
  const composerEntryPoint =
    composerEntryPointRaw &&
    Number.isFinite(Number(composerEntryPointRaw.x)) &&
    Number.isFinite(Number(composerEntryPointRaw.y))
      ? {
          x: clampUnit(composerEntryPointRaw.x, 0),
          y: clampUnit(composerEntryPointRaw.y, 0)
        }
      : null;
  const recoveryRaw = (raw.recoveryControl ?? null) as Record<string, unknown> | null;
  const recoveryBoxRaw = (recoveryRaw?.approxBox ?? null) as Record<string, unknown> | null;
  const recoveryBox =
    recoveryBoxRaw &&
    ["x", "y", "width", "height"].every((key) => Number.isFinite(Number(recoveryBoxRaw[key])))
      ? {
          x: clampUnit(recoveryBoxRaw.x, 0),
          y: clampUnit(recoveryBoxRaw.y, 0),
          width: clampUnit(recoveryBoxRaw.width, 0),
          height: clampUnit(recoveryBoxRaw.height, 0)
        }
      : null;

  const normalizedScene = (() => {
    const scene = String(raw.scene ?? "").trim().toLowerCase();
    if (scene === "chat_list" || scene === "list") {
      return "list" satisfies SceneType;
    }
    if (scene === "thread_open" || scene === "thread") {
      return "thread" satisfies SceneType;
    }
    if (scene === "foreign_view") {
      return "foreign_view" satisfies SceneType;
    }
    if (scene === "signin") {
      return "signin" satisfies SceneType;
    }
    if (scene === "verification") {
      return "verification" satisfies SceneType;
    }
    if (typeof raw.targetThreadOpen === "boolean" && raw.targetThreadOpen) {
      return "thread" satisfies SceneType;
    }
    if (Boolean(composerRaw?.present) && String(raw.openThread ?? "").trim()) {
      return "thread" satisfies SceneType;
    }
    if (unreadThreads.length > 0) {
      return "list" satisfies SceneType;
    }
    return "unknown" satisfies SceneType;
  })();
  const recommendedRecoveryAction = (() => {
    const action = String(raw.recommendedRecoveryAction ?? "").trim().toLowerCase();
    if (action === "recover_to_list" || action === "complete_signin" || action === "complete_verification" || action === "takeover") {
      return action as SurfaceRecoveryAction;
    }
    if (action === "none") {
      return "none" as const;
    }
    return normalizedScene === "foreign_view" ? "recover_to_list" : null;
  })();

  return {
    openThread: String(raw.openThread ?? "").trim() || null,
    visibleUnreadThreads: unreadThreads,
    composer: {
      present: Boolean(composerRaw?.present),
      evidence: String(composerRaw?.evidence ?? "").trim(),
      approxBox: composerBox,
      entryPoint: composerEntryPoint,
      hasDraftText:
        typeof composerRaw?.hasDraftText === "boolean"
          ? composerRaw.hasDraftText
          : null,
      draftPreview: String(composerRaw?.draftPreview ?? "").trim() || null
    },
    scene: normalizedScene,
    sceneEvidence: String(raw.sceneEvidence ?? raw.openThread ?? composerRaw?.evidence ?? "").trim(),
    recommendedRecoveryAction,
    recoveryControl: {
      present: Boolean(recoveryRaw?.present) || Boolean(recoveryBox),
      evidence: String(recoveryRaw?.evidence ?? "").trim(),
      approxBox: recoveryBox
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
  const rowBoxRaw = (raw.rowBox ?? null) as Record<string, unknown> | null;
  const coordinateMode = [
    Number(clickPointRaw?.x ?? NaN),
    Number(clickPointRaw?.y ?? NaN),
    Number(rowBoxRaw?.x ?? NaN),
    Number(rowBoxRaw?.y ?? NaN),
    Number(rowBoxRaw?.width ?? NaN),
    Number(rowBoxRaw?.height ?? NaN)
  ].some((value) => Number.isFinite(value) && value > 1)
    ? "pixel"
    : "normalized";
  const clickPoint =
    clickPointRaw && ["x", "y"].every((key) => Number.isFinite(Number(clickPointRaw[key])))
      ? {
          x:
            coordinateMode === "pixel"
              ? Number(clickPointRaw.x)
              : clampUnit(clickPointRaw.x, 0.22),
          y:
            coordinateMode === "pixel"
              ? Number(clickPointRaw.y)
              : clampUnit(clickPointRaw.y, 0.2)
        }
      : null;
  const rowBox =
    rowBoxRaw && ["x", "y", "width", "height"].every((key) => Number.isFinite(Number(rowBoxRaw[key])))
      ? {
          x: coordinateMode === "pixel" ? Number(rowBoxRaw.x) : clampUnit(rowBoxRaw.x, 0),
          y: coordinateMode === "pixel" ? Number(rowBoxRaw.y) : clampUnit(rowBoxRaw.y, 0),
          width: coordinateMode === "pixel" ? Number(rowBoxRaw.width) : clampUnit(rowBoxRaw.width, 0),
          height: coordinateMode === "pixel" ? Number(rowBoxRaw.height) : clampUnit(rowBoxRaw.height, 0)
        }
      : null;

  return {
    targetVisible: Boolean(raw.targetVisible),
    evidence: String(raw.evidence ?? "").trim(),
    coordinateMode,
    clickPoint,
    rowBox
  };
}

function normalizeWeChatGroundingWithImageSize(
  grounding: WeChatVisualThreadGrounding | null,
  imageSize: { width: number; height: number } | null
): WeChatVisualThreadGrounding | null {
  if (!grounding || !imageSize || !(imageSize.width > 0) || !(imageSize.height > 0)) {
    return grounding;
  }

  const normalizeX = (value: number) => (value > 1 ? value / imageSize.width : value);
  const normalizeY = (value: number) => (value > 1 ? value / imageSize.height : value);
  const clickPoint = grounding.clickPoint
    ? {
        x: clampUnit(normalizeX(Number(grounding.clickPoint.x ?? 0)), 0.22),
        y: clampUnit(normalizeY(Number(grounding.clickPoint.y ?? 0)), 0.2)
      }
    : null;
  const rowBox = grounding.rowBox
    ? {
        x: clampUnit(normalizeX(Number(grounding.rowBox.x ?? 0)), 0),
        y: clampUnit(normalizeY(Number(grounding.rowBox.y ?? 0)), 0),
        width: clampUnit(normalizeX(Number(grounding.rowBox.width ?? 0)), 0),
        height: clampUnit(normalizeY(Number(grounding.rowBox.height ?? 0)), 0)
      }
    : null;

  return {
    ...grounding,
    coordinateMode: grounding.coordinateMode ?? "normalized",
    clickPoint,
    rowBox
  };
}

function inferGenericConversationScene(
  analysis: Pick<DesktopConversationPackAnalysis, "unreadCandidate" | "composeCandidate" | "topUnreadCandidates">
): SceneType {
  if (analysis.composeCandidate) {
    return "thread";
  }
  if (analysis.unreadCandidate || analysis.topUnreadCandidates.length > 0) {
    return "list";
  }
  return "unknown";
}

function defaultSkipReasonsForAnalysis(
  analysis: Pick<DesktopConversationPackAnalysis, "unreadCandidate" | "composeCandidate" | "topUnreadCandidates">
): string[] {
  if (!analysis.unreadCandidate && analysis.topUnreadCandidates.length === 0) {
    return ["no_visible_thread"];
  }
  if (analysis.unreadCandidate && !analysis.composeCandidate) {
    return [];
  }
  return [];
}

function withAnalysisSemantics(
  analysis: DesktopConversationPackAnalysis,
  overrides: Partial<Pick<DesktopConversationPackAnalysis, "runnerType" | "scene" | "selectedTarget" | "skipReasons" | "recoveryAction">> = {}
): DesktopConversationPackAnalysis {
  const scene = overrides.scene ?? inferGenericConversationScene(analysis);
  return {
    ...analysis,
    runnerType: overrides.runnerType ?? runnerTypeForPack(analysis.packName),
    scene,
    selectedTarget:
      overrides.selectedTarget
      ?? analysis.unreadCandidate?.text
      ?? analysis.composeCandidate?.text
      ?? null,
    skipReasons: overrides.skipReasons ?? defaultSkipReasonsForAnalysis(analysis),
    recoveryAction: overrides.recoveryAction ?? null
  };
}

function deriveWeChatSkipReasons({
  vision,
  unreadMatch
}: {
  vision: WeChatVisualAnalysis;
  unreadMatch: ReturnType<typeof findWeChatVisionUnreadCandidate>;
}): string[] {
  const reasons: string[] = [];
  if (vision.scene === "foreign_view") {
    reasons.push("foreign_view");
  }
  if (!unreadMatch) {
    if (vision.visibleUnreadThreads.some((thread) => !thread.shouldReply || !thread.replyable)) {
      reasons.push("no_reply_worthy_thread");
    } else {
      reasons.push("no_visible_thread");
    }
  }
  if (vision.scene === "thread" && !vision.composer.present) {
    reasons.push("no_visible_composer");
  }
  if (vision.composer.present && vision.composer.hasDraftText === true) {
    reasons.push("existing_draft_visible");
  }

  return uniqueStrings([
    ...reasons,
    ...(vision.composer.hasDraftText && vision.composer.draftPreview
      ? [`draft:${vision.composer.draftPreview}`]
      : []),
    ...vision.visibleUnreadThreads
      .filter((thread) => !thread.shouldReply || !thread.replyable)
      .map((thread) => thread.replyReason || `skip:${thread.name}`)
  ]).slice(0, 6);
}

function deriveDesktopVisualSkipReasons({
  vision,
  unreadThread
}: {
  vision: DesktopVisualAnalysis;
  unreadThread: DesktopVisualThreadSummary | null;
}): string[] {
  const reasons: string[] = [];
  if (vision.scene === "foreign_view") {
    reasons.push("foreign_view");
  }
  if (!unreadThread) {
    if (vision.visibleUnreadThreads.some((thread) => !thread.shouldReply || !thread.replyable)) {
      reasons.push("no_reply_worthy_thread");
    } else {
      reasons.push("no_visible_thread");
    }
  }
  if (vision.scene === "thread" && !vision.composer.present) {
    reasons.push("no_visible_composer");
  }

  return uniqueStrings([
    ...reasons,
    ...vision.visibleUnreadThreads
      .filter((thread) => !thread.shouldReply || !thread.replyable)
      .map((thread) => thread.replyReason || `skip:${thread.name}`)
  ]).slice(0, 6);
}

function visionErrorSkipReasons(base: DesktopConversationPackAnalysis | null, error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return uniqueStrings([
    ...(Array.isArray(base?.skipReasons) ? base.skipReasons : []),
    message ? `vision_error:${message}` : "vision_error"
  ]).slice(0, 6);
}

async function resolveDesktopVisionCandidateBounds(
  worldState: WorldState | null,
  appName: string,
  box: WeChatVisualComposerBox | null
): Promise<InteractionCandidate["bounds"] | undefined> {
  if (!box) {
    return undefined;
  }
  const frame = await resolveDesktopVisionFrame(worldState, appName);
  if (!frame) {
    return undefined;
  }
  const x = Number(frame.x ?? 0) + Number(frame.width ?? 0) * box.x;
  const y = Number(frame.y ?? 0) + Number(frame.height ?? 0) * box.y;
  const width = Number(frame.width ?? 0) * box.width;
  const height = Number(frame.height ?? 0) * box.height;
  return {
    x,
    y,
    width,
    height,
    centerX: x + width / 2,
    centerY: y + height / 2
  };
}

async function resolveDesktopVisionClickPoint(
  worldState: WorldState | null,
  appName: string,
  box: WeChatVisualComposerBox | null,
  fallback: { x: number; y: number } | null = null
): Promise<{ x: number; y: number } | null> {
  const bounds = await resolveDesktopVisionCandidateBounds(worldState, appName, box);
  if (bounds) {
    return {
      x: bounds.centerX,
      y: bounds.centerY
    };
  }
  if (!fallback) {
    return null;
  }
  const frame = await resolveDesktopVisionFrame(worldState, appName);
  if (!frame) {
    return null;
  }
  return {
    x: Number(frame.x ?? 0) + Number(frame.width ?? 0) * fallback.x,
    y: Number(frame.y ?? 0) + Number(frame.height ?? 0) * fallback.y
  };
}

function buildDesktopPointBounds(
  worldState: WorldState | null,
  appName: string,
  point: { x: number; y: number } | null,
  radius = 18
): InteractionCandidate["bounds"] | null {
  if (!point) {
    return null;
  }
  const frame = findDesktopWindowBounds(worldState, appName);
  if (!frame) {
    return null;
  }
  const centerX = Number(frame.x ?? 0) + Number(frame.width ?? 0) * Number(point.x ?? 0);
  const centerY = Number(frame.y ?? 0) + Number(frame.height ?? 0) * Number(point.y ?? 0);
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) {
    return null;
  }
  return {
    x: centerX - radius,
    y: centerY - radius,
    width: radius * 2,
    height: radius * 2,
    centerX,
    centerY
  };
}

function clampNormalizedUnit(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function isPointWithinNormalizedBox(
  point: { x: number; y: number } | null | undefined,
  box: WeChatVisualComposerBox | null | undefined
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

function deriveOutlookComposerBodyPoint({
  approxBox,
  entryPoint
}: {
  approxBox: WeChatVisualComposerBox | null | undefined;
  entryPoint: { x: number; y: number } | null | undefined;
}): { x: number; y: number } | null {
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

function deriveOutlookComposerVerifyRegionFromVisual(
  composer: { approxBox: WeChatVisualComposerBox | null | undefined; entryPoint: { x: number; y: number } | null | undefined } | null
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
  if (![frameX, frameY, frameWidth, frameHeight, x, y, width, height].every((value) => Number.isFinite(value)) || frameWidth <= 0 || frameHeight <= 0) {
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

function collectDesktopOcrLinesInRegion(
  worldState: WorldState | null,
  appName: string,
  region: { x: number; y: number; width: number; height: number } | null | undefined
): string[] {
  const bounds = resolveDesktopNormalizedRegionBounds(worldState, appName, region);
  if (!bounds) {
    return [];
  }
  return (Array.isArray(worldState?.ocrBlocks) ? worldState.ocrBlocks : [])
    .filter((block) => {
      const centerX = Number(block?.bounds?.centerX ?? NaN);
      const centerY = Number(block?.bounds?.centerY ?? NaN);
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
    .map((block) => String(block?.text ?? "").replace(/\s+/g, " ").trim())
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

function reconcileOutlookVisualDraftState(
  worldState: WorldState | null,
  vision: DesktopVisualAnalysis | null
): DesktopVisualAnalysis | null {
  if (!vision?.composer.present || vision.composer.hasDraftText !== true) {
    return vision;
  }
  if (String(vision.composer.draftPreview ?? "").trim()) {
    return vision;
  }
  const composeVerifyRegion = deriveOutlookComposerVerifyRegionFromVisual(vision.composer);
  const composeLines = collectDesktopOcrLinesInRegion(worldState, "Microsoft Outlook", composeVerifyRegion);
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

function deriveOutlookComposerBodyBounds(
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

function buildDesktopNormalizedRegionFromBounds(
  worldState: WorldState | null,
  appName: string,
  bounds: InteractionCandidate["bounds"] | null | undefined
): { x: number; y: number; width: number; height: number } | null {
  const frame = findDesktopWindowBounds(worldState, appName);
  if (!frame || !bounds) {
    return null;
  }
  const frameX = Number(frame.x ?? NaN);
  const frameY = Number(frame.y ?? NaN);
  const frameWidth = Number(frame.width ?? NaN);
  const frameHeight = Number(frame.height ?? NaN);
  const x = Number(bounds.x ?? NaN);
  const y = Number(bounds.y ?? NaN);
  const width = Number(bounds.width ?? NaN);
  const height = Number(bounds.height ?? NaN);
  if (![frameX, frameY, frameWidth, frameHeight, x, y, width, height].every((value) => Number.isFinite(value)) || frameWidth <= 0 || frameHeight <= 0) {
    return null;
  }
  return {
    x: clampNormalizedUnit((x - frameX) / frameWidth),
    y: clampNormalizedUnit((y - frameY) / frameHeight),
    width: clampNormalizedUnit(width / frameWidth),
    height: clampNormalizedUnit(height / frameHeight)
  };
}

async function summarizeDesktopVisualThreadCandidates(
  worldState: WorldState | null,
  appName: string,
  prefix: string,
  threads: DesktopVisualThreadSummary[]
): Promise<DesktopProbeCandidateSummary[]> {
  const summaries: DesktopProbeCandidateSummary[] = [];
  for (const thread of threads) {
    summaries.push({
      id: `${prefix}-vision-unread`,
      text: thread.name,
      role: "text",
      interactive: true,
      source: "vision",
      score: 100,
      bounds: await resolveDesktopVisionCandidateBounds(worldState, appName, thread.approxBox),
      hints: [
        thread.evidence,
        thread.latestSnippet,
        thread.replyReason,
        `conversation:${thread.conversationKind}`,
        `priority:${thread.priority}`,
        thread.replyable ? "replyable" : "non-replyable",
        thread.shouldReply ? "should-reply" : "skip-reply"
      ].filter(Boolean)
    });
  }
  return summaries;
}

function pickDesktopVisualUnreadThread(vision: DesktopVisualAnalysis | null): DesktopVisualThreadSummary | null {
  if (!vision) {
    return null;
  }

  const eligible = vision.visibleUnreadThreads.filter((thread) => thread.replyable && thread.shouldReply);
  const scored = eligible.slice().sort((left, right) => {
    const priority = (value: DesktopVisualThreadSummary): number => {
      if (value.priority === "high") {
        return 3;
      }
      if (value.priority === "medium") {
        return 2;
      }
      return 1;
    };
    const kind = (value: DesktopVisualThreadSummary): number => {
      if (value.conversationKind === "direct") {
        return 3;
      }
      if (value.conversationKind === "thread" || value.conversationKind === "mail") {
        return 2;
      }
      return 1;
    };
    return priority(right) - priority(left) || kind(right) - kind(left);
  });

  return scored[0] ?? null;
}

function resolveWeChatGroundedOpenPoint(
  bounds: InteractionCandidate["bounds"] | null,
  groundedTarget: WeChatVisualThreadGrounding | null,
  fallbackOpenPoint: { x?: number; y?: number } | null
): { x: number; y: number } | null {
  const normalizedFallbackPoint =
    fallbackOpenPoint
    && Number.isFinite(Number(fallbackOpenPoint.x ?? NaN))
    && Number.isFinite(Number(fallbackOpenPoint.y ?? NaN))
      ? {
          x: Number(fallbackOpenPoint.x),
          y: Number(fallbackOpenPoint.y)
        }
      : null;
  let groundedPoint: { x: number; y: number } | null = null;
  if (bounds && groundedTarget?.targetVisible && groundedTarget.clickPoint) {
    const x = Number(bounds.x ?? 0) + Number(bounds.width ?? 0) * groundedTarget.clickPoint.x;
    const y = Number(bounds.y ?? 0) + Number(bounds.height ?? 0) * groundedTarget.clickPoint.y;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      groundedPoint = { x, y };
    }
  }

  if (!groundedPoint && bounds && groundedTarget?.targetVisible && groundedTarget.rowBox) {
    const box = groundedTarget.rowBox;
    const anchorXNorm = box.x + box.width * 0.5;
    const anchorYNorm = box.y + box.height * 0.5;
    const x = Number(bounds.x ?? 0) + Number(bounds.width ?? 0) * anchorXNorm;
    const y = Number(bounds.y ?? 0) + Number(bounds.height ?? 0) * anchorYNorm;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      groundedPoint = { x, y };
    }
  }

  if (
    groundedPoint
    && normalizedFallbackPoint
    && bounds
    && groundedTarget?.coordinateMode !== "pixel"
  ) {
    const thresholdX = Math.max(Number(bounds.width ?? 0) * 0.08, 48);
    const thresholdY = Math.max(Number(bounds.height ?? 0) * 0.08, 48);
    const dx = Math.abs(groundedPoint.x - normalizedFallbackPoint.x);
    const dy = Math.abs(groundedPoint.y - normalizedFallbackPoint.y);
    if (dx > thresholdX || dy > thresholdY) {
      return normalizedFallbackPoint;
    }
  }

  if (groundedPoint) {
    return groundedPoint;
  }

  if (normalizedFallbackPoint) {
    return normalizedFallbackPoint;
  }

  return null;
}

function buildAbsolutePointBounds(
  point: { x: number; y: number } | null,
  radius = 18
): InteractionCandidate["bounds"] | null {
  if (!point) {
    return null;
  }

  const centerX = Number(point.x ?? NaN);
  const centerY = Number(point.y ?? NaN);
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) {
    return null;
  }

  return {
    x: centerX - radius,
    y: centerY - radius,
    width: radius * 2,
    height: radius * 2,
    centerX,
    centerY
  };
}

function resolveOutlookGroundedOpenPoint(
  bounds: InteractionCandidate["bounds"] | null,
  groundedTarget: WeChatVisualThreadGrounding | null,
  fallbackOpenPoint: { x?: number; y?: number } | null
): { x: number; y: number } | null {
  const normalizedFallbackPoint =
    fallbackOpenPoint
    && Number.isFinite(Number(fallbackOpenPoint.x ?? NaN))
    && Number.isFinite(Number(fallbackOpenPoint.y ?? NaN))
      ? {
          x: Number(fallbackOpenPoint.x),
          y: Number(fallbackOpenPoint.y)
        }
      : null;
  if (!bounds) {
    return normalizedFallbackPoint;
  }

  const rowBox = groundedTarget?.targetVisible ? groundedTarget.rowBox ?? null : null;
  const clickPoint = groundedTarget?.targetVisible ? groundedTarget.clickPoint ?? null : null;
  const normalizedY =
    rowBox
      ? clampUnit(rowBox.y + rowBox.height * 0.5, clickPoint ? clampUnit(clickPoint.y, 0.5) : 0.5)
      : clickPoint
        ? clampUnit(clickPoint.y, 0.5)
        : null;
  const preferredX =
    rowBox
      ? clampUnit(rowBox.x + rowBox.width * 0.72, 0.28)
      : clickPoint
        ? clampUnit(clickPoint.x, 0.28)
        : null;
  const normalizedX = preferredX === null ? null : Math.max(0.24, Math.min(0.34, preferredX));

  if (normalizedX === null || normalizedY === null) {
    return normalizedFallbackPoint;
  }

  const x = Number(bounds.x ?? 0) + Number(bounds.width ?? 0) * normalizedX;
  const y = Number(bounds.y ?? 0) + Number(bounds.height ?? 0) * normalizedY;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return normalizedFallbackPoint;
  }

  return { x, y };
}

function boundsCenter(bounds: InteractionCandidate["bounds"] | null | undefined): { x: number; y: number } | null {
  if (!bounds) {
    return null;
  }
  const centerX = Number(bounds.centerX ?? NaN);
  const centerY = Number(bounds.centerY ?? NaN);
  if (Number.isFinite(centerX) && Number.isFinite(centerY)) {
    return { x: centerX, y: centerY };
  }

  const x = Number(bounds.x ?? NaN);
  const y = Number(bounds.y ?? NaN);
  const width = Number(bounds.width ?? NaN);
  const height = Number(bounds.height ?? NaN);
  if ([x, y, width, height].every((value) => Number.isFinite(value))) {
    return {
      x: x + width / 2,
      y: y + height / 2
    };
  }

  return null;
}

function boundsDiverge(
  primary: InteractionCandidate["bounds"] | null | undefined,
  secondary: InteractionCandidate["bounds"] | null | undefined
): boolean {
  const primaryCenter = boundsCenter(primary);
  const secondaryCenter = boundsCenter(secondary);
  if (!primaryCenter || !secondaryCenter) {
    return false;
  }

  const primaryWidth = Number(primary?.width ?? 0);
  const primaryHeight = Number(primary?.height ?? 0);
  const thresholdX = Math.max(primaryWidth * 0.45, 26);
  const thresholdY = Math.max(primaryHeight * 0.6, 20);
  return (
    Math.abs(primaryCenter.x - secondaryCenter.x) > thresholdX
    || Math.abs(primaryCenter.y - secondaryCenter.y) > thresholdY
  );
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
    "First classify the overall scene as one of: chat_list, thread_open, foreign_view, or unknown.",
    "Use foreign_view for article readers, file previews, browser-like detail pages, minimized group views, official-account browsing views, or any screen where AgentOS should recover back to the chat list before replying.",
    "When the scene is foreign_view or unknown, identify the best visible back or close control that would return to the main chat list.",
    "Focus on the left conversation sidebar for unread rows and the bottom-right composer area for reply input.",
    "Treat red unread count badges, red mention pills such as [@AI], red dots, or red unread markers on a row as unread evidence.",
    "Do not return a standalone red badge number like 33 as the thread name. Always return the conversation title text from the row.",
    "For each unread row, return an approximate normalized bounding box for the full clickable row in the left sidebar.",
    "Unread row boxes must stay inside the left sidebar. Their horizontal center must remain within the left-most 40% of the screenshot.",
    "Do not mark a row as unread from timestamps, snippets, or plain row text alone.",
    "Classify each unread row as threadKind=chat, official_account, service, or unknown.",
    "Set replyable=true only for normal person/group chat rows that AgentOS should answer in the main composer.",
    "Set replyable=false for Official Accounts, article feeds, subscription feeds, payment/service inboxes, or any non-conversational row.",
    "Classify each unread row as conversationKind=direct, group, official_account, service, or unknown.",
    "Set shouldReply=true only when the latest visible snippet clearly needs a reply now.",
    "Set shouldReply=false for large noisy groups, passive updates, link shares, article/news broadcasts, or anything that does not clearly ask for a response.",
    "For group chats, only set shouldReply=true when the latest visible snippet clearly asks a question, requests help, or visibly mentions the user.",
    "Include the latest visible row snippet text and a short replyReason explaining why AgentOS should or should not reply.",
    "Use priority=high only for direct asks or explicit mentions, medium for likely reply-needed chats, and low otherwise.",
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
            scene: {
              type: "string",
              enum: ["chat_list", "thread_open", "foreign_view", "unknown"]
            },
            sceneEvidence: { type: "string" },
            recommendedRecoveryAction: {
              type: "string",
              enum: ["recover_to_list", "complete_signin", "complete_verification", "takeover", "none"]
            },
            recoveryControl: {
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
                  conversationKind: { type: "string", enum: ["direct", "group", "official_account", "service", "unknown"] },
                  shouldReply: { type: "boolean" },
                  replyReason: { type: "string" },
                  latestSnippet: { type: "string" },
                  priority: { type: "string", enum: ["high", "medium", "low"] },
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
                required: [
                  "name",
                  "evidence",
                  "approxSidebarY",
                  "replyable",
                  "threadKind",
                  "conversationKind",
                  "shouldReply",
                  "replyReason",
                  "latestSnippet",
                  "priority",
                  "approxBox"
                ],
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
          required: ["scene", "sceneEvidence", "recommendedRecoveryAction", "recoveryControl", "openThread", "visibleUnreadThreads", "composer"],
          additionalProperties: false
        },
        systemPrompt:
          "You are a strict UI grounding model for AgentOS. First classify the overall WeChat scene as chat_list, thread_open, foreign_view, or unknown. foreign_view means the agent is inside an article reader, file preview, browser-like detail page, minimized groups page, or any non-reply surface that should be recovered back to the chat list. When the scene is foreign_view or unknown, identify the best visible recovery control that would return AgentOS to the main chat list. Then identify the currently open WeChat thread, any clearly visible unread conversation rows in the left sidebar, and the bottom composer area. Only mark a thread as unread when there is visible red badge, red mention tag, red unread count, or red highlight evidence on that row. For each unread row, estimate the clickable row box in normalized screenshot coordinates, classify the conversation, and decide whether AgentOS should reply right now. Return JSON only.",
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

async function analyzeSlackDesktopVisualState({
  modelClient,
  worldState,
  timeoutMs = 20000
}: {
  modelClient: Pick<LivePackControlPlane["modelClient"], "supportsImageJson" | "analyzeImageJson"> | null | undefined;
  worldState: WorldState | null;
  timeoutMs?: number;
}): Promise<DesktopVisualAnalysis | null> {
  if (!modelClient?.supportsImageJson?.()) {
    return null;
  }

  const imagePath = String(worldState?.capture?.path ?? "").trim();
  if (!imagePath) {
    return null;
  }

  const lines = visibleLines(worldState).slice(0, 12);
  const imageSize = await readCaptureImageSize(imagePath);
  const payload = [
    "Analyze this Slack desktop screenshot and return strict JSON only.",
    "Use one of these scenes: list, thread, foreign_view, unknown.",
    "list means the visible Slack conversation list can open an unread reply-worthy DM or channel.",
    "thread means a specific DM or channel is open and the bottom message composer is visible.",
    "foreign_view means modal, settings, profile, file preview, search, or another non-reply surface that should be dismissed.",
    "If recovery is needed, set recommendedRecoveryAction to recover_to_list and return the best visible recoveryControl.",
    "Return only the single best unread reply-worthy thread as bestUnreadThread.",
    "Never return navigation chrome such as Home, DMs, Activity, Files, Later, More, or section headers as bestUnreadThread.",
    "Only include a thread when there is clear unread evidence such as bold styling, mention badge, unread badge, blue dot, or unread count.",
    "Prefer direct messages and explicit mentions over noisy channels.",
    "All approxBox values must be normalized 0..1 relative to the screenshot.",
    lines.length ? `Visible OCR lines:\n${lines.join("\n")}` : "",
    "Keep evidence and snippets short."
  ].filter(Boolean).join("\n\n");

  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    const result = await Promise.race([
      modelClient.analyzeImageJson<Record<string, unknown>>({
        schemaName: "agentos_slack_desktop_visual",
        schema: {
          type: "object",
          properties: {
            scene: { type: "string", enum: ["list", "thread", "foreign_view", "unknown"] },
            sceneEvidence: { type: "string" },
            recommendedRecoveryAction: {
              type: "string",
              enum: ["recover_to_list", "complete_signin", "complete_verification", "takeover", "none"]
            },
            recoveryControl: {
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
            openThread: { type: ["string", "null"] },
            bestUnreadThread: {
              type: "object",
              properties: {
                present: { type: "boolean" },
                name: { type: "string" },
                evidence: { type: "string" },
                replyable: { type: "boolean" },
                conversationKind: { type: "string", enum: ["direct", "channel", "group", "unknown"] },
                shouldReply: { type: "boolean" },
                replyReason: { type: "string" },
                subjectCue: { type: "string" },
                latestSnippet: { type: "string" },
                priority: { type: "string", enum: ["high", "medium", "low"] },
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
              required: [
                "present",
                "name",
                "evidence",
                "replyable",
                "conversationKind",
                "shouldReply",
                "replyReason",
                "subjectCue",
                "latestSnippet",
                "priority",
                "approxBox"
              ],
              additionalProperties: false
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
            }
          },
          required: ["scene", "sceneEvidence", "recommendedRecoveryAction", "recoveryControl", "openThread", "bestUnreadThread", "composer"],
          additionalProperties: false
        },
        systemPrompt:
          "You are a strict UI grounding model for AgentOS. Analyze Slack desktop screenshots for unread conversation selection and recovery. Return JSON only.",
        userPrompt: payload,
        imagePath,
        temperature: 0
      }),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Slack desktop vision analysis timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);

    return normalizeDesktopVisualAnalysis(result, {
      normalizeName: (value) => normalizeSlackSummary(String(value ?? "")),
      imageSize
    });
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

const SLACK_DESKTOP_DETECT_ANALYZE_TIMEOUT_MS = 12000;
const OUTLOOK_DESKTOP_DETECT_ANALYZE_TIMEOUT_MS = 30000;
const DESKTOP_VLM_SCROLL_SCAN_MAX_PASSES = 3;

async function analyzeOutlookDesktopVisualState({
  modelClient,
  worldState,
  timeoutMs = 20000
}: {
  modelClient: Pick<LivePackControlPlane["modelClient"], "supportsImageJson" | "analyzeImageJson"> | null | undefined;
  worldState: WorldState | null;
  timeoutMs?: number;
}): Promise<DesktopVisualAnalysis | null> {
  if (!modelClient?.supportsImageJson?.()) {
    return null;
  }

  const imagePath = String(worldState?.capture?.path ?? "").trim();
  if (!imagePath) {
    return null;
  }

  const lines = visibleLines(worldState).slice(0, 12);
  const imageSize = await readCaptureImageSize(imagePath);
  const payload = [
    "Analyze this Microsoft Outlook desktop screenshot and return strict JSON only.",
    "Use one of these scenes: list, thread, foreign_view, unknown.",
    "list means the visible message list can open an unread reply-worthy message.",
    "thread means a specific email thread or message is open in the reading pane, even if no reply composer is visible yet.",
    "Set composer.present independently. When the thread is open but no inline reply editor is visible, still use scene=thread and composer.present=false.",
    "foreign_view means search results, calendar, settings, folder dialog, attachment preview, modal, or another non-reply surface that should be dismissed.",
    "If recovery is needed, set recommendedRecoveryAction to recover_to_list and return the best visible recoveryControl.",
    "If the current folder is not a reply-worthy Inbox view, and a visible control such as Inbox, Other, Focused, or Load more conversations would recover a better unread list, use recover_to_list and point recoveryControl at that control.",
    "Return only the single best unread reply-worthy message row as bestUnreadThread.",
    "Never return toolbar or mailbox chrome as bestUnreadThread.",
    "Only include a row when there is clear unread evidence such as a blue unread dot, explicit unread badge/count, or unmistakable unread styling.",
    "Do not treat a selected row or reading-pane highlight as unread by itself.",
    "Bold sender or subject alone is not enough if the row appears selected or already open in the reading pane.",
    "Set selectedRow to the sender or short subject/title of the currently highlighted row in the center message list. Use null when the selected row is unclear or the message list is not visible.",
    "Set bestUnreadThread.subjectCue to the short subject or title visible for that unread row. Use an empty string when no distinct subject/title is visible.",
    "Prefer person-to-person email over newsletters and system notifications.",
    "If composer.present is true, approxBox should cover the visible reply composer area and entryPoint should be a single normalized x/y point inside the editable reply body where typing should start.",
    "Do not place composer.entryPoint on the Send button, toolbar, From/To/Subject fields, or quoted original message.",
    "If composer.present is true, set composer.hasDraftText=true only when the editable reply body already contains authored draft text above the quoted original message.",
    "If composer.hasDraftText is true, set composer.draftPreview to a short preview of that authored draft text.",
    "Do not treat the quoted original email, recipient chips, toolbar labels, or signatures as composer draft text.",
    "All approxBox values must be normalized 0..1 relative to the screenshot.",
    lines.length ? `Visible OCR lines:\n${lines.join("\n")}` : "",
    "Keep evidence and snippets short."
  ].filter(Boolean).join("\n\n");

  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    const result = await Promise.race([
      modelClient.analyzeImageJson<Record<string, unknown>>({
        schemaName: "agentos_outlook_desktop_visual",
        schema: {
          type: "object",
          properties: {
            scene: { type: "string", enum: ["list", "thread", "foreign_view", "unknown"] },
            sceneEvidence: { type: "string" },
            recommendedRecoveryAction: {
              type: "string",
              enum: ["recover_to_list", "complete_signin", "complete_verification", "takeover", "none"]
            },
            recoveryControl: {
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
            openThread: { type: ["string", "null"] },
            selectedRow: { type: ["string", "null"] },
            bestUnreadThread: {
              type: "object",
              properties: {
                present: { type: "boolean" },
                name: { type: "string" },
                evidence: { type: "string" },
                replyable: { type: "boolean" },
                conversationKind: { type: "string", enum: ["mail", "newsletter", "system", "unknown"] },
                shouldReply: { type: "boolean" },
                replyReason: { type: "string" },
                subjectCue: { type: "string" },
                latestSnippet: { type: "string" },
                priority: { type: "string", enum: ["high", "medium", "low"] },
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
              required: [
                "present",
                "name",
                "evidence",
                "replyable",
                "conversationKind",
                "shouldReply",
                "replyReason",
                "subjectCue",
                "latestSnippet",
                "priority",
                "approxBox"
              ],
              additionalProperties: false
            },
            composer: {
              type: "object",
              properties: {
                present: { type: "boolean" },
                evidence: { type: "string" },
                hasDraftText: { type: ["boolean", "null"] },
                draftPreview: { type: ["string", "null"] },
                entryPoint: {
                  type: ["object", "null"],
                  properties: {
                    x: { type: "number" },
                    y: { type: "number" }
                  },
                  required: ["x", "y"],
                  additionalProperties: false
                },
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
              required: ["present", "evidence", "hasDraftText", "draftPreview", "approxBox"],
              additionalProperties: false
            }
          },
          required: ["scene", "sceneEvidence", "recommendedRecoveryAction", "recoveryControl", "openThread", "selectedRow", "bestUnreadThread", "composer"],
          additionalProperties: false
        },
        systemPrompt:
          "You are a strict UI grounding model for AgentOS. Analyze Outlook desktop screenshots for unread message selection and recovery. Return JSON only.",
        userPrompt: payload,
        imagePath,
        temperature: 0
      }),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Outlook desktop vision analysis timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);

    return normalizeDesktopVisualAnalysis(result, {
      normalizeName: (value) => normalizeMailSummary(String(value ?? "")),
      imageSize
    });
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

const OUTLOOK_INBOX_RECOVERY_PATTERN = /\binbox\b/iu;
const OUTLOOK_NON_INBOX_FOLDER_PATTERN = /\b(deleted items|junk email|archive|sent|drafts)\b/iu;

function hasOutlookInboxRecoveryHint(lines: string[]) {
  return lines.some((line) => OUTLOOK_INBOX_RECOVERY_PATTERN.test(line)) &&
    lines.some((line) => OUTLOOK_NON_INBOX_FOLDER_PATTERN.test(line));
}

function findOutlookInboxRecoveryPoint(worldState: WorldState | null): { x: number; y: number } | null {
  const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
  const ocrBlocks = Array.isArray(worldState?.ocrBlocks) ? worldState.ocrBlocks : [];
  const windowBounds = findDesktopWindowBounds(worldState, "Microsoft Outlook");
  const maxSidebarX = windowBounds
    ? windowBounds.x + windowBounds.width * 0.38
    : Number.POSITIVE_INFINITY;
  const ranked = [
    ...candidates.map((candidate) => ({
      text: String(candidate?.text ?? "").trim(),
      bounds: candidate?.bounds ?? null,
      score: (candidate?.isInteractive ? 10 : 0) + (candidate?.role === "button" ? 5 : 0)
    })),
    ...ocrBlocks.map((block) => ({
      text: String(block?.text ?? "").trim(),
      bounds: (block?.bounds ?? null) as InteractionCandidate["bounds"] | null,
      score: 3
    }))
  ]
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
  const match = ranked[0];
  if (!match?.bounds || !Number.isFinite(Number(match.bounds.centerX)) || !Number.isFinite(Number(match.bounds.centerY))) {
    return null;
  }
  return {
    x: Number(match.bounds.centerX),
    y: Number(match.bounds.centerY)
  };
}

async function groundOutlookDesktopRecoveryPoint({
  modelClient,
  worldState,
  timeoutMs = 25000
}: {
  modelClient: Pick<LivePackControlPlane["modelClient"], "supportsImageJson" | "analyzeImageJson"> | null | undefined;
  worldState: WorldState | null;
  timeoutMs?: number;
}): Promise<{ x: number; y: number } | null> {
  if (!modelClient?.supportsImageJson?.()) {
    return null;
  }

  const imagePath = String(worldState?.capture?.path ?? "").trim();
  if (!imagePath) {
    return null;
  }

  const lines = visibleLines(worldState).slice(0, 24);
  const imageSize = await readCaptureImageSize(imagePath);
  const hasLoadMoreConversations = lines.some((line) => /load more conversations/iu.test(line));
  const hasInboxRecoveryHint = hasOutlookInboxRecoveryHint(lines);
  const appContext = (worldState?.appContext ?? null) as Record<string, unknown> | null;
  const captureWindowNumber = Number(appContext?.captureWindowNumber ?? NaN);
  const rawInboxFallbackPoint = findOutlookInboxRecoveryPoint(worldState);
  const inboxFallbackPoint = hasInboxRecoveryHint
    ? Number.isFinite(captureWindowNumber)
      ? await resolveDesktopObservedPoint(worldState, "Microsoft Outlook", rawInboxFallbackPoint)
      : rawInboxFallbackPoint
    : null;
  if (hasInboxRecoveryHint && inboxFallbackPoint) {
    return inboxFallbackPoint;
  }
  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    const result = await Promise.race([
      modelClient.analyzeImageJson<Record<string, unknown>>({
        schemaName: "agentos_outlook_desktop_recovery_control",
        schema: {
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
        systemPrompt:
          hasInboxRecoveryHint
            ? "You are a strict Outlook desktop grounding model for AgentOS. The current screenshot is on a non-Inbox folder or list while a visible Inbox row should be used to recover before scanning unread mail. Ground the Inbox row exactly unless it is clearly absent. Do not choose Load more conversations while a visible Inbox recovery row is present. Only if Inbox is not actually visible may you fall back to Other tab, Focused tab, Load more conversations, or another mailbox row that would expose unread mail. Return JSON only."
            : hasLoadMoreConversations
            ? "You are a strict Outlook desktop grounding model for AgentOS. The current screenshot shows an empty or filtered message list and a visible 'Load more conversations' control. Ground that control exactly unless it is clearly absent. Only if it is not actually visible may you fall back to Other tab, Focused tab, a visible Inbox row with unread count, or another mailbox row that would expose unread mail. Return JSON only."
            : hasInboxRecoveryHint
              ? "You are a strict Outlook desktop grounding model for AgentOS. The current screenshot is not on the best reply-worthy folder and a visible Inbox row should be used to recover before scanning unread mail. Ground the Inbox row exactly unless it is clearly absent. Only if Inbox is not actually visible may you fall back to Other tab, Focused tab, Load more conversations, or another mailbox row that would expose unread mail. Return JSON only."
              : "You are a strict Outlook desktop grounding model for AgentOS. Identify the single visible control that would most likely reveal unread reply-worthy mail from the current screenshot. Prefer, in order: Other tab, Focused tab, Load more conversations, a visible Inbox row with unread count, or a mailbox row that would expose unread mail. Return JSON only.",
        userPrompt: [
          "Ground the best visible Outlook recovery control.",
          "Return a normalized approxBox from 0 to 1 relative to the screenshot.",
          "Do not return toolbar buttons, search, or the message pane.",
          hasInboxRecoveryHint ? "If a visible Inbox row would recover from Deleted Items, Junk Email, Archive, Sent, or Drafts, return the Inbox row." : "",
          hasLoadMoreConversations ? "If 'Load more conversations' is visible and no Inbox recovery row is needed, return that control." : "",
          lines.length ? `Visible OCR lines:\n${lines.join("\n")}` : ""
        ].filter(Boolean).join("\n\n"),
        imagePath,
        temperature: 0
      }),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Outlook recovery grounding timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);

    const box = normalizeVisionBox(
      ((result.approxBox ?? null) as Record<string, unknown> | null),
      imageSize
    );
    if (!result.present || !box) {
      return inboxFallbackPoint;
    }
    const groundedPoint = await resolveDesktopVisionClickPoint(worldState, "Microsoft Outlook", box);
    if (hasInboxRecoveryHint && inboxFallbackPoint && groundedPoint) {
      const frame = await resolveDesktopVisionFrame(worldState, "Microsoft Outlook");
      const sidebarLimit = frame
        ? Number(frame.x ?? 0) + Number(frame.width ?? 0) * 0.35
        : Number.POSITIVE_INFINITY;
      if (!Number.isFinite(Number(groundedPoint.x)) || Number(groundedPoint.x) >= sidebarLimit) {
        return inboxFallbackPoint;
      }
    }
    return groundedPoint ?? inboxFallbackPoint;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function groundDesktopVisualDismissPoint({
  modelClient,
  worldState,
  appName,
  capturePath,
  captureBounds,
  captureIsModal = false,
  timeoutMs = 25000
}: {
  modelClient: Pick<LivePackControlPlane["modelClient"], "supportsImageJson" | "analyzeImageJson"> | null | undefined;
  worldState: WorldState | null;
  appName: string;
  capturePath?: string | null;
  captureBounds?: InteractionCandidate["bounds"] | null;
  captureIsModal?: boolean;
  timeoutMs?: number;
}): Promise<{ x: number; y: number } | null> {
  if (!modelClient?.supportsImageJson?.()) {
    return null;
  }

  const imagePath = String(capturePath ?? worldState?.capture?.path ?? "").trim();
  if (!imagePath) {
    return null;
  }

  const imageSize = await readCaptureImageSize(imagePath);
  if (!imageSize) {
    return null;
  }

  const modalScopedCapture = captureIsModal && captureBounds
    ? imageLikelyMatchesWindowBounds(imageSize, captureBounds)
    : false;

  if (modalScopedCapture) {
    const frameBounds = captureBounds;
    if (!frameBounds) {
      return null;
    }
    const lines = visibleLines(worldState).slice(0, 20);
    let timeoutHandle: NodeJS.Timeout | null = null;
    try {
      const result = await Promise.race([
        modelClient.analyzeImageJson<Record<string, unknown>>({
          schemaName: "agentos_desktop_modal_dismiss_control",
          schema: {
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
          systemPrompt:
            `You are a strict desktop UI grounding model for AgentOS. This screenshot contains only a blocking ${appName} modal window. Identify the single visible control that would dismiss it and return JSON only.`,
          userPrompt: [
            `Analyze this ${appName} modal-window screenshot.`,
            "Return the single best visible dismiss control that would close the modal or overlay.",
            "Prefer, in order: Cancel, Close, Done, Back, Not now, Skip, or a visible X close button.",
            "Do not return the list body, search field, or any control that keeps the modal open.",
            "Return a normalized approxBox from 0 to 1 relative to the screenshot.",
            lines.length ? `Visible OCR lines from the surrounding UI:\n${lines.join("\n")}` : ""
          ].filter(Boolean).join("\n\n"),
          imagePath,
          temperature: 0
        }),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`${appName} modal dismiss grounding timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        })
      ]);

      const box = normalizeVisionBox(
        ((result.approxBox ?? null) as Record<string, unknown> | null),
        imageSize
      );
      if (!result.present || !box) {
        return null;
      }
      return resolveDesktopVisionBoxPoint({
        bounds: frameBounds,
        box
      });
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  const modalBounds = findBlockingDesktopModalWindowBounds(worldState, appName);
  if (!modalBounds) {
    return null;
  }

  const frameBounds = await resolveDesktopVisionFrame(worldState, appName) ?? captureBounds ?? null;
  if (!frameBounds) {
    return null;
  }

  const frameWidth = Number(frameBounds.width ?? 0);
  const frameHeight = Number(frameBounds.height ?? 0);
  if (!(frameWidth > 0 && frameHeight > 0)) {
    return null;
  }

  const modalNormalized = {
    x: Math.max(0, Math.min(1, (Number(modalBounds.x ?? 0) - Number(frameBounds.x ?? 0)) / frameWidth)),
    y: Math.max(0, Math.min(1, (Number(modalBounds.y ?? 0) - Number(frameBounds.y ?? 0)) / frameHeight)),
    width: Math.max(0.01, Math.min(1, Number(modalBounds.width ?? 0) / frameWidth)),
    height: Math.max(0.01, Math.min(1, Number(modalBounds.height ?? 0) / frameHeight))
  };
  if (modalNormalized.x + modalNormalized.width > 1) {
    modalNormalized.width = Math.max(0.01, 1 - modalNormalized.x);
  }
  if (modalNormalized.y + modalNormalized.height > 1) {
    modalNormalized.height = Math.max(0.01, 1 - modalNormalized.y);
  }

  const lines = visibleLines(worldState).slice(0, 20);
  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    const result = await Promise.race([
      modelClient.analyzeImageJson<Record<string, unknown>>({
        schemaName: "agentos_desktop_modal_dismiss_control",
        schema: {
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
        systemPrompt:
          `You are a strict desktop UI grounding model for AgentOS. Identify the single visible control that would dismiss the current ${appName} modal or foreign overlay and return JSON only.`,
        userPrompt: [
          `Analyze this ${appName} desktop screenshot.`,
          "A blocking modal window is visible inside the app.",
          `The modal occupies screenshot-normalized bounds x=${modalNormalized.x.toFixed(4)}, y=${modalNormalized.y.toFixed(4)}, width=${modalNormalized.width.toFixed(4)}, height=${modalNormalized.height.toFixed(4)}.`,
          "Ignore everything outside that modal window.",
          "Return the single best visible dismiss control that would close that modal or overlay.",
          "Prefer, in order: Cancel, Close, Done, Back, Not now, Skip, or a visible X close button.",
          "Do not return the underlying list, inbox, sidebar, toolbar, or main thread area.",
          "Return a normalized approxBox from 0 to 1 relative to the full screenshot.",
          "The returned control must still lie inside the modal window bounds given above.",
          lines.length ? `Visible OCR lines:\n${lines.join("\n")}` : ""
        ].filter(Boolean).join("\n\n"),
        imagePath,
        temperature: 0
      }),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`${appName} modal dismiss grounding timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);

    const box = normalizeVisionBox(
      ((result.approxBox ?? null) as Record<string, unknown> | null),
      imageSize
    );
    if (!result.present || !box) {
      return null;
    }
    return resolveDesktopVisionBoxPoint({
      bounds: frameBounds,
      box
    });
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function recoverOutlookInboxWithoutVision({
  rule,
  workspace,
  surfaceRegistry,
  worldState,
  analyzeState
}: LivePackDetectionArgs & {
  worldState: WorldState | null;
  analyzeState: (worldState: WorldState | null) => Promise<DesktopVisualAnalysis | null>;
}): Promise<{
  worldState: WorldState | null;
  vision: DesktopVisualAnalysis | null;
  recoveryAttempts: number;
}> {
  const recoveryPoint = findOutlookInboxRecoveryPoint(worldState);
  const adapter = surfaceRegistry.get("desktop");
  if (
    !recoveryPoint
    || !adapter
    || typeof (adapter as { act?: unknown }).act !== "function"
    || typeof (adapter as { observe?: unknown }).observe !== "function"
  ) {
    return {
      worldState,
      vision: null,
      recoveryAttempts: 0
    };
  }

  const watchTask = createWatchTask(rule);
  const watchWorkspace = profileAsWorkspace(rule, workspace);
  const act = (adapter as { act: (args: unknown) => Promise<unknown> }).act.bind(adapter);
  const observe = (adapter as { observe: (args: unknown) => Promise<WorldState> }).observe.bind(adapter);
  let currentState = worldState;
  let currentVision: DesktopVisualAnalysis | null = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const previousSignature = buildWorldStateFingerprint(currentState);
    await act({
      task: watchTask,
      workspace: watchWorkspace,
      traceId: null,
      outputs: {},
      step: {
        id: `watch-outlook-inbox-fallback-${rule.id}-${attempt}`,
        label: "Recover Outlook to inbox list",
        surface: "desktop",
        action: "clickAt",
        params: recoveryPoint,
        checkpoint: false
      }
    } as never).catch(() => null);

    await act({
      task: watchTask,
      workspace: watchWorkspace,
      traceId: null,
      outputs: {},
      step: {
        id: `watch-outlook-inbox-fallback-wait-${rule.id}-${attempt}`,
        label: "Wait for Outlook recovery",
        surface: "desktop",
        action: "wait",
        params: { ms: 500 },
        checkpoint: false
      }
    } as never).catch(() => null);

    currentState = await observe({
      task: watchTask,
      workspace: watchWorkspace,
      traceId: null,
      label: `watch-outlook-inbox-fallback-${attempt}`,
      targetAppName: rule.appTarget ?? "Microsoft Outlook"
    } as never).catch(() => currentState);
    if (!isExpectedDesktopForeground(currentState, rule.appTarget ?? "Microsoft Outlook")) {
      break;
    }
    currentVision = await analyzeState(currentState).catch(() => null);

    const currentSignature = buildWorldStateFingerprint(currentState);
    if (
      pickDesktopVisualUnreadThread(currentVision)
      || findOutlookComposeCandidate(currentState)
      || findOutlookUnreadCandidate(currentState)
      || currentSignature !== previousSignature
    ) {
      return {
        worldState: currentState,
        vision: currentVision,
        recoveryAttempts: attempt
      };
    }
  }

  return {
    worldState: currentState,
    vision: currentVision,
    recoveryAttempts: 2
  };
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
    "Return clickPoint and rowBox in normalized screenshot coordinates from 0 to 1, not pixels.",
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

    return normalizeWeChatGroundingWithImageSize(
      normalizeWeChatVisualThreadGrounding((result as Record<string, unknown> | null) ?? null),
      await readCaptureImageSize(imagePath)
    );
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function groundOutlookTargetThreadClickPoint({
  modelClient,
  worldState,
  targetThread,
  targetSnippet = null,
  timeoutMs = 12000
}: {
  modelClient: Pick<LivePackControlPlane["modelClient"], "supportsImageJson" | "analyzeImageJson"> | null | undefined;
  worldState: WorldState | null;
  targetThread: string;
  targetSnippet?: string | null;
  timeoutMs?: number;
}): Promise<WeChatVisualThreadGrounding | null> {
  if (!modelClient?.supportsImageJson?.()) {
    return null;
  }

  const imagePath = String(worldState?.capture?.path ?? "").trim();
  const target = normalizeMailSummary(String(targetThread ?? "").trim());
  const snippet = String(targetSnippet ?? "").trim();
  if (!imagePath || !target) {
    return null;
  }

  const lines = visibleLines(worldState).slice(0, 24);
  const payload = [
    "Analyze this Outlook desktop screenshot and ground the target conversation row in the center message list.",
    "Return a click point that safely selects the target row inside the message list, not the sidebar folder list, search field, toolbar, calendar pane, or reading pane.",
    "Return clickPoint and rowBox in normalized screenshot coordinates from 0 to 1, not pixels.",
    "If Outlook is currently showing a different open message on the right, still ground the target unread row in the center list.",
    `Target thread: ${target}`,
    snippet ? `Target preview snippet or subject cue: ${snippet}` : "",
    snippet ? "If multiple rows share the same sender name, use the preview snippet or subject cue to choose the correct one." : "",
    lines.length ? `Visible OCR lines:\n${lines.join("\n")}` : "",
    "Return strict JSON."
  ]
    .filter(Boolean)
    .join("\n\n");

  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    const result = await Promise.race([
      modelClient.analyzeImageJson<Record<string, unknown>>({
        schemaName: "agentos_outlook_thread_grounding",
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
          "You are a strict UI grounding model for AgentOS. Find the target Outlook conversation row in the center message list and return JSON only.",
        userPrompt: payload,
        imagePath,
        temperature: 0
      }),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Outlook thread grounding timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);

    return normalizeWeChatGroundingWithImageSize(
      normalizeWeChatVisualThreadGrounding((result as Record<string, unknown> | null) ?? null),
      await readCaptureImageSize(imagePath)
    );
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function isOutlookThreadOpenForTarget(
  vision: DesktopVisualAnalysis | null,
  targetThread: string,
  targetCue: string | null = null
): boolean {
  return didOutlookThreadSelectionAdvance({ vision, targetThread, targetCue });
}

function didOutlookThreadSelectionAdvance({
  vision,
  targetThread,
  targetCue = null,
  previousOpenThread = null
}: {
  vision: DesktopVisualAnalysis | null;
  targetThread: string;
  targetCue?: string | null;
  previousOpenThread?: string | null;
}): boolean {
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

function didOutlookThreadSelectionAdvanceFromState({
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
  if (!worldState || !isOutlookDesktopForeground(worldState)) {
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

function isOutlookTargetUnreadStillVisible(
  vision: DesktopVisualAnalysis | null,
  targetThread: string,
  targetCue: string | null = null
): boolean {
  if (!vision) {
    return false;
  }

  const normalizedTarget = normalizeMailSummary(targetThread);
  const normalizedCue = normalizeMailSummary(String(targetCue ?? ""));
  return vision.visibleUnreadThreads.some((thread) => {
    const threadName = normalizeMailSummary(String(thread.name ?? ""));
    const threadSubjectCue = normalizeMailSummary(String(thread.subjectCue ?? ""));
    return (
      mailSummariesMatch(threadName, normalizedTarget)
      || mailSummariesMatch(threadName, normalizedCue)
      || mailSummariesMatch(threadSubjectCue, normalizedCue)
    );
  });
}

function findMatchingOutlookVisibleThread(
  vision: DesktopVisualAnalysis | null,
  targetThread: string,
  targetCue: string | null = null
): DesktopVisualThreadSummary | null {
  if (!vision) {
    return null;
  }

  const normalizedTarget = normalizeMailSummary(targetThread);
  const normalizedCue = normalizeMailSummary(String(targetCue ?? ""));
  for (const thread of vision.visibleUnreadThreads) {
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

function traceOutlookThreadState(
  stage: string,
  {
    vision,
    targetThread,
    targetCue,
    previousOpenThread,
    openAttempts
  }: {
    vision: DesktopVisualAnalysis | null;
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

function traceOutlookAnalysisError(stage: string, error: unknown): void {
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

async function groundOutlookReplyControl({
  modelClient,
  worldState,
  timeoutMs = 12000
}: {
  modelClient: Pick<LivePackControlPlane["modelClient"], "supportsImageJson" | "analyzeImageJson"> | null | undefined;
  worldState: WorldState | null;
  timeoutMs?: number;
}): Promise<InteractionCandidate | null> {
  if (!modelClient?.supportsImageJson?.()) {
    return null;
  }

  const imagePath = String(worldState?.capture?.path ?? "").trim();
  if (!imagePath) {
    return null;
  }

  const lines = visibleLines(worldState).slice(0, 24);
  const imageSize = await readCaptureImageSize(imagePath);
  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    const result = await Promise.race([
      modelClient.analyzeImageJson<Record<string, unknown>>({
        schemaName: "agentos_outlook_reply_control",
        schema: {
          type: "object",
          properties: {
            present: { type: "boolean" },
            evidence: { type: "string" },
            label: { type: "string" },
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
          required: ["present", "evidence", "label", "approxBox"],
          additionalProperties: false
        },
        systemPrompt:
          "You are a strict Outlook desktop grounding model for AgentOS. The screenshot shows an open email thread without a visible reply composer. Identify the single visible control that would open the reply composer. Prefer Reply over Reply All or Forward. Return JSON only.",
        userPrompt: [
          "Analyze this Outlook desktop screenshot.",
          "Ground the single visible control that would open a reply composer for the currently open email thread.",
          "Prefer Reply over Reply All and Forward unless Reply is clearly absent.",
          "Do not return the message list, sidebar, search box, toolbar chrome, or the message body itself.",
          "Return a normalized approxBox from 0 to 1 relative to the screenshot.",
          lines.length ? `Visible OCR lines:\n${lines.join("\n")}` : ""
        ].filter(Boolean).join("\n\n"),
        imagePath,
        temperature: 0
      }),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Outlook reply control grounding timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);

    const box = normalizeVisionBox(
      ((result.approxBox ?? null) as Record<string, unknown> | null),
      imageSize
    );
    if (!result.present || !box) {
      return null;
    }
    const bounds = await resolveDesktopVisionCandidateBounds(worldState, "Microsoft Outlook", box);
    if (!bounds) {
      return null;
    }
    return {
      id: "outlook-vision-reply-control",
      surface: "desktop",
      kind: "element",
      text: String(result.label ?? result.evidence ?? "Reply").trim() || "Reply",
      role: "button",
      confidence: 0.99,
      sourceHints: {
        source: "vision",
        evidence: String(result.evidence ?? "").trim()
      },
      isInteractive: true,
      bounds
    } satisfies InteractionCandidate;
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
  thread: WeChatVisualThreadSummary | null;
} | null {
  if (!analysis?.visibleUnreadThreads?.length) {
    return null;
  }

  const eligibleThreads = analysis.visibleUnreadThreads
    .filter((thread) => weChatThreadNeedsReply(thread))
    .sort(compareWeChatThreadPriority);

  for (const thread of eligibleThreads) {
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
        openPoint: { x, y },
        thread
      };
    }

    return {
      candidate: null,
      openTarget,
      openPoint: null,
      thread
    };
  }

  return null;
}

function imageLikelyMatchesWindowBounds(
  imageSize: VisionImageSize | null,
  bounds: InteractionCandidate["bounds"] | null
): boolean {
  if (!imageSize || !bounds) {
    return false;
  }

  const width = Number(bounds.width ?? 0);
  const height = Number(bounds.height ?? 0);
  if (!(width > 0 && height > 0)) {
    return false;
  }

  const scaleX = Number(imageSize.width) / width;
  const scaleY = Number(imageSize.height) / height;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
    return false;
  }

  const largerScale = Math.max(scaleX, scaleY);
  const smallerScale = Math.min(scaleX, scaleY);
  if (!(largerScale > 0 && smallerScale > 0)) {
    return false;
  }

  return (largerScale - smallerScale) / largerScale <= 0.12;
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

function isDesktopRecoveryScene(vision: DesktopVisualAnalysis | WeChatVisualAnalysis | null): boolean {
  if (!vision) {
    return false;
  }
  if (vision.scene === "foreign_view") {
    return true;
  }

  if (vision.recommendedRecoveryAction !== "recover_to_list") {
    return false;
  }

  return !pickDesktopVisualUnreadThread(vision) || Boolean(vision.composer?.present);
}

function resolveDesktopVisionBoxPoint({
  bounds,
  box,
  anchorX = 0.5,
  anchorY = 0.5
}: {
  bounds: InteractionCandidate["bounds"] | null;
  box: WeChatVisualComposerBox | null | undefined;
  anchorX?: number;
  anchorY?: number;
}): { x: number; y: number } | null {
  if (!bounds || !box) {
    return null;
  }

  const x = Number(bounds.x ?? 0) + Number(bounds.width ?? 0) * (box.x + box.width * anchorX);
  const y = Number(bounds.y ?? 0) + Number(bounds.height ?? 0) * (box.y + box.height * anchorY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  return { x, y };
}

function isWeChatRecoveryScene(vision: WeChatVisualAnalysis | null): boolean {
  return isDesktopRecoveryScene(vision);
}

function resolveWeChatVisionBoxPoint(args: {
  bounds: InteractionCandidate["bounds"] | null;
  box: WeChatVisualComposerBox | null | undefined;
  anchorX?: number;
  anchorY?: number;
}): { x: number; y: number } | null {
  return resolveDesktopVisionBoxPoint(args);
}

function deriveWeChatConversationListPoint(worldState: WorldState | null): { x: number; y: number } | null {
  const windowBounds = findDesktopWindowBounds(worldState, "WeChat");
  if (windowBounds) {
    return {
      x: Math.round(Number(windowBounds.x ?? 0) + Number(windowBounds.width ?? 0) * 0.22),
      y: Math.round(Number(windowBounds.y ?? 0) + Number(windowBounds.height ?? 0) * 0.3)
    };
  }

  return null;
}

function deriveDesktopListPoint(
  worldState: WorldState | null,
  appName: string,
  anchor: { x: number; y: number }
): { x: number; y: number } | null {
  const windowBounds = findDesktopWindowBounds(worldState, appName);
  if (!windowBounds) {
    return null;
  }

  return {
    x: Math.round(Number(windowBounds.x ?? 0) + Number(windowBounds.width ?? 0) * anchor.x),
    y: Math.round(Number(windowBounds.y ?? 0) + Number(windowBounds.height ?? 0) * anchor.y)
  };
}

function findBlockingDesktopModalWindowBounds(
  worldState: WorldState | null,
  appName: string
): InteractionCandidate["bounds"] | null {
  return (findBlockingDesktopModalWindow(worldState, appName)?.bounds ?? null) as InteractionCandidate["bounds"] | null;
}

function findBlockingDesktopModalWindow(
  worldState: WorldState | null,
  appName: string
): Record<string, unknown> | null {
  const appContext = worldState?.appContext;
  const windows = Array.isArray(appContext?.windows) ? appContext.windows : [];
  const normalizedApp = String(appName ?? "").trim().toLowerCase();
  const appWindows = windows.filter((window) => String(window?.ownerName ?? "").trim().toLowerCase() === normalizedApp);
  if (appWindows.length < 2) {
    return null;
  }

  const captureWindowNumber = Number(appContext?.captureWindowNumber ?? NaN);
  const mainWindow =
    appWindows.find((window) => Number(window?.windowNumber ?? NaN) === captureWindowNumber)
    ?? appWindows.reduce<typeof appWindows[number] | null>((current, candidate) => {
      if (!candidate) {
        return current;
      }
      const area = Number(candidate?.bounds?.width ?? 0) * Number(candidate?.bounds?.height ?? 0);
      const currentArea = current ? Number(current?.bounds?.width ?? 0) * Number(current?.bounds?.height ?? 0) : -1;
      return area > currentArea ? candidate : current;
    }, null);

  if (!mainWindow) {
    return null;
  }

  const mainBounds = mainWindow.bounds;
  const mainArea = Number(mainBounds?.width ?? 0) * Number(mainBounds?.height ?? 0);
  if (!Number.isFinite(mainArea) || mainArea <= 0) {
    return null;
  }

  const modalWindow = appWindows.find((window) => {
    if (!window || window === mainWindow) {
      return false;
    }
    const bounds = window.bounds;
    const area = Number(bounds?.width ?? 0) * Number(bounds?.height ?? 0);
    if (!Number.isFinite(area) || area <= 0 || area >= mainArea * 0.8 || area <= mainArea * 0.02) {
      return false;
    }
    const centerX = Number(bounds?.centerX ?? 0);
    const centerY = Number(bounds?.centerY ?? 0);
    const withinMain =
      centerX >= Number(mainBounds?.x ?? 0) &&
      centerX <= Number(mainBounds?.x ?? 0) + Number(mainBounds?.width ?? 0) &&
      centerY >= Number(mainBounds?.y ?? 0) &&
      centerY <= Number(mainBounds?.y ?? 0) + Number(mainBounds?.height ?? 0);
    return withinMain;
  });
  return (modalWindow ?? null) as Record<string, unknown> | null;
}

function hasBlockingDesktopModalWindow(worldState: WorldState | null, appName: string): boolean {
  return Boolean(findBlockingDesktopModalWindow(worldState, appName));
}

async function captureDesktopWindowForVision({
  rule,
  workspace,
  surfaceRegistry,
  appName,
  label,
  windowNumber
}: LivePackActivationArgs & {
  appName: string;
  label: string;
  windowNumber: number | null;
}): Promise<string | null> {
  if (!(Number.isFinite(windowNumber) && Number(windowNumber) > 0)) {
    return null;
  }

  const adapter = surfaceRegistry.get("desktop");
  if (!adapter || typeof (adapter as { capture?: unknown }).capture !== "function") {
    return null;
  }

  const artifact = await ((adapter as unknown) as {
    capture: (args: {
      task: TaskRecord;
      workspace: WorkspaceRecord;
      traceId: string | null;
      label: string;
      windowNumber: number;
      targetAppName: string;
    }) => Promise<{ path?: string; metadata?: Record<string, unknown> } | null>;
  }).capture({
    task: createWatchTask(rule),
    workspace: profileAsWorkspace(rule, workspace),
    traceId: null,
    label,
    windowNumber: Number(windowNumber),
    targetAppName: rule.appTarget ?? appName
  }).catch(() => null);

  const actualWindowNumber = Number((artifact?.metadata ?? {}).windowNumber ?? NaN);
  if (!Number.isFinite(actualWindowNumber) || actualWindowNumber !== Number(windowNumber)) {
    return null;
  }

  const imagePath = String(artifact?.path ?? "").trim();
  return imagePath || null;
}

async function scanDesktopVisionUnreadConversation({
  rule,
  workspace,
  surfaceRegistry,
  initialWorldState,
  initialVision,
  appName,
  anchor,
  scrollDy,
  analyzeState,
  maxPasses = 4
}: LivePackDetectionArgs & {
  initialWorldState: WorldState | null;
  initialVision: DesktopVisualAnalysis | null;
  appName: string;
  anchor: { x: number; y: number };
  scrollDy: number;
  analyzeState: (worldState: WorldState | null) => Promise<DesktopVisualAnalysis | null>;
  maxPasses?: number;
}): Promise<{
  worldState: WorldState | null;
  vision: DesktopVisualAnalysis | null;
  thread: DesktopVisualThreadSummary | null;
  scrollPasses: number;
}> {
  const initialThread = pickDesktopVisualUnreadThread(initialVision);
  if (initialThread) {
    return {
      worldState: initialWorldState,
      vision: initialVision,
      thread: initialThread,
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
      worldState: initialWorldState,
      vision: initialVision,
      thread: null,
      scrollPasses: 0
    };
  }

  const watchTask = createWatchTask(rule);
  const watchWorkspace = profileAsWorkspace(rule, workspace);
  const act = (adapter as { act: (args: unknown) => Promise<unknown> }).act.bind(adapter);
  const observe = (adapter as { observe: (args: unknown) => Promise<WorldState> }).observe.bind(adapter);
  const seenStates = new Set<string>();
  let currentState = initialWorldState;
  let currentVision = initialVision;

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const signature = buildWorldStateFingerprint(currentState);
    if (seenStates.has(signature)) {
      break;
    }
    seenStates.add(signature);

    const listPoint = deriveDesktopListPoint(currentState, appName, anchor);
    if (!listPoint) {
      break;
    }

    await act({
      task: watchTask,
      workspace: watchWorkspace,
      traceId: null,
      outputs: {},
      step: {
        id: `watch-${rule.id}-${appName.toLowerCase()}-list-focus-${pass}`,
        label: `Focus ${appName} list`,
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
        id: `watch-${rule.id}-${appName.toLowerCase()}-list-scroll-${pass}`,
        label: `Scroll ${appName} list`,
        surface: "desktop",
        action: "scroll",
        params: { dx: 0, dy: scrollDy },
        checkpoint: false
      }
    } as never).catch(() => null);

    currentState = await observe({
      task: watchTask,
      workspace: watchWorkspace,
      traceId: null,
      label: `watch-${rule.id}-${appName.toLowerCase()}-scroll-${pass}`,
      targetAppName: rule.appTarget ?? appName
    } as never).catch(() => currentState);
    if (!isExpectedDesktopForeground(currentState, rule.appTarget ?? appName)) {
      currentVision = null;
      break;
    }
    currentVision = await analyzeState(currentState).catch(() => null);
    const thread = pickDesktopVisualUnreadThread(currentVision);
    if (thread) {
      return {
        worldState: currentState,
        vision: currentVision,
        thread,
        scrollPasses: pass
      };
    }
  }

  return {
    worldState: currentState,
    vision: currentVision,
    thread: null,
    scrollPasses: seenStates.size
  };
}

async function scanWeChatVisionUnreadConversation({
  rule,
  workspace,
  surfaceRegistry,
  controlPlane,
  initialWorldState,
  initialVision
}: LivePackDetectionArgs & {
  initialWorldState: WorldState | null;
  initialVision: WeChatVisualAnalysis | null;
}): Promise<{
  worldState: WorldState | null;
  vision: WeChatVisualAnalysis | null;
  match: {
    candidate: InteractionCandidate | null;
    openTarget: string | null;
    openPoint: { x: number; y: number } | null;
    thread: WeChatVisualThreadSummary | null;
  } | null;
  scrollPasses: number;
}> {
  const initialFrame = await resolveDesktopVisionFrame(initialWorldState, "WeChat");
  const initialMatch = findWeChatVisionUnreadCandidate(initialFrame, initialVision);
  if (initialMatch) {
    return {
      worldState: initialWorldState,
      vision: initialVision,
      match: initialMatch,
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
      worldState: initialWorldState,
      vision: initialVision,
      match: null,
      scrollPasses: 0
    };
  }

  const watchTask = createWatchTask(rule);
  const watchWorkspace = profileAsWorkspace(rule, workspace);
  const act = (adapter as { act: (args: unknown) => Promise<unknown> }).act.bind(adapter);
  const observe = (adapter as { observe: (args: unknown) => Promise<WorldState> }).observe.bind(adapter);
  const seenStates = new Set<string>();
  let currentState = initialWorldState;
  let currentVision = initialVision;

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
    currentVision = await analyzeWeChatDesktopVisualState({
      modelClient: controlPlane.modelClient,
      worldState: currentState
    }).catch(() => null);
    const frameBounds = await resolveDesktopVisionFrame(currentState, "WeChat");
    const match = findWeChatVisionUnreadCandidate(frameBounds, currentVision);
    if (match) {
      return {
        worldState: currentState,
        vision: currentVision,
        match,
        scrollPasses: pass
      };
    }
  }

  return {
    worldState: currentState,
    vision: currentVision,
    match: null,
    scrollPasses: seenStates.size
  };
}

async function resolveDesktopVisualRecoveryPoint(
  worldState: WorldState | null,
  appName: string,
  vision: DesktopVisualAnalysis | WeChatVisualAnalysis | null
): Promise<{ x: number; y: number } | null> {
  if (!vision?.recoveryControl?.present || !vision.recoveryControl.approxBox) {
    return null;
  }

  const bounds = await resolveDesktopVisionFrame(worldState, appName);
  return resolveDesktopVisionBoxPoint({
    bounds,
    box: vision.recoveryControl.approxBox
  });
}

async function recoverDesktopVisualSceneToList<T extends DesktopVisualAnalysis | WeChatVisualAnalysis>({
  rule,
  workspace,
  surfaceRegistry,
  controlPlane,
  worldState,
  vision,
  appName,
  focusName,
  recoverLabel,
  dismissLabel,
  analyzeState,
  resolveRecoveryPoint
}: LivePackDetectionArgs & {
  worldState: WorldState | null;
  vision: T | null;
  appName: string;
  focusName: string;
  recoverLabel: string;
  dismissLabel: string;
  analyzeState: (worldState: WorldState | null) => Promise<T | null>;
  resolveRecoveryPoint?: (worldState: WorldState | null, vision: T | null) => Promise<{ x: number; y: number } | null>;
}): Promise<{
  worldState: WorldState | null;
  vision: T | null;
  recoveryAttempts: number;
}> {
  if (!isDesktopRecoveryScene(vision)) {
    return {
      worldState,
      vision,
      recoveryAttempts: 0
    };
  }

  const adapter = surfaceRegistry.get("desktop");
  if (
    !adapter
    || typeof (adapter as { act?: unknown }).act !== "function"
    || typeof (adapter as { observe?: unknown }).observe !== "function"
  ) {
    return {
      worldState,
      vision,
      recoveryAttempts: 0
    };
  }

  const watchTask = createWatchTask(rule);
  const watchWorkspace = profileAsWorkspace(rule, workspace);
  const act = (adapter as { act: (args: unknown) => Promise<unknown> }).act.bind(adapter);
  const observe = (adapter as { observe: (args: unknown) => Promise<WorldState> }).observe.bind(adapter);
  let currentState = worldState;
  let currentVision = vision;
  const waitForRecoveryUiSettle = async (attempt: number, suffix: string, ms: number) => {
    await act({
      task: watchTask,
      workspace: watchWorkspace,
      traceId: null,
      outputs: {},
      step: {
        id: `watch-${appName.toLowerCase().replace(/\s+/gu, "-")}-recover-wait-${rule.id}-${attempt}-${suffix}`,
        label: `Wait for ${appName} recovery`,
        surface: "desktop",
        action: "wait",
        params: { ms },
        checkpoint: false
      }
    } as never).catch(() => null);
  };
  const observeRecoveryState = async (attempt: number, suffix: string) => {
    currentState = await observe({
      task: watchTask,
      workspace: watchWorkspace,
      traceId: null,
      label: `watch-${appName.toLowerCase().replace(/\s+/gu, "-")}-recover-${suffix}-${attempt}`
    } as never).catch(() => currentState);
    currentVision = await analyzeState(currentState).catch(() => null);
  };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (!isDesktopRecoveryScene(currentVision)) {
      return {
        worldState: currentState,
        vision: currentVision,
        recoveryAttempts: attempt - 1
      };
    }

    await act({
      task: watchTask,
      workspace: watchWorkspace,
      traceId: null,
      outputs: {},
      step: {
        id: `watch-${appName.toLowerCase().replace(/\s+/gu, "-")}-recover-focus-${rule.id}-${attempt}`,
        label: focusName,
        surface: "desktop",
        action: "focusApp",
        params: { name: rule.appTarget ?? appName },
        checkpoint: false
      }
    } as never).catch(() => null);

    const modalWindow = findBlockingDesktopModalWindow(currentState, appName);
    const shouldDismissModalFirst = Boolean(modalWindow);
    const modalCapturePath = shouldDismissModalFirst
      ? await captureDesktopWindowForVision({
          rule,
          workspace,
          surfaceRegistry,
          controlPlane,
          appName,
          label: `watch-${appName.toLowerCase().replace(/\s+/gu, "-")}-modal-${attempt}`,
          windowNumber: Number(modalWindow?.windowNumber ?? NaN)
        }).catch(() => null)
      : null;
    const dismissPoint = shouldDismissModalFirst
      ? await groundDesktopVisualDismissPoint({
          modelClient: controlPlane.modelClient,
          worldState: currentState,
          appName,
          capturePath: modalCapturePath,
          captureBounds: (modalWindow?.bounds ?? null) as InteractionCandidate["bounds"] | null,
          captureIsModal: Boolean(modalCapturePath && modalWindow?.bounds)
        }).catch(() => null)
      : null;
    const recoveryPoint =
      shouldDismissModalFirst
        ? null
        : (await resolveRecoveryPoint?.(currentState, currentVision).catch(() => null))
          ?? (await resolveDesktopVisualRecoveryPoint(currentState, appName, currentVision));
    const previousSignature = buildWorldStateFingerprint(currentState);
    if (dismissPoint) {
      await act({
        task: watchTask,
        workspace: watchWorkspace,
        traceId: null,
        outputs: {},
        step: {
          id: `watch-${appName.toLowerCase().replace(/\s+/gu, "-")}-recover-dismiss-${rule.id}-${attempt}`,
          label: dismissLabel,
          surface: "desktop",
          action: "clickAt",
          params: dismissPoint,
          checkpoint: false
        }
      } as never).catch(() => null);
    } else if (recoveryPoint) {
      await act({
        task: watchTask,
        workspace: watchWorkspace,
        traceId: null,
        outputs: {},
        step: {
          id: `watch-${appName.toLowerCase().replace(/\s+/gu, "-")}-recover-click-${rule.id}-${attempt}`,
          label: recoverLabel,
          surface: "desktop",
          action: "clickAt",
          params: recoveryPoint,
          checkpoint: false
        }
      } as never).catch(() => null);
    } else {
      await act({
        task: watchTask,
        workspace: watchWorkspace,
        traceId: null,
        outputs: {},
        step: {
          id: `watch-${appName.toLowerCase().replace(/\s+/gu, "-")}-recover-escape-${rule.id}-${attempt}`,
          label: dismissLabel,
          surface: "desktop",
          action: "pressKey",
          params: { key: "Escape" },
          checkpoint: false
        }
      } as never).catch(() => null);
    }

    await waitForRecoveryUiSettle(attempt, "primary", dismissPoint ? 250 : 450);
    await observeRecoveryState(attempt, "primary");

    const unchangedAfterRecovery = buildWorldStateFingerprint(currentState) === previousSignature;
    if (!dismissPoint && recoveryPoint && unchangedAfterRecovery && isDesktopRecoveryScene(currentVision)) {
      await act({
        task: watchTask,
        workspace: watchWorkspace,
        traceId: null,
        outputs: {},
        step: {
          id: `watch-${appName.toLowerCase().replace(/\s+/gu, "-")}-recover-retry-${rule.id}-${attempt}`,
          label: recoverLabel,
          surface: "desktop",
          action: "clickAt",
          params: recoveryPoint,
          checkpoint: false
        }
      } as never).catch(() => null);
      await waitForRecoveryUiSettle(attempt, "retry", 600);
      await observeRecoveryState(attempt, "retry");
    }
  }

  return {
    worldState: currentState,
    vision: currentVision,
    recoveryAttempts: 2
  };
}

async function recoverWeChatSceneToChatList({
  rule,
  workspace,
  surfaceRegistry,
  controlPlane,
  worldState,
  vision
}: LivePackDetectionArgs & {
  worldState: WorldState | null;
  vision: WeChatVisualAnalysis | null;
}): Promise<{
  worldState: WorldState | null;
  vision: WeChatVisualAnalysis | null;
  recoveryAttempts: number;
}> {
  return recoverDesktopVisualSceneToList({
    rule,
    workspace,
    surfaceRegistry,
    controlPlane,
    worldState,
    vision,
    appName: "WeChat",
    focusName: "Focus WeChat",
    recoverLabel: "Recover WeChat to chat list",
    dismissLabel: "Dismiss WeChat foreign view",
    analyzeState: (candidateState) =>
      analyzeWeChatDesktopVisualState({
        modelClient: controlPlane.modelClient,
        worldState: candidateState
      })
  });
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
  const appContext = (worldState?.appContext ?? null) as Record<string, unknown> | null;
  const captureWindowNumber = Number(appContext?.captureWindowNumber ?? NaN);
  const matchesApp = (windowInfo: Record<string, unknown>) => {
    const ownerName = String(windowInfo?.ownerName ?? "");
    const windowName = String(windowInfo?.windowName ?? "");
    return appName && (ownerName.includes(appName) || windowName.includes(appName));
  };
  const captureMatched =
    Number.isFinite(captureWindowNumber) && captureWindowNumber > 0
      ? windows.find((windowInfo) =>
          matchesApp(windowInfo)
          && Number(windowInfo?.windowNumber ?? NaN) === captureWindowNumber
        )
      : null;
  const matched = captureMatched ?? windows.find(matchesApp);
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
    .replace(/^[A-Za-z]\s+(?=\p{Script=Han})/u, "")
    .replace(/^(unread email|unread mail|unread|new mail|new email|未读邮件|未读|新邮件)\s*[:：-]?\s*/iu, "")
    .replace(/^(?:(?:re|fw|fwd)\s*[:：]\s*)+/iu, "")
    .replace(/^\(\d+\)\s*/u, "")
    .replace(/\s+\(\d+\)$/u, "")
    .trim();
}

function mailSummariesMatch(left: string | null | undefined, right: string | null | undefined): boolean {
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
  const url = inferBrowserPageUrl(worldState);
  const packLabel = browserPackLabel(packName);
  const baseInputs = {
    startUrl: String(rule.taskInputs?.startUrl ?? rule.taskInputs?.url ?? url ?? defaultBrowserStartUrlForPack(packName) ?? "").trim()
  };

  let kind: WatchDetectionMetadata["manualInterventionKind"] = null;
  let detail = "";
  let action = "";
  let summary = "";

  const manualInterventionFromUrl = inferBrowserManualInterventionFromUrl({ packName, url });
  if (manualInterventionFromUrl) {
    kind = manualInterventionFromUrl.kind;
    summary = manualInterventionFromUrl.summary;
    detail = manualInterventionFromUrl.detail;
    action = manualInterventionFromUrl.action;
  }

  if (!kind && !pageText.trim()) {
    return null;
  }

  if (!kind && VERIFICATION_REQUIRED_PATTERN.test(pageText)) {
    kind = "verification";
    summary = `${packLabel} needs a human verification step`;
    detail = `${packLabel} is showing a verification or CAPTCHA page. AgentOS should pause this watch until you clear it manually.`;
    action = `Open ${packLabel} in the AgentOS browser workspace, complete the verification once, then let the watch continue.`;
  } else if (!kind && SESSION_EXPIRED_PATTERN.test(pageText)) {
    kind = "session_expired";
    summary = `${packLabel} session expired`;
    detail = `${packLabel} looks signed out or the browser session expired. AgentOS cannot continue this watch until the session is restored.`;
    action = `Open ${packLabel} in the AgentOS browser workspace and sign in again, then retry the watch.`;
  } else if (!kind && LOGIN_REQUIRED_PATTERN.test(pageText)) {
    kind = "login";
    summary = `${packLabel} needs sign-in`;
    detail = `${packLabel} is asking for sign-in before AgentOS can continue watching it.`;
    action = `Open ${packLabel} in the AgentOS browser workspace and sign in once, then retry the watch.`;
  } else if (!kind && ACCESS_DENIED_PATTERN.test(pageText)) {
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

function isOutlookComposeTextboxCandidate(candidate: InteractionCandidate | null | undefined): boolean {
  if (!candidate) {
    return false;
  }
  const hintText = candidateHintText(candidate);
  const text = String(candidate.text ?? "").trim();
  const composeSignal =
    /(message body|compose|write|editor|draft|type here|reply|回复内容|撰写|输入|邮件正文)/iu.test(hintText)
    || /(message body|compose|write|editor|draft|type here|reply|回复内容|撰写|输入|邮件正文)/iu.test(text);
  if (candidate.role === "textbox") {
    return composeSignal;
  }
  if (candidate.role === "button") {
    return false;
  }
  return composeSignal;
}

function outlookComposeChromeVisible(worldState: WorldState | null): boolean {
  const lines = visibleLines(worldState).slice(0, 80);
  const hasSend = lines.some((line) => /^send$/iu.test(String(line ?? "").trim()));
  const hasFrom = lines.some((line) => /^from:?$/iu.test(String(line ?? "").trim()));
  const hasTo = lines.some((line) => /^to:?$/iu.test(String(line ?? "").trim()));
  const hasSubject = lines.some((line) => /^subject:?$/iu.test(String(line ?? "").trim()));
  return hasSend && hasFrom && hasTo && hasSubject;
}

function fallbackOutlookComposeCandidate(worldState: WorldState | null): InteractionCandidate | null {
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

function findOutlookComposeCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = conversationCandidates(worldState, {
    desktopRequiresAccessibility: true
  });
  return candidates.find((candidate) => isOutlookComposeTextboxCandidate(candidate)) ?? fallbackOutlookComposeCandidate(worldState);
}

function findOutlookReplyButtonCandidate(worldState: WorldState | null): InteractionCandidate | null {
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

function buildOutlookDesktopComposePrefillSteps(): RuntimeStep[] {
  return [
    {
      label: "Focus Outlook",
      surface: "desktop",
      action: "focusApp",
      params: { name: "Microsoft Outlook" },
      expect: frontmostAppExpectation("Outlook"),
      checkpoint: false
    },
    {
      label: "Focus Outlook composer",
      surface: "desktop",
      action: "focusTarget",
      params: {
        target: "{{composeTarget}}",
        allowBoundsFallback: true
      },
      expect: frontmostAppExpectation("Outlook"),
      checkpoint: false
    },
    {
      label: "Type Outlook reply",
      surface: "desktop",
      action: "typeIntoTarget",
      params: {
        target: "{{composeTarget}}",
        text: "{{typeText}}",
        clear: true,
        inputMethod: "paste",
        allowBoundsFallback: true
      },
      checkpoint: false
    },
    {
      label: "Verify Outlook prefill",
      surface: "desktop",
      action: "wait",
      params: { ms: 700, timeoutMs: 5000, pollMs: 500 },
      expect: {
        frontmostApp: "Outlook",
        regionTextAnyVisible: [
          {
            text: "{{typeTextPreview}}",
            region: "{{composeVerifyRegion}}",
            scale: 2.4
          },
          {
            text: "{{typeTextMiddlePreview}}",
            region: "{{composeVerifyRegion}}",
            scale: 2.4
          },
          {
            text: "{{typeTextTailPreview}}",
            region: "{{composeVerifyRegion}}",
            scale: 2.4
          },
          {
            text: "{{typeTextSuffixPreview}}",
            region: "{{composeVerifyRegion}}",
            scale: 2.4
          }
        ]
      },
      checkpoint: false
    },
    {
      label: "Send Outlook reply",
      surface: "desktop",
      action: "clickTarget",
      params: {
        target: "{{sendTargetCandidate}}",
        targetQuery: "{{sendTargetQuery}}",
        allowBoundsFallback: false
      },
      checkpoint: false
    }
  ];
}

function buildSlackDesktopVisualReplySteps(): RuntimeStep[] {
  return [
    {
      label: "Focus Slack",
      surface: "desktop",
      action: "focusApp",
      params: { name: "Slack" },
      expect: frontmostAppExpectation("Slack"),
      checkpoint: false
    },
    {
      label: "Dismiss stray Slack overlay",
      surface: "desktop",
      action: "pressKey",
      params: { key: "Escape" },
      checkpoint: false
    },
    {
      label: "Open unread Slack thread",
      surface: "desktop",
      action: "clickAt",
      params: { x: "{{openX}}", y: "{{openY}}" },
      checkpoint: false
    },
    {
      label: "Wait for Slack thread to open",
      surface: "desktop",
      action: "wait",
      params: { ms: 500, timeoutMs: 8000, pollMs: 500 },
      expect: desktopVisionThreadExpectation("Slack", "slack_thread"),
      checkpoint: false
    },
    {
      label: "Focus Slack composer area",
      surface: "desktop",
      action: "clickAt",
      params: { x: "{{composeX}}", y: "{{composeY}}" },
      expect: frontmostAppExpectation("Slack"),
      checkpoint: false
    },
    {
      label: "Type Slack reply",
      surface: "desktop",
      action: "typeText",
      params: { text: "{{typeText}}" },
      checkpoint: false
    },
    {
      label: "Verify Slack prefill",
      surface: "desktop",
      action: "wait",
      params: { ms: 250, timeoutMs: 4000, pollMs: 400 },
      expect: desktopVisionPrefillExpectation("Slack", "slack_prefill"),
      checkpoint: false
    }
  ];
}

function buildOutlookDesktopVisualReplySteps(): RuntimeStep[] {
  return [
    {
      label: "Focus Outlook",
      surface: "desktop",
      action: "focusApp",
      params: { name: "Microsoft Outlook" },
      expect: frontmostAppExpectation("Outlook"),
      checkpoint: false
    },
    {
      label: "Open unread Outlook thread",
      surface: "desktop",
      action: "clickAt",
      params: {
        x: "{{openX}}",
        y: "{{openY}}"
      },
      checkpoint: false
    },
    {
      label: "Wait for Outlook thread to open",
      surface: "desktop",
      action: "wait",
      params: { ms: 500, timeoutMs: 8000, pollMs: 500 },
      expect: desktopVisionThreadExpectation("Outlook", "outlook_thread"),
      checkpoint: false
    },
    {
      label: "Open Outlook reply composer",
      surface: "desktop",
      action: "clickTarget",
      params: { targetQuery: "{{replyTargetQuery}}", allowBoundsFallback: false },
      checkpoint: false
    },
    {
      label: "Wait for Outlook composer",
      surface: "desktop",
      action: "wait",
      params: { ms: 500, timeoutMs: 4000, pollMs: 500 },
      checkpoint: false
    },
    {
      label: "Type Outlook reply",
      surface: "desktop",
      action: "typeText",
      params: { text: "{{typeText}}" },
      checkpoint: false
    },
    {
      label: "Verify Outlook prefill",
      surface: "desktop",
      action: "wait",
      params: { ms: 500, timeoutMs: 5000, pollMs: 500 },
      expect: desktopVisionPrefillExpectation("Outlook", "outlook_prefill"),
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
    return withAnalysisSemantics({
      packName: normalizedPackName,
      foreground: isSlackDesktopForeground(worldState),
      unreadCandidate: summarizeProbeCandidate(findSlackUnreadCandidate(worldState)),
      composeCandidate: summarizeProbeCandidate(findSlackComposeCandidate(worldState, "desktop")),
      sendCandidate: summarizeProbeCandidate(findSlackSendCandidate(worldState, "desktop")),
      topUnreadCandidates: rankProbeCandidates(worldState, scoreSlackCandidate, candidates)
    });
  }

  if (normalizedPackName === "slack-browser") {
    const candidates = conversationCandidates(worldState);
    return withAnalysisSemantics({
      packName: normalizedPackName,
      foreground: true,
      unreadCandidate: summarizeProbeCandidate(findSlackUnreadCandidate(worldState)),
      composeCandidate: summarizeProbeCandidate(findSlackComposeCandidate(worldState, "browser")),
      sendCandidate: summarizeProbeCandidate(findSlackSendCandidate(worldState, "browser")),
      topUnreadCandidates: rankProbeCandidates(worldState, scoreSlackCandidate, candidates)
    });
  }

  if (normalizedPackName === "wechat-desktop") {
    const candidates = conversationCandidates(worldState);
    return withAnalysisSemantics({
      packName: normalizedPackName,
      foreground: isWeChatDesktopForeground(worldState),
      unreadCandidate: summarizeProbeCandidate(findWeChatUnreadCandidate(worldState)),
      composeCandidate: summarizeProbeCandidate(findWeChatComposeCandidate(worldState)),
      sendCandidate: summarizeProbeCandidate(findWeChatSendCandidate(worldState)),
      topUnreadCandidates: rankWeChatUnreadCandidates(worldState)
        .slice(0, 5)
        .map((entry) => summarizeProbeCandidate(entry.candidate, entry.score))
        .filter((entry): entry is DesktopProbeCandidateSummary => Boolean(entry))
    }, {
      runnerType: "desktop_vlm"
    });
  }

  if (normalizedPackName === "outlook-desktop") {
    const candidates = conversationCandidates(worldState, { desktopRequiresAccessibility: true });
    return withAnalysisSemantics({
      packName: normalizedPackName,
      foreground: isOutlookDesktopForeground(worldState),
      unreadCandidate: summarizeProbeCandidate(findOutlookUnreadCandidate(worldState)),
      composeCandidate: summarizeProbeCandidate(findOutlookComposeCandidate(worldState)),
      sendCandidate: summarizeProbeCandidate(findOutlookSendCandidate(worldState)),
      topUnreadCandidates: rankProbeCandidates(worldState, scoreOutlookCandidate, candidates)
    });
  }

  if (normalizedPackName === "generic-mail-desktop") {
    const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
    return withAnalysisSemantics({
      packName: normalizedPackName,
      foreground: true,
      unreadCandidate: summarizeProbeCandidate(findMailUnreadCandidate(worldState)),
      composeCandidate: summarizeProbeCandidate(findMailComposeCandidate(worldState)),
      sendCandidate: summarizeProbeCandidate(findMailSendCandidate(worldState)),
      topUnreadCandidates: rankProbeCandidates(worldState, scoreMailCandidate, candidates)
    });
  }

  if (normalizedPackName === "generic-mail-browser") {
    const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
    return withAnalysisSemantics({
      packName: normalizedPackName,
      foreground: true,
      unreadCandidate: summarizeProbeCandidate(findMailUnreadCandidate(worldState)),
      composeCandidate: summarizeProbeCandidate(findMailComposeCandidate(worldState)),
      sendCandidate: summarizeProbeCandidate(findMailSendCandidate(worldState)),
      topUnreadCandidates: rankProbeCandidates(worldState, scoreMailCandidate, candidates)
    });
  }

  if (normalizedPackName === "boss-browser") {
    const candidates = Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : [];
    return withAnalysisSemantics({
      packName: normalizedPackName,
      foreground: true,
      unreadCandidate: summarizeProbeCandidate(findBossCandidate(worldState)),
      composeCandidate: null,
      sendCandidate: null,
      topUnreadCandidates: rankProbeCandidates(worldState, scoreBossCandidate, candidates)
    });
  }

  return null;
}

async function resolveDesktopObservedPoint(
  worldState: WorldState | null,
  appName: string,
  point: { x: number; y: number } | null
): Promise<{ x: number; y: number } | null> {
  if (!point) {
    return null;
  }

  const frame = await resolveDesktopVisionFrame(worldState, appName);
  if (!frame) {
    return point;
  }

  const appContext = (worldState?.appContext ?? null) as Record<string, unknown> | null;
  const captureWindowNumber = Number(appContext?.captureWindowNumber ?? NaN);
  const captureSize = await readCaptureImageSize(String(worldState?.capture?.path ?? ""));
  const looksLocalToFrame =
    Number.isFinite(Number(point.x)) &&
    Number.isFinite(Number(point.y)) &&
    Number(point.x) >= 0 &&
    Number(point.y) >= 0 &&
    Number(point.x) <= Number(frame.width ?? 0) &&
    Number(point.y) <= Number(frame.height ?? 0);
  const localToCapture =
    captureSize &&
    Number.isFinite(Number(point.x)) &&
    Number.isFinite(Number(point.y)) &&
    Number(point.x) >= 0 &&
    Number(point.y) >= 0 &&
    Number(point.x) <= captureSize.width &&
    Number(point.y) <= captureSize.height;

  if ((localToCapture || looksLocalToFrame) && (Number.isFinite(captureWindowNumber) || looksLocalToFrame)) {
    const scaleX =
      localToCapture && captureSize && Number(captureSize.width) > 0 && Number(frame.width ?? 0) > 0
        ? Number(frame.width ?? 0) / Number(captureSize.width)
        : 1;
    const scaleY =
      localToCapture && captureSize && Number(captureSize.height) > 0 && Number(frame.height ?? 0) > 0
        ? Number(frame.height ?? 0) / Number(captureSize.height)
        : 1;
    return {
      x: Number(frame.x ?? 0) + Number(point.x) * scaleX,
      y: Number(frame.y ?? 0) + Number(point.y) * scaleY
    };
  }

  return point;
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
  modelClient,
  timeoutMs
}: {
  packName: string;
  worldState: WorldState | null;
  modelClient?: Pick<LivePackControlPlane["modelClient"], "supportsImageJson" | "analyzeImageJson"> | null;
  timeoutMs?: number;
}): Promise<DesktopConversationPackAnalysis | null> {
  const base = analyzeDesktopConversationPack(packName, worldState);
  if (packName === "wechat-desktop") {
    const visionResult = await analyzeWeChatDesktopVisualState({
      modelClient: modelClient ?? null,
      worldState,
      timeoutMs
    }).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error })
    );
    const vision = visionResult.value;
    if (!vision) {
      return withAnalysisSemantics({
        packName: "wechat-desktop",
        foreground: base?.foreground ?? isWeChatDesktopForeground(worldState),
        unreadCandidate: null,
        composeCandidate: null,
        sendCandidate: null,
        topUnreadCandidates: []
      }, {
        runnerType: "desktop_vlm",
        skipReasons: visionErrorSkipReasons(base, visionResult.error)
      });
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
      hints: [
        thread.evidence,
        thread.latestSnippet,
        thread.replyReason,
        `kind:${thread.threadKind}`,
        `conversation:${thread.conversationKind}`,
        `priority:${thread.priority}`,
        thread.replyable ? "replyable" : "non-replyable",
        thread.shouldReply ? "should-reply" : "skip-reply"
      ].filter(Boolean)
    })) satisfies DesktopProbeCandidateSummary[];

    return withAnalysisSemantics({
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
            hints: visionThreadCandidates.find((candidate) => candidate.text === unreadMatch.openTarget)?.hints ?? []
          }
        : null,
      composeCandidate,
      sendCandidate: base?.sendCandidate ?? null,
      topUnreadCandidates: visionThreadCandidates
    }, {
      runnerType: "desktop_vlm",
      scene: vision.scene,
      selectedTarget: unreadMatch?.openTarget ?? vision.openThread ?? null,
      skipReasons: deriveWeChatSkipReasons({ vision, unreadMatch }),
      recoveryAction: vision.recommendedRecoveryAction
    });
  }

  if (packName === "slack-desktop") {
    const visionResult = await analyzeSlackDesktopVisualState({
      modelClient: modelClient ?? null,
      worldState,
      timeoutMs
    }).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error })
    );
    const vision = visionResult.value;
    if (!vision) {
      return withAnalysisSemantics({
        packName,
        foreground: base?.foreground ?? isSlackDesktopForeground(worldState),
        unreadCandidate: base?.unreadCandidate ?? null,
        composeCandidate: base?.composeCandidate ?? null,
        sendCandidate: base?.sendCandidate ?? null,
        topUnreadCandidates: base?.topUnreadCandidates ?? []
      }, {
        runnerType: "desktop_vlm",
        skipReasons: visionErrorSkipReasons(base, visionResult.error)
      });
    }

    const selectedThread = pickDesktopVisualUnreadThread(vision);
    const topUnreadCandidates = await summarizeDesktopVisualThreadCandidates(worldState, "Slack", "slack", vision.visibleUnreadThreads);
    const composeBounds = await resolveDesktopVisionCandidateBounds(worldState, "Slack", vision.composer.approxBox);
    return withAnalysisSemantics({
      packName,
      foreground: base?.foreground ?? isSlackDesktopForeground(worldState),
      unreadCandidate: selectedThread
        ? {
            id: "slack-vision-unread",
            text: selectedThread.name,
            role: "text",
            interactive: true,
            source: "vision",
            score: 100,
            bounds: topUnreadCandidates.find((candidate) => candidate.text === selectedThread.name)?.bounds,
            hints: topUnreadCandidates.find((candidate) => candidate.text === selectedThread.name)?.hints ?? []
          }
        : null,
      composeCandidate: vision.composer.present
        ? {
            id: "slack-vision-composer",
            text: vision.composer.evidence || "Slack composer",
            role: "textbox",
            interactive: true,
            source: "vision",
            score: 100,
            bounds: composeBounds,
            hints: [vision.composer.evidence].filter(Boolean)
          }
        : null,
      sendCandidate: base?.sendCandidate ?? null,
      topUnreadCandidates
    }, {
      runnerType: "desktop_vlm",
      scene: vision.scene,
      selectedTarget: selectedThread?.name ?? vision.openThread ?? null,
      skipReasons: deriveDesktopVisualSkipReasons({ vision, unreadThread: selectedThread }),
      recoveryAction: vision.recommendedRecoveryAction
    });
  }

  if (packName === "outlook-desktop") {
    const visionResult = await analyzeOutlookDesktopVisualState({
      modelClient: modelClient ?? null,
      worldState,
      timeoutMs
    }).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error })
    );
    const vision = visionResult.value;
    if (!vision) {
      return withAnalysisSemantics({
        packName,
        foreground: base?.foreground ?? isOutlookDesktopForeground(worldState),
        unreadCandidate: base?.unreadCandidate ?? null,
        composeCandidate: base?.composeCandidate ?? null,
        sendCandidate: base?.sendCandidate ?? null,
        topUnreadCandidates: base?.topUnreadCandidates ?? []
      }, {
        runnerType: "desktop_vlm",
        skipReasons: visionErrorSkipReasons(base, visionResult.error)
      });
    }

    const selectedThread = pickDesktopVisualUnreadThread(vision);
    const selectedTarget =
      vision.scene === "thread" && String(vision.openThread ?? "").trim()
        ? String(vision.openThread ?? "").trim()
        : selectedThread?.name ?? vision.openThread ?? null;
    const topUnreadCandidates = await summarizeDesktopVisualThreadCandidates(worldState, "Microsoft Outlook", "outlook", vision.visibleUnreadThreads);
    const composeBounds = await resolveDesktopVisionCandidateBounds(worldState, "Microsoft Outlook", vision.composer.approxBox);
    return withAnalysisSemantics({
      packName,
      foreground: base?.foreground ?? isOutlookDesktopForeground(worldState),
      unreadCandidate: selectedThread
        ? {
            id: "outlook-vision-unread",
            text: selectedThread.name,
            role: "text",
            interactive: true,
            source: "vision",
            score: 100,
            bounds: topUnreadCandidates.find((candidate) => candidate.text === selectedThread.name)?.bounds,
            hints: topUnreadCandidates.find((candidate) => candidate.text === selectedThread.name)?.hints ?? []
          }
        : null,
      composeCandidate: vision.composer.present
        ? {
            id: "outlook-vision-composer",
            text: vision.composer.evidence || "Outlook composer",
            role: "textbox",
            interactive: true,
            source: "vision",
            score: 100,
            bounds: composeBounds,
            hints: [vision.composer.evidence].filter(Boolean)
          }
        : null,
      sendCandidate: base?.sendCandidate ?? null,
      topUnreadCandidates
    }, {
      runnerType: "desktop_vlm",
      scene: vision.scene,
      selectedTarget,
      skipReasons: deriveDesktopVisualSkipReasons({ vision, unreadThread: selectedThread }),
      recoveryAction: vision.recommendedRecoveryAction
    });
  }

  if (packName !== "wechat-desktop") {
    return base;
  }

  return base;
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
      const startUrl = String(
        rule.taskInputs?.startUrl ?? rule.taskInputs?.url ?? rule.appTarget ?? defaultBrowserStartUrlForPack(name) ?? ""
      ).trim();
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
    label: `watch-${rule.id}`,
    ...(effectiveDesktopAppTarget ? { targetAppName: effectiveDesktopAppTarget } : {})
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

      const startUrl = String(
        rule.taskInputs?.startUrl ?? rule.taskInputs?.url ?? rule.appTarget ?? defaultBrowserStartUrlForPack(name) ?? ""
      ).trim();
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
        desktopRequireAccessibility: false
      });
    },
    async detectNewItems(args) {
      const { rule, worldState, dedupeState = {}, workspace, surfaceRegistry, controlPlane } = args;
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

      if (surface === "desktop") {
        let vision = await analyzeSlackDesktopVisualState({
          modelClient: controlPlane.modelClient,
          worldState,
          timeoutMs: SLACK_DESKTOP_DETECT_ANALYZE_TIMEOUT_MS
        }).catch(() => null);
        let effectiveWorldState = worldState;
        let recoveryAttempts = 0;
        if (isDesktopRecoveryScene(vision)) {
          const recovered = await recoverDesktopVisualSceneToList({
            rule,
            workspace,
            surfaceRegistry,
            controlPlane,
            worldState,
            vision,
            appName: "Slack",
            focusName: "Focus Slack",
            recoverLabel: "Recover Slack to conversation list",
            dismissLabel: "Dismiss Slack foreign view",
            analyzeState: (candidateState) =>
              analyzeSlackDesktopVisualState({
                modelClient: controlPlane.modelClient,
                worldState: candidateState,
                timeoutMs: SLACK_DESKTOP_DETECT_ANALYZE_TIMEOUT_MS
              })
          });
          effectiveWorldState = recovered.worldState ?? worldState;
          vision = recovered.vision;
          recoveryAttempts = recovered.recoveryAttempts;
        }
        if (vision && isDesktopRecoveryScene(vision)) {
          return null;
        }
        let thread = pickDesktopVisualUnreadThread(vision);
        let scrollPasses = 0;
        if (!thread) {
          const scanned = await scanDesktopVisionUnreadConversation({
            rule,
            worldState,
            workspace,
            surfaceRegistry,
            controlPlane,
            initialWorldState: effectiveWorldState,
            initialVision: vision,
            appName: "Slack",
            anchor: { x: 0.18, y: 0.28 },
            scrollDy: -380,
            maxPasses: DESKTOP_VLM_SCROLL_SCAN_MAX_PASSES,
            analyzeState: (candidateState) =>
              analyzeSlackDesktopVisualState({
                modelClient: controlPlane.modelClient,
                worldState: candidateState,
                timeoutMs: SLACK_DESKTOP_DETECT_ANALYZE_TIMEOUT_MS
              })
          });
          effectiveWorldState = scanned.worldState ?? effectiveWorldState;
          vision = scanned.vision;
          thread = scanned.thread;
          scrollPasses = scanned.scrollPasses;
        }
        if (vision && thread) {
          const openTarget = normalizeSlackSummary(thread.name);
          if (!openTarget) {
            return null;
          }

          const threadBounds = await resolveDesktopVisionCandidateBounds(effectiveWorldState, "Slack", thread.approxBox);
          const openPoint = await resolveDesktopVisionClickPoint(effectiveWorldState, "Slack", thread.approxBox);
          const composePoint = await resolveDesktopVisionClickPoint(
            effectiveWorldState,
            "Slack",
            vision.composer.approxBox,
            { x: 0.66, y: 0.92 }
          );
          if (!threadBounds || !openPoint || !composePoint) {
            return null;
          }

          const context = uniqueStrings([
            String(thread.latestSnippet ?? "").trim(),
            String(thread.replyReason ?? "").trim(),
            ...contextForSignal(effectiveWorldState, { text: openTarget })
          ]).slice(0, 4);
          const itemFingerprint = fingerprint(`${name}:${surface}:${rule.workspaceName ?? "default"}:${openTarget}:${context.join("|")}`);
          if (dedupeState.lastFingerprint === itemFingerprint) {
            return null;
          }

          return {
            fingerprint: itemFingerprint,
            summary: openTarget,
            text: openTarget,
            context,
            inputs: {
              watchItemText: openTarget,
              watchSummary: openTarget,
              watchContext: context.join("\n"),
              openTarget,
              threadTitle: openTarget,
              openX: openPoint.x,
              openY: openPoint.y,
              composeX: composePoint.x,
              composeY: composePoint.y
            },
            metadata: {
              visualAnalysis: vision,
              visualThread: thread,
              recoveryAttempts,
              openPoint,
              scrollPasses,
              openCandidate: {
                id: "slack-vision-unread",
                text: openTarget,
                role: "text",
                isInteractive: true,
                bounds: threadBounds
              },
              ...buildConversationMetadata({
                packName: name,
                surface,
                summary: openTarget,
                context,
                openTarget,
                candidate: {
                  id: "slack-vision-unread",
                  text: openTarget,
                  role: "text",
                  isInteractive: true,
                  bounds: threadBounds
                } as InteractionCandidate
              })
            },
            taskSpec: {
              preferredSurface: "desktop",
              steps: buildSlackDesktopVisualReplySteps()
            }
          };
        }

        if (vision) {
          return null;
        }
      }

      if (!isSlackDesktopForeground(worldState) && surface === "desktop") {
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
      if (surface === "desktop" && args.detection.metadata?.visualAnalysis) {
        const summary = String(args.detection.summary ?? "").trim();
        const context = Array.isArray(args.detection.context) ? args.detection.context : [];
        const openTarget = String(args.detection.inputs?.openTarget ?? summary).trim() || summary;
        return {
          summary,
          context,
          inputs: {
            ...(args.detection.inputs ?? {}),
            watchContext: context.join("\n"),
            openTarget,
            threadTitle: openTarget
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
          taskSpec: args.detection.taskSpec ?? undefined
        };
      }

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
    async detectNewItems(args) {
      const { rule, worldState, dedupeState = {}, workspace, surfaceRegistry, controlPlane } = args;
      let initialVision = await analyzeWeChatDesktopVisualState({
        modelClient: controlPlane.modelClient,
        worldState
      }).catch(() => null);
      if (!initialVision) {
        return null;
      }
      let effectiveInitialWorldState = worldState;
      let recoveryAttempts = 0;
      if (isWeChatRecoveryScene(initialVision)) {
        const recovered = await recoverWeChatSceneToChatList({
          rule,
          worldState,
          workspace,
          surfaceRegistry,
          controlPlane,
          vision: initialVision
        });
        effectiveInitialWorldState = recovered.worldState ?? worldState;
        initialVision = recovered.vision;
        recoveryAttempts = recovered.recoveryAttempts;
      }
      if (!initialVision || isWeChatRecoveryScene(initialVision)) {
        return null;
      }
      const {
        worldState: scannedWorldState,
        vision,
        match: visualMatch,
        scrollPasses
      } = await scanWeChatVisionUnreadConversation({
        rule,
        worldState: effectiveInitialWorldState,
        workspace,
        surfaceRegistry,
        controlPlane,
        initialWorldState: effectiveInitialWorldState,
        initialVision
      });
      if (!vision || !visualMatch) {
        return null;
      }
      const effectiveWorldState = scannedWorldState ?? worldState;
      const wechatVisionFrame = await resolveDesktopVisionFrame(effectiveWorldState, "WeChat");
      const candidate = visualMatch?.candidate ?? null;
      const visualThread = visualMatch?.thread ?? null;
      const openTarget = String(visualMatch?.openTarget ?? candidate?.text ?? "").trim();
      if (!candidate && !openTarget) {
        return null;
      }

      const summary = normalizeWeChatSummary(openTarget || candidate?.text || candidateHintText(candidate));
      if (!summary) {
        return null;
      }
      const composerFallback =
        (await deriveWeChatVisualComposerFallback(effectiveWorldState, vision)) ?? deriveWeChatComposerFallback(effectiveWorldState);
      if (!composerFallback) {
        return null;
      }

      const groundedTarget = await groundWeChatTargetThreadClickPoint({
        modelClient: controlPlane.modelClient,
        worldState: effectiveWorldState,
        targetThread: openTarget || summary
      }).catch(() => null);

      const context = uniqueStrings([
        String(visualThread?.latestSnippet ?? "").trim(),
        String(visualThread?.replyReason ?? "").trim(),
        ...contextForSignal(effectiveWorldState, { text: openTarget || candidate?.text || summary })
      ]).slice(0, 4);
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
          ...(visualThread ? { visualThread } : {}),
          ...(vision ? { visualAnalysis: vision } : {}),
          recoveryAttempts,
          scrollPasses,
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
      const visualThread = ((detection?.metadata as Record<string, unknown> | undefined)?.visualThread ?? null) as
        | Partial<WeChatVisualThreadSummary>
        | null;
      const enrichedContext = uniqueStrings([
        ...context,
        String(visualThread?.latestSnippet ?? "").trim(),
        String(visualThread?.replyReason ?? "").trim()
      ]).slice(0, 5);
      return draftPackReply({
        controlPlane,
        livePack: "wechat-desktop",
        preferredSurface: "desktop",
        family: "chat",
        goal: [
          rule.goal,
          "For WeChat, only draft a reply when the visible unread thread clearly needs a response.",
          "Avoid generic acknowledgements.",
          "Use the visible latest message snippet and reply reason.",
          "If the visible context is limited, write a concrete low-risk clarifying reply instead of a vague placeholder."
        ].join("\n"),
        summary,
        context: enrichedContext
      });
    }
  };
}

async function openMailThreadForContext({
  rule,
  workspace,
  surfaceRegistry,
  controlPlane,
  surface,
  detection,
  worldState,
  desktopReplyShortcut = null,
  allowReplyShortcutFallback = Boolean(desktopReplyShortcut)
}: LivePackExtractContextArgs & {
  surface: LivePackSurface;
  desktopReplyShortcut?: { key: string; modifiers?: string[] } | null;
  allowReplyShortcutFallback?: boolean;
}): Promise<WorldState | null> {
  const adapter = surfaceRegistry.get(surface);
  if (!adapter) {
    return null;
  }
  // Outlook often drops AX candidates while a thread is switching, but we still need a fresh screenshot.
  const desktopVisualObserveRequiresAccessibility = false;

  const openTarget = String(detection.inputs?.openTarget ?? detection.summary ?? "").trim();
  if (!openTarget) {
    return null;
  }
  const openThreadCue =
    String(
      (detection.metadata?.visualThread as { subjectCue?: unknown; latestSnippet?: unknown } | null)?.subjectCue
      ?? (detection.metadata?.visualThread as { subjectCue?: unknown; latestSnippet?: unknown } | null)?.latestSnippet
      ?? detection.context?.[0]
      ?? ""
    ).trim() || null;

  const openCandidate = (detection.metadata?.openCandidate ?? null) as Record<string, unknown> | null;
  const openX = Number(detection.inputs?.openX);
  const openY = Number(detection.inputs?.openY);
  const buildOpenStep = (
    id: string,
    label: string,
    allowBoundsFallback = true,
    preferTargetQuery = false
  ): RuntimeStep | null =>
    (surface === "desktop" && !preferTargetQuery && Number.isFinite(openX) && Number.isFinite(openY))
      ? {
          id,
          label,
          surface,
          action: "clickAt",
          params: {
            x: openX,
            y: openY
          }
        }
      : (openCandidate && (preferTargetQuery || surface === "desktop"))
      ? {
          id,
          label,
          surface,
          action: "clickTarget",
          params: {
            targetQuery: openTarget,
            target: openCandidate,
            allowBoundsFallback
          }
        }
      : Number.isFinite(openX) && Number.isFinite(openY)
        ? {
            id,
            label,
            surface,
            action: "clickAt",
            params: {
              x: openX,
              y: openY
            }
          }
        : openCandidate
        ? {
            id,
            label,
            surface,
            action: "clickTarget",
            params: {
              targetQuery: openTarget,
              target: openCandidate,
              allowBoundsFallback
            }
          }
        : null;
  const detectionVisual = (detection.metadata?.visualAnalysis ?? null) as { scene?: unknown; openThread?: unknown } | null;
  const previousOpenThread = String(detectionVisual?.openThread ?? "").trim();
  const confirmedThreadVision: DesktopVisualAnalysis | null =
    surface === "desktop" && String(detectionVisual?.scene ?? "").trim() === "thread"
      ? {
          openThread: previousOpenThread || null,
          selectedRow: String((detectionVisual as { selectedRow?: unknown } | null)?.selectedRow ?? "").trim() || null,
          visibleUnreadThreads: [],
          composer: { present: false, evidence: "", approxBox: null, entryPoint: null, hasDraftText: null, draftPreview: null },
          scene: "thread",
          sceneEvidence: previousOpenThread,
          recommendedRecoveryAction: "none",
          recoveryControl: { present: false, evidence: "", approxBox: null },
          targetThreadOpen: previousOpenThread === openTarget ? true : null,
          prefillVisible: null
        }
      : null;
  const threadAlreadyOpen =
    didOutlookThreadSelectionAdvance({
      vision: confirmedThreadVision,
      targetThread: openTarget,
      targetCue: openThreadCue,
      previousOpenThread
    });
  let lastReliableOutlookThreadVision: DesktopVisualAnalysis | null = threadAlreadyOpen ? confirmedThreadVision : null;
  const updateLastReliableOutlookThreadVision = (vision: DesktopVisualAnalysis | null): DesktopVisualAnalysis | null => {
    if (vision) {
      lastReliableOutlookThreadVision = vision;
    }
    return vision;
  };
  const effectiveOutlookThreadVision = (vision: DesktopVisualAnalysis | null): DesktopVisualAnalysis | null =>
    vision ?? lastReliableOutlookThreadVision;
  let openAttempts = 0;
  const hasThreadSelectionAdvanced = (vision: DesktopVisualAnalysis | null, state: WorldState | null = threadState) => {
    const effectiveVision = effectiveOutlookThreadVision(vision);
    return (
      didOutlookThreadSelectionAdvance({
        vision: effectiveVision,
        targetThread: openTarget,
        targetCue: openThreadCue,
        previousOpenThread
      })
      || didOutlookThreadSelectionAdvanceFromState({
        worldState: state,
        targetThread: openTarget,
        targetCue: openThreadCue,
        previousOpenThread
      })
      || (
        openAttempts > 0
        && effectiveVision?.scene === "thread"
        && !isOutlookTargetUnreadStillVisible(effectiveVision, openTarget, openThreadCue)
      )
    );
  };
  const hasCurrentThreadConfirmation = (vision: DesktopVisualAnalysis | null, state: WorldState | null = threadState) =>
    hasThreadSelectionAdvanced(vision, state);
  const hasAvailableOutlookComposer = (vision: DesktopVisualAnalysis | null, state: WorldState | null) =>
    vision ? vision.scene === "thread" && Boolean(vision.composer.present) : Boolean(findOutlookComposeCandidate(state));
  const outlookTextOpenQueries =
    surface === "desktop" && rule.livePack === "outlook-desktop"
      ? uniqueStrings([openTarget, String(openThreadCue ?? "").trim()].filter(Boolean))
      : [];
  const buildOutlookTextOpenStep = (
    id: string,
    label: string,
    attemptIndex = 0,
    preferredTarget: Record<string, unknown> | null = openCandidate,
    allowBoundsFallback = true
  ): RuntimeStep | null => {
    const preferredText = String(preferredTarget?.text ?? "").trim();
    const fallbackText =
      openTarget
      || outlookTextOpenQueries[0]
      || outlookTextOpenQueries[Math.min(attemptIndex, Math.max(0, outlookTextOpenQueries.length - 1))]
      || "";
    const text = preferredText || fallbackText;
    return text
      ? {
          id,
          label,
          surface,
          action: "clickTarget",
          params: {
            targetQuery: text,
            target: preferredTarget ?? {
              id: `${id}-target`,
              text,
              role: "text",
              isInteractive: true
            },
            allowBoundsFallback
          }
        }
      : null;
  };
  traceOutlookThreadState("thread-already-open-check", {
    vision: confirmedThreadVision,
    targetThread: openTarget,
    targetCue: openThreadCue,
    previousOpenThread,
    openAttempts
  });
  if (!threadAlreadyOpen) {
    const openStep = buildOpenStep(`mail-open-${rule.id}`, "Open mail thread");
    if (!openStep) {
      return null;
    }
    const textOpenStep =
      openStep.action === "clickAt"
        ? null
        : buildOutlookTextOpenStep(`mail-open-text-${rule.id}`, "Open mail thread by visible text");
    let executedOpenStep: RuntimeStep = openStep;
    openAttempts += 1;
    if (textOpenStep) {
      try {
        await adapter.act({
          task: createWatchTask(rule),
          step: textOpenStep,
          workspace: profileAsWorkspace(rule, workspace),
          traceId: null,
          outputs: {}
        });
        executedOpenStep = textOpenStep;
      } catch {
        await adapter.act({
          task: createWatchTask(rule),
          step: openStep,
          workspace: profileAsWorkspace(rule, workspace),
          traceId: null,
          outputs: {}
        });
        executedOpenStep = openStep;
      }
    } else {
      await adapter.act({
        task: createWatchTask(rule),
        step: openStep,
        workspace: profileAsWorkspace(rule, workspace),
        traceId: null,
        outputs: {}
      });
      executedOpenStep = openStep;
    }
    if (surface === "desktop" && rule.livePack === "outlook-desktop") {
      await adapter.act({
        task: createWatchTask(rule),
        step: {
          id: `mail-open-refocus-wait-${rule.id}`,
          label: "Wait for Outlook thread selection focus",
          surface,
          action: "wait",
          params: { ms: 150 }
        },
        workspace: profileAsWorkspace(rule, workspace),
        traceId: null,
        outputs: {}
      });
      await adapter.act({
        task: createWatchTask(rule),
        step: {
          id: `mail-open-confirm-${rule.id}`,
          label: "Confirm Outlook thread selection",
          surface,
          action: executedOpenStep.action,
          params: { ...(executedOpenStep.params ?? {}) }
        },
        workspace: profileAsWorkspace(rule, workspace),
        traceId: null,
        outputs: {}
      });
    }
    if (surface === "desktop" && previousOpenThread && rule.livePack !== "outlook-desktop") {
      await adapter.act({
        task: createWatchTask(rule),
        step: {
          id: `mail-open-confirm-${rule.id}`,
          label: "Confirm mail thread selection",
          surface,
          action: openStep.action,
          params: { ...(openStep.params ?? {}) }
        },
        workspace: profileAsWorkspace(rule, workspace),
        traceId: null,
        outputs: {}
      });
    }

    if (surface === "desktop") {
      await adapter.act({
        task: createWatchTask(rule),
        step: {
          id: `mail-open-wait-${rule.id}`,
          label: "Wait for mail thread to settle",
          surface,
          action: "wait",
          params: { ms: 900 }
        },
        workspace: profileAsWorkspace(rule, workspace),
        traceId: null,
        outputs: {}
      });
    }
  }

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
    desktopRequireAccessibility: surface === "desktop" ? desktopVisualObserveRequiresAccessibility : false
  });
  let outlookThreadVision =
    surface === "desktop"
      ? updateLastReliableOutlookThreadVision(await analyzeOutlookDesktopVisualState({
          modelClient: controlPlane?.modelClient,
          worldState: threadState,
          timeoutMs: OUTLOOK_DESKTOP_DETECT_ANALYZE_TIMEOUT_MS
        }).catch((error) => {
          traceOutlookAnalysisError("post-open-observe", error);
          return null;
        }))
      : null;
  traceOutlookThreadState("post-open-observe", {
    vision: outlookThreadVision,
    targetThread: openTarget,
    targetCue: openThreadCue,
    previousOpenThread,
    openAttempts
  });

  if (surface === "desktop" && !hasAvailableOutlookComposer(outlookThreadVision, threadState) && !outlookThreadVision) {
    for (let attempt = 1; attempt <= 2 && !hasAvailableOutlookComposer(outlookThreadVision, threadState) && !outlookThreadVision; attempt += 1) {
      await adapter.act({
        task: createWatchTask(rule),
        step: {
          id: `mail-open-settle-${rule.id}-${attempt}`,
          label: "Wait for mail thread analysis to settle",
          surface,
          action: "wait",
          params: { ms: attempt === 1 ? 1200 : 1800 }
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
        desktopRequireAccessibility: desktopVisualObserveRequiresAccessibility
      });
      outlookThreadVision = updateLastReliableOutlookThreadVision(await analyzeOutlookDesktopVisualState({
        modelClient: controlPlane?.modelClient,
        worldState: threadState,
        timeoutMs: OUTLOOK_DESKTOP_DETECT_ANALYZE_TIMEOUT_MS
      }).catch((error) => {
        traceOutlookAnalysisError(`post-open-settle-${attempt}`, error);
        return null;
      }));
      traceOutlookThreadState(`post-open-settle-${attempt}`, {
        vision: outlookThreadVision,
        targetThread: openTarget,
        targetCue: openThreadCue,
        previousOpenThread,
        openAttempts
      });
    }
  }

  if (surface === "desktop") {
    for (
      let attempt = 1;
      attempt <= 3
      && !hasAvailableOutlookComposer(outlookThreadVision, threadState)
      && !hasThreadSelectionAdvanced(outlookThreadVision, threadState);
      attempt += 1
    ) {
      const currentTargetThread = findMatchingOutlookVisibleThread(outlookThreadVision, openTarget, openThreadCue);
      const currentThreadBounds = await resolveDesktopVisionCandidateBounds(
        threadState,
        "Microsoft Outlook",
        currentTargetThread?.approxBox ?? null
      );
      let retryOpenStep = buildOpenStep(
        `mail-open-retry-${rule.id}-${attempt}`,
        "Retry opening mail thread",
        true,
        false
      );
      if (retryOpenStep && rule.livePack === "outlook-desktop") {
        const currentGrounding = await groundOutlookTargetThreadClickPoint({
          modelClient: controlPlane?.modelClient,
          worldState: threadState,
          targetThread: openTarget,
          targetSnippet: openThreadCue
        }).catch(() => null);
        const currentFrame = await resolveDesktopVisionFrame(threadState, "Microsoft Outlook");
        const currentFallbackPoint = boundsCenter(currentThreadBounds);
        const currentOpenPoint =
          resolveOutlookGroundedOpenPoint(currentFrame, currentGrounding, currentFallbackPoint) ?? currentFallbackPoint;
        if (currentOpenPoint) {
          retryOpenStep = {
            id: `mail-open-retry-regrounded-${rule.id}-${attempt}`,
            label: "Retry opening mail thread",
            surface,
            action: "clickAt",
            params: {
              x: currentOpenPoint.x,
              y: currentOpenPoint.y
            }
          };
        }
      }
      if (!retryOpenStep) {
        break;
      }
      const retryTarget =
        currentTargetThread
          ? {
              id: `mail-open-retry-target-${rule.id}-${attempt}`,
              text: String(currentTargetThread.name ?? openTarget).trim() || openTarget,
              role: "text",
              isInteractive: true,
              bounds: currentThreadBounds ?? undefined
            }
          : openCandidate;
      const retryTextStep = buildOutlookTextOpenStep(
        `mail-open-retry-text-${rule.id}-${attempt}`,
        "Retry opening mail thread by visible text",
        attempt,
        retryTarget,
        false
      );
      let executedRetryStep: RuntimeStep = retryOpenStep;
      const preferRetryOpenStep = retryOpenStep.action === "clickAt";
      openAttempts += 1;
      if (preferRetryOpenStep) {
        await adapter.act({
          task: createWatchTask(rule),
          step: retryOpenStep,
          workspace: profileAsWorkspace(rule, workspace),
          traceId: null,
          outputs: {}
        });
        executedRetryStep = retryOpenStep;
      } else if (retryTextStep) {
        try {
          await adapter.act({
            task: createWatchTask(rule),
            step: retryTextStep,
            workspace: profileAsWorkspace(rule, workspace),
            traceId: null,
            outputs: {}
          });
          executedRetryStep = retryTextStep;
        } catch {
          await adapter.act({
            task: createWatchTask(rule),
            step: retryOpenStep,
            workspace: profileAsWorkspace(rule, workspace),
            traceId: null,
            outputs: {}
          });
          executedRetryStep = retryOpenStep;
        }
      } else {
        await adapter.act({
          task: createWatchTask(rule),
          step: retryOpenStep,
          workspace: profileAsWorkspace(rule, workspace),
          traceId: null,
          outputs: {}
        });
        executedRetryStep = retryOpenStep;
      }

      if (surface === "desktop" && rule.livePack === "outlook-desktop" && executedRetryStep.action === "clickAt") {
        await adapter.act({
          task: createWatchTask(rule),
          step: {
            id: `mail-open-retry-focus-wait-${rule.id}-${attempt}`,
            label: "Wait for Outlook retry focus",
            surface,
            action: "wait",
            params: { ms: 150 }
          },
          workspace: profileAsWorkspace(rule, workspace),
          traceId: null,
          outputs: {}
        });
        await adapter.act({
          task: createWatchTask(rule),
          step: {
            id: `mail-open-retry-confirm-${rule.id}-${attempt}`,
            label: "Confirm Outlook retried thread selection",
            surface,
            action: "clickAt",
            params: { ...(executedRetryStep.params ?? {}) }
          },
          workspace: profileAsWorkspace(rule, workspace),
          traceId: null,
          outputs: {}
        });
      }

      await adapter.act({
        task: createWatchTask(rule),
        step: {
          id: `mail-open-retry-wait-${rule.id}-${attempt}`,
          label: "Wait for retried mail thread open",
          surface,
          action: "wait",
          params: {
            ms:
              attempt === 1 ? 900
              : attempt === 2 ? 1300
              : 1700
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
        desktopRequireAccessibility: surface === "desktop" ? desktopVisualObserveRequiresAccessibility : false
      });
      outlookThreadVision = updateLastReliableOutlookThreadVision(await analyzeOutlookDesktopVisualState({
        modelClient: controlPlane?.modelClient,
        worldState: threadState,
        timeoutMs: OUTLOOK_DESKTOP_DETECT_ANALYZE_TIMEOUT_MS
      }).catch((error) => {
        traceOutlookAnalysisError(`post-open-retry-${attempt}`, error);
        return null;
      }));
      traceOutlookThreadState(`post-open-retry-${attempt}`, {
        vision: outlookThreadVision,
        targetThread: openTarget,
        targetCue: openThreadCue,
        previousOpenThread,
        openAttempts
      });
    }
  }

  if (
    surface === "desktop" &&
    !hasAvailableOutlookComposer(outlookThreadVision, threadState) &&
    !hasThreadSelectionAdvanced(outlookThreadVision, threadState) &&
    outlookThreadVision?.scene === "thread"
  ) {
    const recovered = await recoverDesktopVisualSceneToList({
      rule,
      workspace,
      surfaceRegistry,
      controlPlane,
      worldState: threadState,
      vision: {
        ...outlookThreadVision,
        recommendedRecoveryAction: "recover_to_list"
      },
      appName: "Microsoft Outlook",
      focusName: "Focus Outlook",
      recoverLabel: "Recover Outlook to inbox list",
      dismissLabel: "Dismiss Outlook foreign view",
      analyzeState: (candidateState) =>
        analyzeOutlookDesktopVisualState({
          modelClient: controlPlane?.modelClient,
          worldState: candidateState,
          timeoutMs: OUTLOOK_DESKTOP_DETECT_ANALYZE_TIMEOUT_MS
        }),
      resolveRecoveryPoint: (candidateState) =>
        groundOutlookDesktopRecoveryPoint({
          modelClient: controlPlane?.modelClient,
          worldState: candidateState
        })
    }).catch(() => null);

    threadState = recovered?.worldState ?? threadState;
    outlookThreadVision = recovered?.vision ?? outlookThreadVision;
    updateLastReliableOutlookThreadVision(recovered?.vision ?? null);
    traceOutlookThreadState("post-recovery", {
      vision: outlookThreadVision,
      targetThread: openTarget,
      targetCue: openThreadCue,
      previousOpenThread,
      openAttempts
    });

    const reopenStep = buildOpenStep(
      `mail-open-recovered-${rule.id}`,
      "Open mail thread after recovery",
      true,
      true
    );
    if (
      reopenStep &&
      !hasAvailableOutlookComposer(outlookThreadVision, threadState) &&
      !hasThreadSelectionAdvanced(outlookThreadVision, threadState)
    ) {
      openAttempts += 1;
      await adapter.act({
        task: createWatchTask(rule),
        step: reopenStep,
        workspace: profileAsWorkspace(rule, workspace),
        traceId: null,
        outputs: {}
      });

      await adapter.act({
        task: createWatchTask(rule),
        step: {
          id: `mail-open-recovered-wait-${rule.id}`,
          label: "Wait for recovered mail thread to settle",
          surface,
          action: "wait",
          params: { ms: 1200 }
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
        desktopRequireAccessibility: surface === "desktop" ? desktopVisualObserveRequiresAccessibility : false
      });
      outlookThreadVision = updateLastReliableOutlookThreadVision(await analyzeOutlookDesktopVisualState({
        modelClient: controlPlane?.modelClient,
        worldState: threadState,
        timeoutMs: OUTLOOK_DESKTOP_DETECT_ANALYZE_TIMEOUT_MS
      }).catch((error) => {
        traceOutlookAnalysisError("post-recovery-reopen", error);
        return null;
      }));
      traceOutlookThreadState("post-recovery-reopen", {
        vision: outlookThreadVision,
        targetThread: openTarget,
        targetCue: openThreadCue,
        previousOpenThread,
        openAttempts
      });
    }
  }

  if (surface === "desktop" && !hasThreadSelectionAdvanced(outlookThreadVision, threadState)) {
    return threadState;
  }

  if (surface === "desktop" && !hasAvailableOutlookComposer(outlookThreadVision, threadState)) {
    for (let attempt = 1; attempt <= 2 && !hasAvailableOutlookComposer(outlookThreadVision, threadState); attempt += 1) {
      const replyButton = findOutlookReplyButtonCandidate(threadState);
      if (!replyButton?.bounds) {
        break;
      }
      await adapter.act({
        task: createWatchTask(rule),
        step: {
          id: `mail-reply-button-${rule.id}-${attempt}`,
          label: "Open mail reply composer",
          surface,
          action: "clickTarget",
          params: {
            targetQuery: String(replyButton.text ?? "").trim() || "Reply",
            target: replyButton,
            allowBoundsFallback: true
          }
        },
        workspace: profileAsWorkspace(rule, workspace),
        traceId: null,
        outputs: {}
      });

      await adapter.act({
        task: createWatchTask(rule),
        step: {
          id: `mail-reply-wait-${rule.id}-${attempt}`,
          label: "Wait for mail reply composer",
          surface,
          action: "wait",
          params: { ms: attempt === 1 ? 500 : 750 }
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
        desktopRequireAccessibility: surface === "desktop" ? desktopVisualObserveRequiresAccessibility : false
      });
      outlookThreadVision = updateLastReliableOutlookThreadVision(await analyzeOutlookDesktopVisualState({
        modelClient: controlPlane?.modelClient,
        worldState: threadState,
        timeoutMs: OUTLOOK_DESKTOP_DETECT_ANALYZE_TIMEOUT_MS
      }).catch((error) => {
        traceOutlookAnalysisError(`post-reply-open-${attempt}`, error);
        return null;
      }));
      traceOutlookThreadState(`post-reply-open-${attempt}`, {
        vision: outlookThreadVision,
        targetThread: openTarget,
        targetCue: openThreadCue,
        previousOpenThread,
        openAttempts
      });
    }
  }

  if (surface === "desktop" && !hasAvailableOutlookComposer(outlookThreadVision, threadState)) {
    for (let attempt = 1; attempt <= 2 && !hasAvailableOutlookComposer(outlookThreadVision, threadState); attempt += 1) {
      const replyControl = await groundOutlookReplyControl({
        modelClient: controlPlane?.modelClient,
        worldState: threadState,
        timeoutMs: OUTLOOK_DESKTOP_DETECT_ANALYZE_TIMEOUT_MS
      }).catch(() => null);
      if (!replyControl?.bounds) {
        break;
      }

      await adapter.act({
        task: createWatchTask(rule),
        step: {
          id: `mail-reply-vision-${rule.id}-${attempt}`,
          label: "Open mail reply composer",
          surface,
          action: "clickTarget",
          params: {
            targetQuery: String(replyControl.text ?? "").trim() || "Reply",
            target: replyControl,
            allowBoundsFallback: true
          }
        },
        workspace: profileAsWorkspace(rule, workspace),
        traceId: null,
        outputs: {}
      });

      await adapter.act({
        task: createWatchTask(rule),
        step: {
          id: `mail-reply-vision-wait-${rule.id}-${attempt}`,
          label: "Wait for mail reply composer",
          surface,
          action: "wait",
          params: { ms: attempt === 1 ? 600 : 900 }
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
        desktopRequireAccessibility: surface === "desktop" ? desktopVisualObserveRequiresAccessibility : false
      });
      outlookThreadVision = await analyzeOutlookDesktopVisualState({
        modelClient: controlPlane?.modelClient,
        worldState: threadState,
        timeoutMs: OUTLOOK_DESKTOP_DETECT_ANALYZE_TIMEOUT_MS
      }).catch((error) => {
        traceOutlookAnalysisError(`post-reply-vision-${attempt}`, error);
        return null;
      });
    }
  }

  if (
    surface === "desktop" &&
    allowReplyShortcutFallback &&
    desktopReplyShortcut &&
    Boolean(controlPlane?.modelClient?.supportsImageJson?.()) &&
    !hasAvailableOutlookComposer(outlookThreadVision, threadState) &&
    hasCurrentThreadConfirmation(outlookThreadVision, threadState)
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

    await adapter.act({
      task: createWatchTask(rule),
      step: {
        id: `mail-reply-shortcut-wait-${rule.id}`,
        label: "Wait for mail reply composer",
        surface,
        action: "wait",
        params: { ms: 400 }
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
      desktopRequireAccessibility: surface === "desktop" ? desktopVisualObserveRequiresAccessibility : false
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

      const startUrl = String(
        rule.taskInputs?.startUrl ?? rule.taskInputs?.url ?? rule.appTarget ?? defaultBrowserStartUrlForPack(name) ?? ""
      ).trim();
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
        desktopRequireAccessibility: false
      });
    },
    async detectNewItems({ rule, worldState, dedupeState = {}, workspace, surfaceRegistry, controlPlane }) {
      let vision = await analyzeOutlookDesktopVisualState({
        modelClient: controlPlane.modelClient,
        worldState,
        timeoutMs: OUTLOOK_DESKTOP_DETECT_ANALYZE_TIMEOUT_MS
      }).catch(() => null);
      let effectiveWorldState = worldState;
      let recoveryAttempts = 0;
      const shouldRecoverThreadToList =
        Boolean(vision)
        && vision?.scene === "thread"
        && !pickDesktopVisualUnreadThread(vision);
      if (isDesktopRecoveryScene(vision) || shouldRecoverThreadToList) {
        const recovered = await recoverDesktopVisualSceneToList({
          rule,
          workspace,
          surfaceRegistry,
          controlPlane,
          worldState,
          vision:
            shouldRecoverThreadToList && vision
              ? {
                  ...vision,
                  recommendedRecoveryAction: "recover_to_list"
                }
              : vision,
          appName: "Microsoft Outlook",
          focusName: "Focus Outlook",
          recoverLabel: "Recover Outlook to inbox list",
          dismissLabel: "Dismiss Outlook foreign view",
          analyzeState: (candidateState) =>
            analyzeOutlookDesktopVisualState({
              modelClient: controlPlane.modelClient,
              worldState: candidateState,
              timeoutMs: OUTLOOK_DESKTOP_DETECT_ANALYZE_TIMEOUT_MS
            }),
          resolveRecoveryPoint: (candidateState) =>
            groundOutlookDesktopRecoveryPoint({
              modelClient: controlPlane.modelClient,
              worldState: candidateState
            })
        });
        effectiveWorldState = recovered.worldState ?? worldState;
        vision = recovered.vision;
        recoveryAttempts = recovered.recoveryAttempts;
      }
      if (vision && isDesktopRecoveryScene(vision)) {
        return null;
      }
      if (!vision && !findOutlookUnreadCandidate(effectiveWorldState) && !findOutlookComposeCandidate(effectiveWorldState)) {
        const recovered = await recoverOutlookInboxWithoutVision({
          rule,
          workspace,
          surfaceRegistry,
          controlPlane,
          worldState: effectiveWorldState,
          analyzeState: (candidateState) =>
            analyzeOutlookDesktopVisualState({
              modelClient: controlPlane.modelClient,
              worldState: candidateState,
              timeoutMs: OUTLOOK_DESKTOP_DETECT_ANALYZE_TIMEOUT_MS
            })
        });
        if (recovered.recoveryAttempts > 0) {
          effectiveWorldState = recovered.worldState ?? effectiveWorldState;
          vision = recovered.vision;
          recoveryAttempts += recovered.recoveryAttempts;
        }
      }
      let thread = pickDesktopVisualUnreadThread(vision);
      let scrollPasses = 0;
        if (!thread) {
          const scanned = await scanDesktopVisionUnreadConversation({
            rule,
            worldState,
            workspace,
            surfaceRegistry,
            controlPlane,
            initialWorldState: effectiveWorldState,
            initialVision: vision,
            appName: "Microsoft Outlook",
            anchor: { x: 0.3, y: 0.32 },
            scrollDy: -420,
            maxPasses: DESKTOP_VLM_SCROLL_SCAN_MAX_PASSES,
            analyzeState: (candidateState) =>
              analyzeOutlookDesktopVisualState({
                modelClient: controlPlane.modelClient,
                worldState: candidateState,
                timeoutMs: OUTLOOK_DESKTOP_DETECT_ANALYZE_TIMEOUT_MS
              })
          });
          effectiveWorldState = scanned.worldState ?? effectiveWorldState;
          vision = scanned.vision;
          thread = scanned.thread;
          scrollPasses = scanned.scrollPasses;
        }
      const selectedThreadSummary = normalizeMailSummary(String(thread?.name ?? "").trim());
      const openThreadSummary = normalizeMailSummary(String(vision?.openThread ?? "").trim());
      const shouldRecoverSelectedThreadToList =
        Boolean(vision)
        && vision?.scene === "thread"
        && Boolean(selectedThreadSummary)
        && Boolean(openThreadSummary)
        && selectedThreadSummary !== openThreadSummary
        && !thread?.approxBox;
      if (shouldRecoverSelectedThreadToList) {
        const recovered = await recoverDesktopVisualSceneToList({
          rule,
          workspace,
          surfaceRegistry,
          controlPlane,
          worldState: effectiveWorldState,
          vision:
            vision
              ? {
                  ...vision,
                  recommendedRecoveryAction: "recover_to_list"
                }
              : vision,
          appName: "Microsoft Outlook",
          focusName: "Focus Outlook",
          recoverLabel: "Recover Outlook to inbox list",
          dismissLabel: "Dismiss Outlook foreign view",
          analyzeState: (candidateState) =>
            analyzeOutlookDesktopVisualState({
              modelClient: controlPlane.modelClient,
              worldState: candidateState,
              timeoutMs: OUTLOOK_DESKTOP_DETECT_ANALYZE_TIMEOUT_MS
            }),
          resolveRecoveryPoint: (candidateState) =>
            groundOutlookDesktopRecoveryPoint({
              modelClient: controlPlane.modelClient,
              worldState: candidateState
            })
        });
        effectiveWorldState = recovered.worldState ?? effectiveWorldState;
        vision = recovered.vision;
        recoveryAttempts += recovered.recoveryAttempts;
        thread = pickDesktopVisualUnreadThread(vision);
        if (!thread) {
          const rescanned = await scanDesktopVisionUnreadConversation({
            rule,
            worldState,
            workspace,
            surfaceRegistry,
            controlPlane,
            initialWorldState: effectiveWorldState,
            initialVision: vision,
            appName: "Microsoft Outlook",
            anchor: { x: 0.3, y: 0.32 },
            scrollDy: -420,
            maxPasses: DESKTOP_VLM_SCROLL_SCAN_MAX_PASSES,
            analyzeState: (candidateState) =>
              analyzeOutlookDesktopVisualState({
                modelClient: controlPlane.modelClient,
                worldState: candidateState,
                timeoutMs: OUTLOOK_DESKTOP_DETECT_ANALYZE_TIMEOUT_MS
              })
          });
          effectiveWorldState = rescanned.worldState ?? effectiveWorldState;
          vision = rescanned.vision;
          thread = rescanned.thread;
          scrollPasses += rescanned.scrollPasses;
        }
      }
      if (vision && thread) {
        const openTarget = normalizeMailSummary(thread.name);
        if (!openTarget || isOutlookUiChrome(openTarget)) {
          return null;
        }

        const outlookVisionFrame = await resolveDesktopVisionFrame(effectiveWorldState, "Microsoft Outlook");
        const groundedTarget = await groundOutlookTargetThreadClickPoint({
          modelClient: controlPlane.modelClient,
          worldState: effectiveWorldState,
          targetThread: openTarget,
          targetSnippet: String(thread.subjectCue ?? thread.latestSnippet ?? "").trim() || null
        }).catch(() => null);
        const originalThreadBounds = await resolveDesktopVisionCandidateBounds(
          effectiveWorldState,
          "Microsoft Outlook",
          thread.approxBox
        );
        const groundedThreadBounds = await resolveDesktopVisionCandidateBounds(
          effectiveWorldState,
          "Microsoft Outlook",
          groundedTarget?.targetVisible && groundedTarget.rowBox ? groundedTarget.rowBox : null
        );
        const threadBounds =
          groundedThreadBounds ?? originalThreadBounds;
        if (!threadBounds) {
          return null;
        }
        const fallbackOpenPoint = boundsCenter(threadBounds);
        const openPoint =
          resolveOutlookGroundedOpenPoint(outlookVisionFrame, groundedTarget, fallbackOpenPoint) ?? fallbackOpenPoint;
        if (!openPoint) {
          return null;
        }
        const openCandidateBounds = threadBounds;

        const context = uniqueStrings([
          String(thread.subjectCue ?? "").trim(),
          String(thread.latestSnippet ?? "").trim(),
          String(thread.replyReason ?? "").trim(),
          ...contextForSignal(effectiveWorldState, { text: openTarget })
        ]).slice(0, 4);
        const itemFingerprint = fingerprint(`outlook-desktop:${rule.workspaceName ?? "default"}:${openTarget}:${context.join("|")}`);
        if (dedupeState.lastFingerprint === itemFingerprint) {
          return null;
        }

        return {
          fingerprint: itemFingerprint,
          summary: openTarget,
          text: openTarget,
          context,
          inputs: {
            watchItemText: openTarget,
            watchSummary: openTarget,
            watchContext: context.join("\n"),
            openTarget,
            threadTitle: openTarget,
            openCandidate: {
              id: "outlook-vision-unread",
              text: openTarget,
              role: "text",
              isInteractive: true,
              bounds: openCandidateBounds
            },
            openX: openPoint.x,
            openY: openPoint.y,
            replyTargetQuery: "Reply"
          },
          metadata: {
            visualAnalysis: vision,
            visualThread: thread,
            recoveryAttempts,
            openPoint,
            scrollPasses,
            ...(groundedTarget ? { threadGrounding: groundedTarget } : {}),
            openCandidate: {
              id: "outlook-vision-unread",
              text: openTarget,
              role: "text",
              isInteractive: true,
              bounds: openCandidateBounds
            },
            ...buildConversationMetadata({
              packName: "outlook-desktop",
              surface: "desktop",
              summary: openTarget,
              context,
              openTarget,
              candidate: {
                id: "outlook-vision-unread",
                text: openTarget,
                role: "text",
                isInteractive: true,
                bounds: openCandidateBounds
              } as InteractionCandidate
            })
          },
          taskSpec: {
            preferredSurface: "desktop",
            steps: buildOutlookDesktopVisualReplySteps()
          }
        };
      }

      if (vision) {
        return null;
      }

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
    async extractContext({ rule, workspace, surfaceRegistry, detection, controlPlane, worldState }) {
      const summary = String(detection.summary ?? "").trim();
      const detectedOpenTarget = String(detection.inputs?.openTarget ?? summary).trim() || summary;
      const detectedThreadCue = String(
        (detection.metadata?.visualThread as { subjectCue?: unknown; latestSnippet?: unknown } | null)?.subjectCue
        ?? (detection.metadata?.visualThread as { subjectCue?: unknown; latestSnippet?: unknown } | null)?.latestSnippet
        ?? detection.context?.[0]
        ?? ""
      ).trim() || null;
      const previousOpenThread = String(
        (detection.metadata?.visualAnalysis as { openThread?: unknown } | null)?.openThread ?? ""
      ).trim() || null;
      let threadState = await openMailThreadForContext({
        rule,
        workspace,
        surfaceRegistry,
        controlPlane,
        worldState,
        detection,
        surface: "desktop",
        allowReplyShortcutFallback: true,
        desktopReplyShortcut: {
          key: "r",
          modifiers: ["cmd"]
        }
      });
      let composeCandidate = findOutlookComposeCandidate(threadState);
      let sendCandidate = findOutlookSendCandidate(threadState);
      let visualThreadState = reconcileOutlookVisualDraftState(
        threadState,
        await analyzeOutlookDesktopVisualState({
          modelClient: controlPlane.modelClient,
          worldState: threadState,
          timeoutMs: OUTLOOK_DESKTOP_DETECT_ANALYZE_TIMEOUT_MS
        }).catch(() => null)
      );
      const visualThreadConfirmed = () =>
        isOutlookThreadOpenForTarget(
          visualThreadState,
          detectedOpenTarget,
          detectedThreadCue
        ) || didOutlookThreadSelectionAdvanceFromState({
          worldState: threadState,
          targetThread: detectedOpenTarget,
          targetCue: detectedThreadCue,
          previousOpenThread
        });
      if (visualThreadState && (visualThreadState.scene !== "thread" || !visualThreadState.composer.present)) {
        composeCandidate = null;
      }
      if (visualThreadState && !visualThreadConfirmed()) {
        composeCandidate = null;
      }
      if (visualThreadState?.composer.present && visualThreadState.composer.hasDraftText === true) {
        return null;
      }
      const adapter = surfaceRegistry.get("desktop");
      if (
        adapter &&
        threadState &&
        !composeCandidate &&
        !visualThreadState?.composer.present &&
        visualThreadState?.scene === "thread"
      ) {
        for (let attempt = 1; attempt <= 5 && !composeCandidate && !visualThreadState?.composer.present; attempt += 1) {
          await adapter.act({
            task: createWatchTask(rule),
            step: {
              id: `outlook-compose-settle-${rule.id}-${attempt}`,
              label: "Wait for Outlook composer to appear",
              surface: "desktop",
              action: "wait",
              params: {
                ms:
                  attempt === 1 ? 700
                  : attempt === 2 ? 900
                  : attempt === 3 ? 1200
                  : attempt === 4 ? 1500
                  : 1800
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
            surface: "desktop",
            desktopRequireAccessibility: false
          });
          composeCandidate = findOutlookComposeCandidate(threadState);
          sendCandidate = findOutlookSendCandidate(threadState);
          visualThreadState = reconcileOutlookVisualDraftState(
            threadState,
            await analyzeOutlookDesktopVisualState({
              modelClient: controlPlane.modelClient,
              worldState: threadState,
              timeoutMs: OUTLOOK_DESKTOP_DETECT_ANALYZE_TIMEOUT_MS
            }).catch(() => null)
          );
          if (visualThreadState && (visualThreadState.scene !== "thread" || !visualThreadState.composer.present)) {
            composeCandidate = null;
          }
          if (visualThreadState && !visualThreadConfirmed()) {
            composeCandidate = null;
          }
          if (visualThreadState?.composer.present && visualThreadState.composer.hasDraftText === true) {
            return null;
          }
        }
      }
      const threadVerifyTarget = String(
        visualThreadState?.openThread ?? detection.inputs?.openTarget ?? summary
      ).trim() || summary;
      if (visualThreadState?.scene === "thread" && visualThreadState.composer.present && visualThreadConfirmed()) {
        const composeBodyPoint = deriveOutlookComposerBodyPoint({
          approxBox: visualThreadState.composer.approxBox,
          entryPoint: visualThreadState.composer.entryPoint
        });
        const rawComposeBounds = await resolveDesktopVisionCandidateBounds(
          threadState,
          "Microsoft Outlook",
          visualThreadState.composer.approxBox
        );
        const composeBodyBounds = deriveOutlookComposerBodyBounds(rawComposeBounds);
        const composeBounds =
          composeBodyBounds
          ?? rawComposeBounds
          ?? buildDesktopPointBounds(
            threadState,
            "Microsoft Outlook",
            composeBodyPoint,
            24
          );
        const composeVerifyRegion =
          buildDesktopNormalizedRegionFromBounds(
            threadState,
            "Microsoft Outlook",
            composeBodyBounds ?? composeBounds
          )
          ?? deriveOutlookComposerVerifyRegionFromVisual(visualThreadState.composer);
        if (composeBounds) {
          const context = extractOutlookThreadContext(threadState, summary);
          const openTarget = detectedOpenTarget;
          const openCandidate = (detection.metadata?.openCandidate ?? null) as InteractionCandidate | Record<string, unknown> | null;
          const sendCandidate = findOutlookSendCandidate(threadState);
          return {
            summary,
            context,
            inputs: {
              ...(detection.inputs ?? {}),
              watchContext: context.join("\n"),
              openTarget,
              threadTitle: openTarget,
              threadVerifyTarget,
              openCandidate,
              composeTarget: {
                id: "outlook-vision-composer",
                text: visualThreadState.composer.evidence || "Outlook reply body",
                role: "textbox",
                isInteractive: true,
                bounds: composeBounds
              },
              composeVerifyRegion,
              typeTarget: visualThreadState.composer.evidence || "Outlook reply body",
              sendTarget: pickOutlookSendQuery(threadState),
              sendTargetCandidate: sendCandidate,
              sendTargetQuery: pickOutlookSendQuery(threadState)
            },
            metadata: {
              ...(detection.metadata ?? {}),
              visualThreadState,
              ...buildConversationMetadata({
                packName: "outlook-desktop",
                surface: "desktop",
                summary,
                context,
                openTarget,
                candidate: openCandidate
              })
            },
            taskSpec: {
              preferredSurface: "desktop",
              steps: buildOutlookDesktopComposePrefillSteps()
            }
          };
        }
      }

      if (composeCandidate) {
        const composeTarget =
          deriveOutlookComposerBodyBounds(composeCandidate.bounds)
            ? {
                ...composeCandidate,
                bounds: deriveOutlookComposerBodyBounds(composeCandidate.bounds) ?? composeCandidate.bounds
              }
            : composeCandidate;
        const composeVerifyRegion = buildDesktopNormalizedRegionFromBounds(
          threadState,
          "Microsoft Outlook",
          composeTarget.bounds
        );
        const context = extractOutlookThreadContext(threadState, summary);
        const openTarget = detectedOpenTarget;
        const openCandidate = (detection.metadata?.openCandidate ?? null) as InteractionCandidate | Record<string, unknown> | null;
        return {
          summary,
          context,
          inputs: {
            ...(detection.inputs ?? {}),
            watchContext: context.join("\n"),
            openTarget,
            threadTitle: openTarget,
            threadVerifyTarget,
            openCandidate,
            composeTarget,
            composeVerifyRegion,
            typeTarget: pickOutlookComposeQuery(threadState),
            sendTarget: pickOutlookSendQuery(threadState),
            sendTargetCandidate: sendCandidate,
            sendTargetQuery: pickOutlookSendQuery(threadState)
          },
          metadata: {
            ...(detection.metadata ?? {}),
            ...buildConversationMetadata({
              packName: "outlook-desktop",
              surface: "desktop",
              summary,
              context,
              openTarget,
              candidate: openCandidate
            })
          },
          taskSpec: {
            preferredSurface: "desktop",
            steps: buildOutlookDesktopComposePrefillSteps()
          }
        };
      }

      if (!composeCandidate) {
        return null;
      }
      const context = extractOutlookThreadContext(threadState, summary);
      const openTarget = detectedOpenTarget;
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
        taskSpec: undefined
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

      const startUrl = String(
        rule.taskInputs?.startUrl ?? rule.taskInputs?.url ?? rule.appTarget ?? defaultBrowserStartUrlForPack("boss-browser") ?? ""
      ).trim();
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
