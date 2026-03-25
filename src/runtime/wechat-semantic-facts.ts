import type { AgentModelClient } from "./model-client.js";
import { inferReplyLanguage, type ReplyLanguageHint } from "./reply-language.js";
import type { WorldState } from "../types/runtime-schema.js";

export interface WeChatSemanticFacts {
  latestInboundMessage: string | null;
  salientContext: string[];
  senderName: string | null;
  speakerRole: "sender" | "recipient" | "unknown";
  threadSummary: string | null;
  replyLanguageHint: ReplyLanguageHint;
  source: "model" | "heuristic" | "vision";
  evidence: string;
}

export type WeChatSemanticModelClient =
  Pick<AgentModelClient, "isConfigured" | "completeJson"> | null | undefined;

const SEND_PATTERN = /(send|reply|submit|发送|回复|提交)/iu;
const WECHAT_UI_CHROME_PATTERN =
  /^(wechat|微信|最近聊天|聊天|通讯录|发现|我|contacts|moments|official accounts|订阅号|服务号|输入消息|请输入消息|message|messages|send|发送|回复|reply|表情|emoji|文件|图片|视频|语音|聊天信息|新消息|未读)$/iu;
const WECHAT_TIMESTAMP_PATTERN =
  /^(?:(?:昨天|前天|刚刚|上午|下午|晚上|中午)|(?:[01]?\d|2[0-3]):[0-5]\d(?:[:：][0-5]\d)?|\d{1,4}[\/.-]\d{1,2}(?:[\/.-]\d{1,4})?)$/u;

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

function collectVisibleLines(worldState: WorldState | null): string[] {
  const lines: string[] = [];

  for (const candidate of Array.isArray(worldState?.interactionCandidates) ? worldState.interactionCandidates : []) {
    const text = String(candidate?.text ?? "").trim();
    if (text) {
      lines.push(text);
    }
  }

  for (const block of Array.isArray(worldState?.ocrBlocks) ? worldState.ocrBlocks : []) {
    const text = String((block as { text?: unknown } | null)?.text ?? "").trim();
    if (text) {
      lines.push(text);
    }
  }

  for (const line of String(worldState?.visibleText ?? "").split("\n")) {
    const text = String(line ?? "").trim();
    if (text) {
      lines.push(text);
    }
  }

  return uniqueStrings(lines).slice(0, 120);
}

