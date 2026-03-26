import type { AgentModelClient } from "./model-client.js";
import { inferReplyLanguage, type ReplyLanguageHint } from "./reply-language.js";
import type { WorldState } from "../types/runtime-schema.js";

export interface OutlookSemanticFacts {
  latestInboundMessage: string | null;
  salientContext: string[];
  senderName: string | null;
  speakerRole: "sender" | "recipient" | "unknown";
  threadSummary: string | null;
  subjectCue: string | null;
  replyLanguageHint: ReplyLanguageHint;
  source: "model" | "heuristic" | "vision";
  evidence: string;
}

export type OutlookSemanticModelClient =
  Pick<AgentModelClient, "isConfigured" | "completeJson"> | null | undefined;

const MAIL_UI_CHROME_PATTERN =
  /^(mail|email|gmail|outlook|邮件|inbox|收件箱|已发送|sent|drafts|草稿|spam|archive|归档|trash|垃圾箱|delete|删除|search|搜索|compose|撰写|reply|回复|send|发送)$/iu;
const OUTLOOK_UI_CHROME_PATTERN =
  /^(outlook|focused|other|archive|flag|categories|categorize|junk email|junk|trash|deleted items|drafts|sent items|reply all|forward|new mail|focused inbox|other inbox|respond|收件箱|其他|重点|归档|标记|分类|垃圾邮件|已删除|已发送|新建邮件|回复全部|转发)$/iu;

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

  for (const block of Array.isArray(worldState?.screenTextBlocks) ? worldState.screenTextBlocks : []) {
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

  const windows = Array.isArray((worldState?.appContext as { windows?: unknown } | null)?.windows)
    ? (((worldState?.appContext as { windows?: unknown[] } | null)?.windows ?? []) as Array<Record<string, unknown>>)
    : [];
  for (const windowInfo of windows) {
    const title = String(windowInfo?.title ?? windowInfo?.windowName ?? "").trim();
    if (title) {
      lines.push(title);
    }
  }

  return uniqueStrings(lines).slice(0, 120);
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

function isMailUiChrome(text: string): boolean {
  return MAIL_UI_CHROME_PATTERN.test(String(text ?? "").trim());
}

function isOutlookUiChrome(text: string): boolean {
  const normalized = String(text ?? "").trim();
  return isMailUiChrome(normalized) || OUTLOOK_UI_CHROME_PATTERN.test(normalized);
}

function isMailComposerChromeLine(text: string): boolean {
  return /^(send|reply|compose|write|message|editor|发送|回复|撰写|输入)$/iu.test(String(text ?? "").trim());
}

function isOutlookQuoteMarkerLine(text: string): boolean {
  const normalized = String(text ?? "").trim();
  return (
    /^(from|date|to|cc|bcc|subject)\s*[:：]/iu.test(normalized)
    || /^(发件人|日期|收件人|抄送|主题)\s*[:：]/u.test(normalized)
    || /^on .+ wrote:$/iu.test(normalized)
    || />\s*\S/u.test(normalized)
  );
}

function looksLikeOutlookBodyLine(text: string): boolean {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return false;
  }
  if (isOutlookUiChrome(normalized) || isMailComposerChromeLine(normalized) || isOutlookQuoteMarkerLine(normalized)) {
    return false;
  }
  if (/^draft saved\b/iu.test(normalized) || /^get outlook for mac$/iu.test(normalized)) {
    return false;
  }
  if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/u.test(normalized)) {
    return false;
  }
  if (!/[\u4e00-\u9fffA-Za-z0-9]/u.test(normalized)) {
    return false;
  }
  return Array.from(normalized).length >= 3;
}

function extractOutlookSpeakerLabel(text: string): string | null {
  const normalized = String(text ?? "").trim();
  const match = normalized.match(/^([^:：]{1,40})\s*[:：]\s*\S/u);
  const candidate = match?.[1]?.trim() ?? "";
  if (!candidate) {
    return null;
  }
  if (/^(from|to|cc|bcc|subject|date|me|reply|draft|outlook|发送|回复|发件人|收件人|抄送|主题|日期)$/iu.test(candidate)) {
    return null;
  }
  return candidate;
}

function canonicalizeOutlookSemanticLine(line: string, sourceLines: string[]): string | null {
  const normalized = normalizeMailSummary(line);
  if (!normalized) {
    return null;
  }

  const exact = sourceLines.find((entry) => normalizeMailSummary(entry) === normalized);
  if (exact) {
    return exact.trim();
  }

  const fuzzy = sourceLines.find((entry) => {
    const candidate = normalizeMailSummary(entry);
    return candidate && (candidate.includes(normalized) || normalized.includes(candidate));
  });
  return fuzzy?.trim() ?? null;
}

