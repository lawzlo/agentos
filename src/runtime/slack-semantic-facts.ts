import type { AgentModelClient } from "./model-client.js";
import { inferReplyLanguage, type ReplyLanguageHint } from "./reply-language.js";
import type { WorldState } from "../types/runtime-schema.js";

export interface SlackSemanticFacts {
  latestInboundMessage: string | null;
  salientContext: string[];
  senderName: string | null;
  speakerRole: "sender" | "recipient" | "unknown";
  threadSummary: string | null;
  replyLanguageHint: ReplyLanguageHint;
  source: "model" | "heuristic" | "vision";
  evidence: string;
}

export type SlackSemanticModelClient =
  Pick<AgentModelClient, "isConfigured" | "completeJson"> | null | undefined;

const SEND_PATTERN = /(send|reply|submit|发送|回复|提交)/iu;
const SLACK_UI_CHROME_PATTERN =
  /^(slack|threads?|drafts?\s*&\s*sent|later|more|saved items|activity|home|messages?|channels?|direct messages?|apps|search|compose|reply|send|message|channel browser|slack test workspace|未读|新消息|发送|回复|消息)$/iu;
const SLACK_NAVIGATION_PATTERN =
  /^(all unreads?|unreads?|mentions?|drafts?|sent|threads?|later|activity|saved|more|people|huddles?|canvas|canvases|home)$/iu;

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

