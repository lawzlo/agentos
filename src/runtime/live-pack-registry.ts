import crypto from "node:crypto";
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
  if (appName.includes("slack")) {
    return true;
  }

  const windows = Array.isArray(appContext.windows) ? (appContext.windows as Array<Record<string, unknown>>) : [];
  return windows.some((windowInfo) =>
    String(windowInfo?.title ?? windowInfo?.windowName ?? "").toLowerCase().includes("slack")
  );
}

function isWeChatDesktopForeground(worldState: WorldState | null): boolean {
  if (!worldState || worldState.surface !== "desktop") {
    return true;
  }

  const appContext = (worldState.appContext ?? {}) as Record<string, unknown>;
  const appName = String(appContext.appName ?? "").trim().toLowerCase();
  if (appName.includes("wechat") || appName.includes("微信")) {
    return true;
  }

  const windows = Array.isArray(appContext.windows) ? (appContext.windows as Array<Record<string, unknown>>) : [];
  return windows.some((windowInfo) =>
    String(windowInfo?.title ?? windowInfo?.windowName ?? "").toLowerCase().match(/wechat|微信/u)
  );
}

function isOutlookDesktopForeground(worldState: WorldState | null): boolean {
  if (!worldState || worldState.surface !== "desktop") {
    return true;
  }

  const appContext = (worldState.appContext ?? {}) as Record<string, unknown>;
  const appName = String(appContext.appName ?? "").trim().toLowerCase();
  if (appName.includes("outlook")) {
    return true;
  }

  const windows = Array.isArray(appContext.windows) ? (appContext.windows as Array<Record<string, unknown>>) : [];
  return windows.some((windowInfo) =>
    String(windowInfo?.title ?? windowInfo?.windowName ?? "").toLowerCase().includes("outlook")
  );
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
  if (candidate.role === "row") {
    score += 6;
  }
  if (String((candidate.sourceHints ?? {}).source ?? "").toLowerCase() === "accessibility") {
    score += 12;
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
  const candidates = conversationCandidates(worldState, {
    desktopRequiresAccessibility: worldState?.surface === "desktop"
  });
  const ranked = candidates
    .map((candidate) => ({ candidate, score: scoreWeChatCandidate({ candidate, worldState }) }))
    .filter((entry): entry is { candidate: InteractionCandidate; score: number } => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score);
  return ranked[0]?.candidate ?? null;
}

function findWeChatComposeCandidate(worldState: WorldState | null): InteractionCandidate | null {
  const candidates = conversationCandidates(worldState, {
    desktopRequiresAccessibility: worldState?.surface === "desktop"
  });
  return (
    candidates.find((candidate) => {
      const hintText = candidateHintText(candidate);
      return (
        candidate.role === "textbox" ||
        /(message|reply|input|chat|消息|回复|输入|请输入)/iu.test(hintText) ||
        /(message|reply|input|chat|消息|回复|输入|请输入)/iu.test(candidate.text)
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
  const candidates = conversationCandidates(worldState, {
    desktopRequiresAccessibility: worldState?.surface === "desktop"
  });
  return (
    candidates.find((candidate) => {
      const hintText = candidateHintText(candidate);
      return candidate.role === "button" && (SEND_PATTERN.test(hintText) || SEND_PATTERN.test(candidate.text));
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
  surface
}: LivePackObserveArgs & { surface: LivePackSurface }): Promise<WorldState | null> {
  const adapter = surfaceRegistry.get(surface);
  if (!adapter) {
    return null;
  }

  if (surface === "desktop" && rule.appTarget) {
    const watchTask = createWatchTask(rule);
    const watchWorkspace = profileAsWorkspace(rule, workspace);
    const focusStep = {
      id: `watch-refocus-${rule.id}`,
      action: "focusApp",
      surface,
      params: { name: rule.appTarget }
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
      return observeWatchSurface({ ...args, surface });
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
      return observeWatchSurface({ ...args, surface: "desktop" });
    },
    async detectNewItems({ rule, worldState, dedupeState = {} }) {
      if (!isWeChatDesktopForeground(worldState)) {
        return null;
      }

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
        metadata: buildConversationMetadata({
          packName: "wechat-desktop",
          surface: "desktop",
          summary,
          context,
          openTarget: String(candidate.text ?? summary).trim() || summary,
          candidate
        })
      };
    },
    async extractContext({ rule, workspace, surfaceRegistry, detection }) {
      const adapter = surfaceRegistry.get("desktop");
      if (!adapter) {
        return null;
      }

      const candidateOpenTarget = String(detection.inputs?.openTarget ?? detection.summary ?? "").trim();
      if (candidateOpenTarget) {
        const openCandidate = (detection.metadata?.openCandidate ?? null) as Record<string, unknown> | null;
        await adapter.act({
          task: createWatchTask(rule),
          step: {
            id: `wechat-open-${rule.id}`,
            label: "Open WeChat conversation",
            surface: "desktop",
            action: "clickTarget",
            params: {
              targetQuery: candidateOpenTarget,
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
      if (!findWeChatComposeCandidate(threadState)) {
        return null;
      }
      const summary = String(detection.summary ?? "").trim();
      const context = extractWeChatThreadContext(threadState, summary);
      const openTarget = String(detection.inputs?.openTarget ?? summary).trim() || summary;
      return {
        summary,
        context,
        inputs: {
          ...(detection.inputs ?? {}),
          watchContext: context.join("\n"),
          openTarget,
          typeTarget: pickWeChatComposeQuery(threadState),
          sendTarget: pickWeChatSendQuery(threadState)
        },
        metadata: {
          ...(detection.metadata ?? {}),
          ...buildConversationMetadata({
            packName: "wechat-desktop",
            surface: "desktop",
            summary,
            context,
            openTarget,
            candidate: (detection.metadata?.openCandidate ?? null) as InteractionCandidate | Record<string, unknown> | null
          })
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
      return observeWatchSurface({ ...args, surface });
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
      return observeWatchSurface({ ...args, surface: "desktop" });
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
        surface: "desktop"
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
          steps: buildMailReplySteps("desktop")
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