export function normalizeWeChatSummary(value: string): string {
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

function looksLikeWeChatBodyLine(text: string): boolean {
  const normalized = String(text ?? "").trim();
  if (!normalized || isWeChatUiChrome(normalized) || SEND_PATTERN.test(normalized) || WECHAT_TIMESTAMP_PATTERN.test(normalized)) {
    return false;
  }
  if (!/[\u4e00-\u9fffA-Za-z0-9]/u.test(normalized)) {
    return false;
  }
  return Array.from(normalized).length >= 2;
}

function extractWeChatSpeakerLabel(text: string): string | null {
  const normalized = String(text ?? "").trim();
  const match = normalized.match(/^([^:：]{1,24})\s*[:：]\s*\S/u);
  const candidate = match?.[1]?.trim() ?? "";
  if (!candidate) {
    return null;
  }
  if (/^(微信|wechat|消息|发送|回复|message|send|reply)$/iu.test(candidate)) {
    return null;
  }
  return candidate;
}

function normalizeWeChatSpeakerName(value: string | null | undefined): string | null {
  const normalized = normalizeWeChatSummary(String(value ?? ""));
  return normalized || null;
}

function isGenericWeChatSenderLabel(label: string | null | undefined): boolean {
  return /^(客户|对方|好友|朋友|联系人|contact|customer|sender)$/iu.test(String(label ?? "").trim());
}

function isWeChatRecipientSpeaker(label: string | null | undefined): boolean {
  return /^(me|我|本人|自己|agentos|assistant|你)$/iu.test(String(label ?? "").trim());
}

function canonicalizeWeChatSemanticLine(line: string, sourceLines: string[]): string | null {
  const normalized = normalizeWeChatSummary(line);
  if (!normalized) {
    return null;
  }

  const exact = sourceLines.find((entry) => normalizeWeChatSummary(entry) === normalized);
  if (exact) {
    return exact.trim();
  }

  const fuzzy = sourceLines.find((entry) => {
    const candidate = normalizeWeChatSummary(entry);
    return candidate && (candidate.includes(normalized) || normalized.includes(candidate));
  });
  return fuzzy?.trim() ?? null;
}

function resolveWeChatConversationWindow(
  worldState: WorldState | null,
  {
    summary,
    trailingWindow = 16
  }: {
    summary: string;
    trailingWindow?: number;
  }
): string[] {
  const lines = collectVisibleLines(worldState).filter(
    (line) => !isWeChatUiChrome(line) && !WECHAT_TIMESTAMP_PATTERN.test(String(line ?? "").trim())
  );
  const normalizedSummary = normalizeWeChatSummary(summary);
  const anchorIndex = lines.findIndex((line) => {
    const normalized = normalizeWeChatSummary(line);
    return Boolean(normalized) && normalized === normalizedSummary;
  });
  const pool = anchorIndex === -1 ? lines : lines.slice(anchorIndex + 1, anchorIndex + 1 + trailingWindow);
  return uniqueStrings(pool);
}

function fallbackWeChatSemanticFacts({
  worldState,
  summary,
  threadSummary = null,
  preferredLatestSnippet = null,
  replyReason = null
}: {
  worldState: WorldState | null;
  summary: string;
  threadSummary?: string | null;
  preferredLatestSnippet?: string | null;
  replyReason?: string | null;
}): WeChatSemanticFacts {
  const visibleConversationLines = resolveWeChatConversationWindow(worldState, { summary });
  const normalizedSummary = normalizeWeChatSummary(summary);
  const resolvedThreadSummary = normalizeWeChatSummary(String(threadSummary ?? summary)) || null;
  const conversationLines = visibleConversationLines.filter((line) => {
    const normalized = normalizeWeChatSummary(line);
    return normalized && normalized !== normalizedSummary && normalized !== resolvedThreadSummary && looksLikeWeChatBodyLine(line);
  });

  const preferredCanonical =
    canonicalizeWeChatSemanticLine(String(preferredLatestSnippet ?? ""), visibleConversationLines)
    ?? (String(preferredLatestSnippet ?? "").trim() || null);
  const preferredLabel = extractWeChatSpeakerLabel(preferredCanonical);
  const preferredRole =
    preferredLabel == null
      ? "unknown"
      : isWeChatRecipientSpeaker(preferredLabel)
        ? "recipient"
        : "sender";
  const recentConversationLines = [...conversationLines].reverse();
  const latestInboundMessage =
    preferredCanonical && preferredRole !== "recipient" && looksLikeWeChatBodyLine(preferredCanonical)
      ? preferredCanonical
      : (recentConversationLines.find((line) => {
          const label = extractWeChatSpeakerLabel(line);
          return label == null || !isWeChatRecipientSpeaker(label);
        }) ?? null);
  const latestSpeakerLabel = extractWeChatSpeakerLabel(latestInboundMessage);
  const salientContext = uniqueStrings([
    latestInboundMessage,
    ...recentConversationLines.filter((line) => {
      const label = extractWeChatSpeakerLabel(line);
      return label == null || !isWeChatRecipientSpeaker(label);
    }),
    String(replyReason ?? "").trim()
  ]).filter(Boolean).slice(0, 6);

  return {
    latestInboundMessage,
    salientContext,
    senderName: (
      latestSpeakerLabel && !isGenericWeChatSenderLabel(latestSpeakerLabel)
        ? normalizeWeChatSpeakerName(latestSpeakerLabel)
        : null
    )
      ?? normalizeWeChatSpeakerName(resolvedThreadSummary)
      ?? null,
    speakerRole:
      latestInboundMessage == null
        ? "unknown"
        : latestSpeakerLabel == null
          ? "sender"
          : isWeChatRecipientSpeaker(latestSpeakerLabel)
            ? "recipient"
            : "sender",
    threadSummary: resolvedThreadSummary,
    replyLanguageHint: inferReplyLanguage({ summary, context: salientContext }),
    source: preferredCanonical ? "vision" : "heuristic",
    evidence: preferredCanonical ? "vision latest snippet with heuristic context fallback" : "heuristic context extraction"
  };
}

export async function inferWeChatSemanticFacts({
  modelClient,
  worldState,
  summary,
  preferredLatestSnippet = null,
  threadSummary = null,
  replyReason = null
}: {
  modelClient: WeChatSemanticModelClient;
  worldState: WorldState | null;
  summary: string;
  preferredLatestSnippet?: string | null;
  threadSummary?: string | null;
  replyReason?: string | null;
}): Promise<WeChatSemanticFacts> {
  const fallback = fallbackWeChatSemanticFacts({
    worldState,
    summary,
    preferredLatestSnippet,
    threadSummary,
    replyReason
  });

  if (!modelClient?.isConfigured?.() || typeof modelClient.completeJson !== "function") {
    return fallback;
  }

  const visibleConversationLines = resolveWeChatConversationWindow(worldState, { summary })
    .map((line) => String(line ?? "").trim())
    .filter(Boolean)
    .slice(0, 18);
  if (!visibleConversationLines.length) {
    return fallback;
  }

  try {
    const result = await modelClient.completeJson<
      {
        summary: string;
        threadSummary: string | null;
        preferredLatestSnippet: string | null;
        replyReason: string | null;
        visibleConversationLines: string[];
        heuristicContext: string[];
        heuristicSenderName: string | null;
      },
      {
        latestInboundMessage: string | null;
        salientContext: string[];
        senderName: string | null;
        speakerRole: "sender" | "recipient" | "unknown";
        threadSummary: string | null;
        evidence: string | null;
      }
    >({
      schemaName: "agentos_wechat_semantic_facts",
      schema: {
        type: "object",
        properties: {
          latestInboundMessage: { type: ["string", "null"] },
          salientContext: { type: "array", items: { type: "string" } },
          senderName: { type: ["string", "null"] },
          speakerRole: { type: "string", enum: ["sender", "recipient", "unknown"] },
          threadSummary: { type: ["string", "null"] },
          evidence: { type: ["string", "null"] }
        },
        required: ["latestInboundMessage", "salientContext", "senderName", "speakerRole", "threadSummary", "evidence"],
        additionalProperties: false
      },
      systemPrompt: [
        "You extract semantic conversation facts for AgentOS from WeChat thread text.",
        "Use only the supplied visibleConversationLines. Do not invent or rewrite lines.",
        "Ignore WeChat chrome, navigation, timestamps, unread badges, and composer placeholders.",
        "latestInboundMessage must be the latest visible message from the other side that AgentOS should reply to.",
        "salientContext should contain up to 4 exact visible lines that preserve that inbound request.",
        "senderName should be the other participant when visible, otherwise null.",
        "speakerRole should describe who wrote latestInboundMessage relative to AgentOS: sender, recipient, or unknown.",
        "threadSummary should be the visible chat title when present.",
        "Return strict JSON only."
      ].join(" "),
      userPayload: {
        summary,
        threadSummary,
        preferredLatestSnippet,
        replyReason,
        visibleConversationLines,
        heuristicContext: fallback.salientContext,
        heuristicSenderName: fallback.senderName
      },
      temperature: 0
    });

    const latestInboundMessage = canonicalizeWeChatSemanticLine(String(result.latestInboundMessage ?? ""), visibleConversationLines);
    const salientContext = uniqueStrings(
      (Array.isArray(result.salientContext) ? result.salientContext : [])
        .map((line) => canonicalizeWeChatSemanticLine(String(line ?? ""), visibleConversationLines))
        .filter((line): line is string => Boolean(line))
    ).slice(0, 6);
    const normalizedThreadSummary = normalizeWeChatSummary(String(result.threadSummary ?? threadSummary ?? summary)) || fallback.threadSummary;
    const normalizedSenderName = normalizeWeChatSpeakerName(result.senderName) ?? fallback.senderName;

    if (!latestInboundMessage && !salientContext.length) {
      return fallback;
    }

    const effectiveContext = uniqueStrings([
      latestInboundMessage,
      ...salientContext,
      ...fallback.salientContext
    ]).filter(Boolean).slice(0, 6);

    return {
      latestInboundMessage: latestInboundMessage ?? fallback.latestInboundMessage,
      salientContext: effectiveContext,
      senderName: normalizedSenderName,
      speakerRole: result.speakerRole ?? fallback.speakerRole,
      threadSummary: normalizedThreadSummary,
      replyLanguageHint: inferReplyLanguage({ summary, context: effectiveContext }),
      source: "model",
      evidence: String(result.evidence ?? "").trim() || "model semantic conversation facts"
    };
  } catch {
    return fallback;
  }
}