export function normalizeSlackSummary(value: string): string {
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

function looksLikeSlackMessageLine(text: string): boolean {
  const normalized = String(text ?? "").trim();
  if (!normalized || isSlackUiChrome(normalized) || SEND_PATTERN.test(normalized)) {
    return false;
  }
  if (/^(conversation|thread|selected)\s*[:：]/iu.test(normalized)) {
    return false;
  }
  if (!/[\u4e00-\u9fffA-Za-z0-9]/u.test(normalized)) {
    return false;
  }
  return Array.from(normalized).length >= 3;
}

function extractSlackSpeakerLabel(text: string): string | null {
  const normalized = String(text ?? "").trim();
  const match = normalized.match(/^([^:：]{1,40})\s*[:：]\s*\S/u);
  const candidate = match?.[1]?.trim() ?? "";
  if (!candidate) {
    return null;
  }
  if (/^(conversation|thread|selected|message|reply|send|slack)$/iu.test(candidate)) {
    return null;
  }
  return candidate;
}

function normalizeSlackSpeakerName(label: string | null | undefined): string | null {
  const normalized = String(label ?? "").trim();
  if (!normalized) {
    return null;
  }
  return normalized;
}

function isSlackRecipientSpeaker(label: string | null | undefined): boolean {
  return /^(me|you|agentos|assistant|teammate|coworker|colleague|recruiter|招聘方)$/iu.test(String(label ?? "").trim());
}

function canonicalizeSlackSemanticLine(line: string, sourceLines: string[]): string | null {
  const normalized = normalizeSlackSummary(line);
  if (!normalized) {
    return null;
  }

  const exact = sourceLines.find((entry) => normalizeSlackSummary(entry) === normalized);
  if (exact) {
    return exact.trim();
  }

  const fuzzy = sourceLines.find((entry) => {
    const candidate = normalizeSlackSummary(entry);
    return candidate && (candidate.includes(normalized) || normalized.includes(candidate));
  });
  return fuzzy?.trim() ?? null;
}

function resolveSlackConversationWindow(
  worldState: WorldState | null,
  {
    summary,
    trailingWindow = 12
  }: {
    summary: string;
    trailingWindow?: number;
  }
): string[] {
  const lines = collectVisibleLines(worldState).filter((line) => !isSlackUiChrome(line));
  const normalizedSummary = normalizeSlackSummary(summary);
  const anchorIndex = lines.findIndex((line) => {
    const normalized = normalizeSlackSummary(line);
    return Boolean(normalized) && normalized === normalizedSummary;
  });
  const pool = anchorIndex === -1 ? lines : lines.slice(anchorIndex, anchorIndex + trailingWindow);
  return uniqueStrings(pool);
}

function fallbackSlackSemanticFacts({
  worldState,
  summary,
  threadSummary = null,
  preferredLatestSnippet = null
}: {
  worldState: WorldState | null;
  summary: string;
  threadSummary?: string | null;
  preferredLatestSnippet?: string | null;
}): SlackSemanticFacts {
  const visibleConversationLines = resolveSlackConversationWindow(worldState, { summary });
  const normalizedSummary = normalizeSlackSummary(summary);
  const resolvedThreadSummary = normalizeSlackSummary(String(threadSummary ?? summary)) || null;
  const conversationLines = visibleConversationLines
    .filter((line) => {
      const normalized = normalizeSlackSummary(line);
      return normalized && normalized !== normalizedSummary && normalized !== resolvedThreadSummary && looksLikeSlackMessageLine(line);
    });

  const preferredCanonical =
    canonicalizeSlackSemanticLine(String(preferredLatestSnippet ?? ""), visibleConversationLines)
    ?? (String(preferredLatestSnippet ?? "").trim() || null);
  const preferredLabel = extractSlackSpeakerLabel(preferredCanonical);
  const preferredSpeakerRole =
    preferredLabel == null
      ? "unknown"
      : isSlackRecipientSpeaker(preferredLabel)
        ? "recipient"
        : "sender";

  const latestInboundMessage =
    preferredCanonical && preferredSpeakerRole !== "recipient" && looksLikeSlackMessageLine(preferredCanonical)
      ? preferredCanonical
      : ([...conversationLines].reverse().find((line) => {
          const label = extractSlackSpeakerLabel(line);
          return label == null || !isSlackRecipientSpeaker(label);
        }) ?? null);
  const latestSpeakerLabel = extractSlackSpeakerLabel(latestInboundMessage);
  const salientContext = uniqueStrings([
    latestInboundMessage,
    ...conversationLines.filter((line) => {
      const label = extractSlackSpeakerLabel(line);
      return label == null || !isSlackRecipientSpeaker(label);
    })
  ]).filter(Boolean).slice(0, 6);

  return {
    latestInboundMessage,
    salientContext,
    senderName:
      normalizeSlackSpeakerName(latestSpeakerLabel)
      ?? normalizeSlackSpeakerName(extractSlackSpeakerLabel(preferredCanonical))
      ?? null,
    speakerRole:
      latestInboundMessage == null
        ? "unknown"
        : latestSpeakerLabel == null
          ? "sender"
          : isSlackRecipientSpeaker(latestSpeakerLabel)
            ? "recipient"
            : "sender",
    threadSummary: resolvedThreadSummary,
    replyLanguageHint: inferReplyLanguage({ summary, context: salientContext }),
    source: preferredCanonical ? "vision" : "heuristic",
    evidence: preferredCanonical ? "vision latest snippet with heuristic context fallback" : "heuristic context extraction"
  };
}

export async function inferSlackSemanticFacts({
  modelClient,
  worldState,
  summary,
  preferredLatestSnippet = null,
  threadSummary = null
}: {
  modelClient: SlackSemanticModelClient;
  worldState: WorldState | null;
  summary: string;
  preferredLatestSnippet?: string | null;
  threadSummary?: string | null;
}): Promise<SlackSemanticFacts> {
  const fallback = fallbackSlackSemanticFacts({
    worldState,
    summary,
    preferredLatestSnippet,
    threadSummary
  });

  if (!modelClient?.isConfigured?.() || typeof modelClient.completeJson !== "function") {
    return fallback;
  }

  const visibleConversationLines = resolveSlackConversationWindow(worldState, { summary })
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
      schemaName: "agentos_slack_semantic_facts",
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
        "You extract semantic conversation facts for AgentOS from Slack thread text.",
        "Use only the supplied visibleConversationLines. Do not invent or rewrite lines.",
        "Ignore Slack chrome, thread headings, navigation, and composer placeholders.",
        "latestInboundMessage must be the latest visible message that AgentOS should reply to.",
        "salientContext should contain up to 4 exact visible lines that best preserve that inbound request.",
        "senderName should be the person who wrote latestInboundMessage when visible, otherwise null.",
        "speakerRole should describe who wrote latestInboundMessage relative to AgentOS: sender, recipient, or unknown.",
        "threadSummary should be the channel, DM name, or short thread title when visible.",
        "Return strict JSON only."
      ].join(" "),
      userPayload: {
        summary,
        threadSummary,
        preferredLatestSnippet,
        visibleConversationLines,
        heuristicContext: fallback.salientContext,
        heuristicSenderName: fallback.senderName
      },
      temperature: 0
    });

    const latestInboundMessage = canonicalizeSlackSemanticLine(String(result.latestInboundMessage ?? ""), visibleConversationLines);
    const salientContext = uniqueStrings(
      (Array.isArray(result.salientContext) ? result.salientContext : [])
        .map((line) => canonicalizeSlackSemanticLine(String(line ?? ""), visibleConversationLines))
        .filter((line): line is string => Boolean(line))
    ).slice(0, 6);
    const normalizedThreadSummary = normalizeSlackSummary(String(result.threadSummary ?? threadSummary ?? summary)) || fallback.threadSummary;
    const normalizedSenderName = normalizeSlackSpeakerName(result.senderName) ?? fallback.senderName;

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