function resolveOutlookConversationWindow(
  worldState: WorldState | null,
  {
    summary,
    subjectCue,
    trailingWindow = 18
  }: {
    summary: string;
    subjectCue?: string | null;
    trailingWindow?: number;
  }
): string[] {
  const lines = collectVisibleLines(worldState).filter((line) => !isOutlookUiChrome(line));
  const normalizedSummary = normalizeMailSummary(summary);
  const normalizedSubjectCue = normalizeMailSummary(String(subjectCue ?? ""));
  const anchorIndex = lines.findIndex((line) => {
    const normalized = normalizeMailSummary(line);
    return Boolean(normalized) && (normalized === normalizedSummary || normalized === normalizedSubjectCue);
  });

  const pool = anchorIndex === -1 ? lines : lines.slice(anchorIndex, anchorIndex + trailingWindow);
  const collected: string[] = [];
  for (const line of pool) {
    const normalized = normalizeMailSummary(line);
    if (!normalized || normalized === normalizedSummary || normalized === normalizedSubjectCue) {
      continue;
    }
    if (isOutlookQuoteMarkerLine(line) && collected.length > 0) {
      break;
    }
    if (!looksLikeOutlookBodyLine(line)) {
      continue;
    }
    collected.push(line.trim());
    if (collected.length >= 8) {
      break;
    }
  }

  return uniqueStrings(collected);
}

function fallbackOutlookSemanticFacts({
  worldState,
  summary,
  threadSummary = null,
  subjectCue = null,
  preferredLatestSnippet = null
}: {
  worldState: WorldState | null;
  summary: string;
  threadSummary?: string | null;
  subjectCue?: string | null;
  preferredLatestSnippet?: string | null;
}): OutlookSemanticFacts {
  const visibleConversationLines = resolveOutlookConversationWindow(worldState, {
    summary,
    subjectCue
  });
  const normalizedPreferredSnippet =
    canonicalizeOutlookSemanticLine(String(preferredLatestSnippet ?? ""), visibleConversationLines)
    ?? (String(preferredLatestSnippet ?? "").trim() || null);
  const latestInboundMessage =
    normalizedPreferredSnippet && looksLikeOutlookBodyLine(normalizedPreferredSnippet)
      ? normalizedPreferredSnippet
      : (visibleConversationLines.find((line) => looksLikeOutlookBodyLine(line)) ?? null);
  const salientContext = uniqueStrings([
    latestInboundMessage,
    ...visibleConversationLines
  ]).filter(Boolean).slice(0, 6);
  const resolvedThreadSummary = normalizeMailSummary(String(threadSummary ?? summary)) || null;
  const resolvedSubjectCue = normalizeMailSummary(String(subjectCue ?? "")) || null;
  const senderFromLines =
    salientContext
      .map((line) => extractOutlookSpeakerLabel(line))
      .find((line): line is string => Boolean(line))
    ?? null;
  const senderName =
    senderFromLines
    ?? (
      resolvedThreadSummary && resolvedThreadSummary !== resolvedSubjectCue
        ? resolvedThreadSummary
        : null
    );
  return {
    latestInboundMessage,
    salientContext,
    senderName,
    speakerRole: latestInboundMessage ? "sender" : "unknown",
    threadSummary: resolvedThreadSummary,
    subjectCue: resolvedSubjectCue,
    replyLanguageHint: inferReplyLanguage({
      summary: resolvedSubjectCue ?? resolvedThreadSummary ?? summary,
      context: salientContext
    }),
    source: preferredLatestSnippet ? "vision" : "heuristic",
    evidence: preferredLatestSnippet
      ? "vision latest snippet with heuristic conversation fallback"
      : "heuristic Outlook conversation extraction"
  };
}

export async function inferOutlookSemanticFacts({
  modelClient,
  worldState,
  summary,
  threadSummary = null,
  subjectCue = null,
  preferredLatestSnippet = null
}: {
  modelClient: OutlookSemanticModelClient;
  worldState: WorldState | null;
  summary: string;
  threadSummary?: string | null;
  subjectCue?: string | null;
  preferredLatestSnippet?: string | null;
}): Promise<OutlookSemanticFacts> {
  const fallback = fallbackOutlookSemanticFacts({
    worldState,
    summary,
    threadSummary,
    subjectCue,
    preferredLatestSnippet
  });

  if (!modelClient?.isConfigured?.() || typeof modelClient.completeJson !== "function") {
    return fallback;
  }

  const visibleConversationLines = resolveOutlookConversationWindow(worldState, {
    summary,
    subjectCue
  }).slice(0, 18);
  if (!visibleConversationLines.length) {
    return fallback;
  }

  try {
    const result = await modelClient.completeJson<
      {
        summary: string;
        threadSummary: string | null;
        subjectCue: string | null;
        preferredLatestSnippet: string | null;
        visibleConversationLines: string[];
        heuristicContext: string[];
      },
      {
        latestInboundMessage: string | null;
        salientContext: string[];
        senderName: string | null;
        speakerRole: "sender" | "recipient" | "unknown";
        threadSummary: string | null;
        subjectCue: string | null;
        replyLanguageHint: ReplyLanguageHint;
        evidence: string | null;
      }
    >({
      schemaName: "agentos_outlook_semantic_facts",
      schema: {
        type: "object",
        properties: {
          latestInboundMessage: { type: ["string", "null"] },
          salientContext: { type: "array", items: { type: "string" } },
          senderName: { type: ["string", "null"] },
          speakerRole: { type: "string", enum: ["sender", "recipient", "unknown"] },
          threadSummary: { type: ["string", "null"] },
          subjectCue: { type: ["string", "null"] },
          replyLanguageHint: { type: ["string", "null"], enum: ["en", "zh", null] },
          evidence: { type: ["string", "null"] }
        },
        required: [
          "latestInboundMessage",
          "salientContext",
          "senderName",
          "speakerRole",
          "threadSummary",
          "subjectCue",
          "replyLanguageHint",
          "evidence"
        ],
        additionalProperties: false
      },
      systemPrompt: [
        "You extract semantic email reply facts for AgentOS from Microsoft Outlook visible text.",
        "Use only the supplied visibleConversationLines. Do not invent or rewrite lines.",
        "Ignore Outlook chrome, quoted-history headers, mailbox labels, and composer chrome.",
        "latestInboundMessage must be the latest visible inbound line from the sender that should drive a reply.",
        "salientContext should contain up to 4 exact visible lines that preserve the sender's latest request or update.",
        "senderName should be the sender or short thread label when visible, otherwise null.",
        "speakerRole should describe who wrote latestInboundMessage.",
        "threadSummary should be the short sender/thread label when visible.",
        "subjectCue should be the visible email subject when present.",
        "replyLanguageHint should match the sender's visible message language.",
        "Return strict JSON only."
      ].join(" "),
      userPayload: {
        summary,
        threadSummary,
        subjectCue,
        preferredLatestSnippet,
        visibleConversationLines,
        heuristicContext: fallback.salientContext
      },
      temperature: 0
    });

    const latestInboundMessage =
      canonicalizeOutlookSemanticLine(String(result.latestInboundMessage ?? ""), visibleConversationLines)
      ?? fallback.latestInboundMessage;
    const salientContext = uniqueStrings(
      (Array.isArray(result.salientContext) ? result.salientContext : [])
        .map((line) => canonicalizeOutlookSemanticLine(String(line ?? ""), visibleConversationLines))
        .filter((line): line is string => Boolean(line))
    );
    const mergedContext = uniqueStrings([
      latestInboundMessage,
      ...salientContext,
      ...fallback.salientContext
    ]).filter(Boolean).slice(0, 6);
    const normalizedThreadSummary = normalizeMailSummary(String(result.threadSummary ?? fallback.threadSummary ?? summary)) || null;
    const normalizedSubjectCue = normalizeMailSummary(String(result.subjectCue ?? fallback.subjectCue ?? "")) || null;
    const senderFromLines =
      mergedContext
        .map((line) => extractOutlookSpeakerLabel(line))
        .find((line): line is string => Boolean(line))
      ?? null;
    const senderName =
      normalizeMailSummary(String(result.senderName ?? "")) ||
      senderFromLines ||
      fallback.senderName;

    if (!latestInboundMessage && !mergedContext.length) {
      return fallback;
    }

    return {
      latestInboundMessage,
      salientContext: mergedContext,
      senderName,
      speakerRole: result.speakerRole ?? fallback.speakerRole,
      threadSummary: normalizedThreadSummary,
      subjectCue: normalizedSubjectCue,
      replyLanguageHint: result.replyLanguageHint ?? fallback.replyLanguageHint,
      source: "model",
      evidence: String(result.evidence ?? "").trim() || "model semantic extraction from Outlook thread text"
    };
  } catch {
    return fallback;
  }
}
