import type { AgentModelClient } from "./model-client.js";
import type { WorldState } from "../types/runtime-schema.js";

export interface BossSemanticFacts {
  latestInboundMessage: string | null;
  salientContext: string[];
  senderName: string | null;
  speakerRole: "candidate" | "recruiter" | "unknown";
  threadSummary: string | null;
  source: "model" | "heuristic" | "vision";
  evidence: string;
}

export type BossSemanticModelClient =
  Pick<AgentModelClient, "isConfigured" | "completeJson"> | null | undefined;

const SEND_PATTERN = /(send|reply|submit|发送|回复|提交)/iu;
const BOSS_TIMESTAMP_PATTERN = /^(?:(?:[01]?\d|2[0-3]):[0-5]\d|昨天|today|yesterday|刚刚)$/iu;
const BOSS_UI_CHROME_PATTERN =
  /^(boss直聘|boss zhipin|boss|搜索|search|筛选|filter|推荐|推荐牛人|消息|message|messages|职位|jobs|候选人列表|沟通|在线沟通|立即沟通|发消息|发送|send|查看简历)$/iu;
const BROWSER_UI_CHROME_PATTERN =
  /^(your repositories|application:\s|new tab|https?:\/\/|www\.|[\w.-]+\.(com|cn|io|ai|co|org|net|app|cloud|info)(\/.*)?$)/iu;
const BOSS_COMPOSE_CHROME_PATTERN = /^(发送消息|message|reply|chat|contact|沟通|回复|输入|联系)$/iu;

interface ParsedBossConversationLine {
  raw: string;
  normalized: string;
  speakerLabel: string | null;
  senderName: string | null;
  speakerRole: "candidate" | "recruiter" | "unknown";
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

export function normalizeBossSummary(value: string): string {
  const normalized = String(value ?? "")
    .replace(/^[●•]\s*/u, "")
    .replace(/^(new candidate|candidate update|candidate|新候选人|候选人|待沟通|待跟进)\s*[:：-]?\s*/iu, "")
    .replace(/^\(\d+\)\s*/u, "")
    .replace(/\s+\(\d+\)$/u, "")
    .trim();
  if (!/\p{L}/u.test(normalized)) {
    return "";
  }
  return normalized;
}

function normalizeBossSpeakerLabel(value: string): string {
  return String(value ?? "")
    .replace(/^[●•]\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function isBossUiChrome(text: string): boolean {
  return BOSS_UI_CHROME_PATTERN.test(String(text ?? "").trim());
}

function isBrowserUiChrome(text: string): boolean {
  return BROWSER_UI_CHROME_PATTERN.test(String(text ?? "").trim());
}

function isRecruiterSpeakerLabel(label: string): boolean {
  return /^(招聘方|recruiter|recruiting team|hiring team|hr|猎头|顾问|advisor|assistant|agentos|me|我)$/iu.test(
    String(label ?? "").trim()
  );
}

function isGenericCandidateSpeakerLabel(label: string): boolean {
  return /^(candidate|候选人|候选者|talent|applicant|求职者)$/iu.test(String(label ?? "").trim());
}

function deriveBossParticipantName(value: string): string {
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

export function sanitizeBossReplySnippet(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/^\[草稿\]\s*/iu, "")
    .replace(/^([^:：]{1,40})\s*[:：]\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function bossSnippetLooksUsable(snippet: string): boolean {
  const normalized = sanitizeBossReplySnippet(snippet);
  if (!normalized) {
    return false;
  }
  const chars = Array.from(normalized);
  const allowedChars = chars.filter((char) => /[\u4e00-\u9fffA-Za-z0-9\s,，。.!?？:：'’"“”\-+()/]/u.test(char));
  if (allowedChars.length <= Math.floor(chars.length / 2)) {
    return false;
  }
  return /[\u4e00-\u9fffA-Za-z]{2,}/u.test(normalized);
}

export function bossSnippetLooksLikeCandidateName(snippet: string): boolean {
  const normalized = sanitizeBossReplySnippet(snippet).replace(/\s+/gu, "");
  if (!normalized) {
    return false;
  }
  if (/[0-9]/u.test(normalized) || /[。！？!?，,：:;；"'“”‘’()（）]/u.test(normalized)) {
    return false;
  }
  return /^[\u4e00-\u9fffA-Za-z·•]{2,16}$/u.test(normalized);
}

export function bossSnippetLooksLikeProfileMetadata(snippet: string): boolean {
  const normalized = sanitizeBossReplySnippet(snippet);
  if (!normalized) {
    return false;
  }
  if (/[。！？!?，,：:;；"'“”‘’()（）]/u.test(normalized)) {
    return false;
  }
  if (
    /(?:\d+\s*年经验|应届|本科|硕士|博士|产品经理|工程师|设计师|运营|销售|市场|实习|上海|北京|深圳|广州|杭州|苏州|成都|武汉|西安|远程|onsite|hybrid)$/iu.test(
      normalized
    )
  ) {
    return true;
  }
  return (
    Array.from(normalized).length <= 6
    && !/(岗位|职位|空缺|hc|机会|薪资|薪酬|待遇|base|简历|经历|背景|项目|作品|沟通|方便|可以|周[一二三四五六日天]|上午|下午|晚上|明天|后天|cloud|aws|google)/iu.test(
      normalized
    )
  );
}

function canonicalizeBossSemanticLine(line: string, sourceLines: string[]): string | null {
  const normalized = normalizeBossSummary(line);
  if (!normalized) {
    return null;
  }

  const exact = sourceLines.find((entry) => normalizeBossSummary(entry) === normalized);
  if (exact) {
    return exact.trim();
  }

  const fuzzy = sourceLines.find((entry) => {
    const entrySummary = normalizeBossSummary(entry);
    return entrySummary && (entrySummary.includes(normalized) || normalized.includes(entrySummary));
  });
  return fuzzy?.trim() ?? null;
}

function parseBossConversationLine(
  line: string,
  threadSummary: string | null
): ParsedBossConversationLine | null {
  const raw = String(line ?? "").trim();
  if (
    !raw
    || isBossUiChrome(raw)
    || isBrowserUiChrome(raw)
    || SEND_PATTERN.test(raw)
    || BOSS_TIMESTAMP_PATTERN.test(raw)
  ) {
    return null;
  }

  const speakerMatch = raw.match(/^([^:：]{1,40})\s*[:：]\s*(.+)$/u);
  const speakerLabel = speakerMatch?.[1] ? normalizeBossSpeakerLabel(speakerMatch[1]) : null;
  const senderName =
    speakerLabel && !isRecruiterSpeakerLabel(speakerLabel) && !isGenericCandidateSpeakerLabel(speakerLabel)
      ? speakerLabel
      : (speakerLabel && isGenericCandidateSpeakerLabel(speakerLabel)
        ? (deriveBossParticipantName(threadSummary ?? "") || null)
        : null);
  const speakerRole =
    speakerLabel
      ? (isRecruiterSpeakerLabel(speakerLabel)
        ? "recruiter"
        : "candidate")
      : "unknown";
  const normalized = normalizeBossSummary(raw);

  if (!normalized) {
    return null;
  }

  return {
    raw,
    normalized,
    speakerLabel,
    senderName,
    speakerRole
  };
}

function resolveBossConversationWindow(
  worldState: WorldState | null,
  {
    summary,
    trailingWindow = 6,
    excludeComposeChrome = false
  }: {
    summary: string;
    trailingWindow?: number;
    excludeComposeChrome?: boolean;
  }
): string[] {
  const lines = collectVisibleLines(worldState).filter((line) => !isBossUiChrome(line) && !isBrowserUiChrome(line));
  const normalizedSummary = normalizeBossSummary(summary);
  const participantName = deriveBossParticipantName(summary);
  const anchorIndex = lines.findIndex((line) => {
    const normalized = normalizeBossSummary(line);
    return Boolean(normalized) && (normalized === normalizedSummary || normalized === participantName);
  });
  const pool = anchorIndex === -1 ? lines : lines.slice(Math.max(0, anchorIndex - 1), anchorIndex + trailingWindow);
  return uniqueStrings(
    pool.filter((line) => !excludeComposeChrome || !BOSS_COMPOSE_CHROME_PATTERN.test(String(line ?? "").trim()))
  );
}

function buildFallbackBossSemanticFacts({
  worldState,
  summary,
  preferredLatestSnippet = null,
  threadSummary = null,
  trailingWindow = 6,
  excludeComposeChrome = false
}: {
  worldState: WorldState | null;
  summary: string;
  preferredLatestSnippet?: string | null;
  threadSummary?: string | null;
  trailingWindow?: number;
  excludeComposeChrome?: boolean;
}): BossSemanticFacts {
  const resolvedThreadSummary = deriveBossParticipantName(threadSummary || summary) || null;
  const visibleConversationLines = resolveBossConversationWindow(worldState, {
    summary,
    trailingWindow,
    excludeComposeChrome
  });
  const normalizedSummary = normalizeBossSummary(summary);
  const parsedLines = visibleConversationLines
    .filter((line) => {
      const normalized = normalizeBossSummary(line);
      return normalized && normalized !== normalizedSummary && normalized !== resolvedThreadSummary;
    })
    .map((line) => parseBossConversationLine(line, resolvedThreadSummary))
    .filter((entry): entry is ParsedBossConversationLine => Boolean(entry))
    .filter(
      (entry) =>
        bossSnippetLooksUsable(entry.raw)
        && !bossSnippetLooksLikeCandidateName(entry.raw)
        && !bossSnippetLooksLikeProfileMetadata(entry.raw)
    );

  const preferredCanonical = canonicalizeBossSemanticLine(String(preferredLatestSnippet ?? ""), visibleConversationLines);
  const preferredLine =
    preferredCanonical && bossSnippetLooksUsable(preferredCanonical) && !bossSnippetLooksLikeProfileMetadata(preferredCanonical)
      ? parseBossConversationLine(preferredCanonical, resolvedThreadSummary)
      : null;

  const latestInboundEntry =
    preferredLine
    ?? [...parsedLines].reverse().find((entry) => entry.speakerRole === "candidate")
    ?? [...parsedLines].reverse().find((entry) => entry.speakerRole !== "recruiter")
    ?? null;
  const latestInboundIndex = latestInboundEntry ? parsedLines.findIndex((entry) => entry.raw === latestInboundEntry.raw) : -1;
  const contextualWindow =
    latestInboundIndex === -1
      ? parsedLines.slice(-4)
      : parsedLines.slice(Math.max(0, latestInboundIndex - 2), latestInboundIndex + 1);
  const salientContext = uniqueStrings([
    latestInboundEntry?.raw ?? null,
    ...contextualWindow
      .filter((entry) => entry.speakerRole !== "recruiter")
      .map((entry) => entry.raw)
  ]).filter(Boolean).slice(0, 6);

  return {
    latestInboundMessage: latestInboundEntry?.raw ?? null,
    salientContext,
    senderName: latestInboundEntry?.senderName ?? resolvedThreadSummary,
    speakerRole:
      latestInboundEntry?.speakerRole === "recruiter"
        ? "recruiter"
        : latestInboundEntry
          ? "candidate"
          : "unknown",
    threadSummary: resolvedThreadSummary,
    source: preferredLine ? "vision" : "heuristic",
    evidence: preferredLine ? "vision latest snippet with heuristic context fallback" : "heuristic context extraction"
  };
}

export async function inferBossSemanticFacts({
  modelClient,
  worldState,
  summary,
  preferredLatestSnippet = null,
  threadSummary = null,
  trailingWindow = 6,
  excludeComposeChrome = false
}: {
  modelClient: BossSemanticModelClient;
  worldState: WorldState | null;
  summary: string;
  preferredLatestSnippet?: string | null;
  threadSummary?: string | null;
  trailingWindow?: number;
  excludeComposeChrome?: boolean;
}): Promise<BossSemanticFacts> {
  const fallback = buildFallbackBossSemanticFacts({
    worldState,
    summary,
    preferredLatestSnippet,
    threadSummary,
    trailingWindow,
    excludeComposeChrome
  });

  if (!modelClient?.isConfigured?.() || typeof modelClient.completeJson !== "function") {
    return fallback;
  }

  const visibleConversationLines = resolveBossConversationWindow(worldState, {
    summary,
    trailingWindow,
    excludeComposeChrome
  })
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
        speakerRole: "candidate" | "recruiter" | "unknown";
        threadSummary: string | null;
        evidence: string | null;
      }
    >({
      schemaName: "agentos_boss_semantic_facts",
      schema: {
        type: "object",
        properties: {
          latestInboundMessage: { type: ["string", "null"] },
          salientContext: { type: "array", items: { type: "string" } },
          senderName: { type: ["string", "null"] },
          speakerRole: { type: "string", enum: ["candidate", "recruiter", "unknown"] },
          threadSummary: { type: ["string", "null"] },
          evidence: { type: ["string", "null"] }
        },
        required: ["latestInboundMessage", "salientContext", "senderName", "speakerRole", "threadSummary", "evidence"],
        additionalProperties: false
      },
      systemPrompt: [
        "You extract semantic conversation facts for AgentOS from BOSS直聘 chat text.",
        "Use only the supplied visibleConversationLines. Do not invent or rewrite lines.",
        "Ignore candidate names, role/location metadata, browser chrome, and message composer placeholders.",
        "latestInboundMessage must be the latest visible message from the candidate that the recruiter should reply to.",
        "salientContext should contain up to 4 exact visible lines that best preserve the candidate's request.",
        "senderName should be the candidate's name when visible, otherwise null.",
        "speakerRole should describe who wrote latestInboundMessage.",
        "threadSummary should be the candidate name or short thread title when visible.",
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

    const latestInboundMessage = canonicalizeBossSemanticLine(String(result.latestInboundMessage ?? ""), visibleConversationLines);
    const salientContext = uniqueStrings(
      (Array.isArray(result.salientContext) ? result.salientContext : [])
        .map((line) => canonicalizeBossSemanticLine(String(line ?? ""), visibleConversationLines))
        .filter((line): line is string => Boolean(line))
    ).slice(0, 6);
    const normalizedThreadSummary =
      deriveBossParticipantName(String(result.threadSummary ?? threadSummary ?? summary)) || fallback.threadSummary;
    const normalizedSenderName =
      deriveBossParticipantName(String(result.senderName ?? "").trim())
      || fallback.senderName
      || normalizedThreadSummary
      || null;

    if (!latestInboundMessage && !salientContext.length) {
      return fallback;
    }

    return {
      latestInboundMessage: latestInboundMessage ?? fallback.latestInboundMessage,
      salientContext: uniqueStrings([
        latestInboundMessage,
        ...salientContext,
        ...fallback.salientContext
      ]).filter(Boolean).slice(0, 6),
      senderName: normalizedSenderName,
      speakerRole: result.speakerRole ?? fallback.speakerRole,
      threadSummary: normalizedThreadSummary,
      source: "model",
      evidence: String(result.evidence ?? "").trim() || "model semantic conversation facts"
    };
  } catch {
    return fallback;
  }
}

export function pickBossReplyTopic(
  context: string[],
  language: "zh" | "en",
  latestInboundMessage: string | null = null
): string | null {
  const prioritizedContext = uniqueStrings([
    sanitizeBossReplySnippet(String(latestInboundMessage ?? "")),
    ...context.map((entry) => sanitizeBossReplySnippet(entry))
  ]).filter(Boolean).filter(
    (entry) =>
      bossSnippetLooksUsable(entry)
      && !bossSnippetLooksLikeCandidateName(entry)
      && !bossSnippetLooksLikeProfileMetadata(entry)
  );
  if (!prioritizedContext.length) {
    return null;
  }

  if (language === "zh") {
    const timeSnippet = prioritizedContext.find((entry) =>
      /(这?周[一二三四五六日天](?:上午|中午|下午|晚上)?|下周[一二三四五六日天](?:上午|中午|下午|晚上)?|明天(?:上午|中午|下午|晚上)?|后天(?:上午|中午|下午|晚上)?)/u.test(
        entry
      )
    );
    if (timeSnippet) {
      const timeMatch = timeSnippet.match(/(这?周[一二三四五六日天](?:上午|中午|下午|晚上)?|下周[一二三四五六日天](?:上午|中午|下午|晚上)?|明天(?:上午|中午|下午|晚上)?|后天(?:上午|中午|下午|晚上)?)/u);
      if (timeMatch?.[1]) {
        return `${timeMatch[1]}的沟通安排`;
      }
    }

    const roleSnippet = prioritizedContext.find((entry) => /(岗位|职位|空缺|hc|机会)/iu.test(entry));
    if (roleSnippet) {
      return "这个岗位";
    }

    const compensationSnippet = prioritizedContext.find((entry) => /(薪资|薪酬|待遇|base)/iu.test(entry));
    if (compensationSnippet) {
      return "薪资和岗位情况";
    }

    const backgroundSnippet = prioritizedContext.find((entry) => /(简历|经历|背景|项目|作品|产品经理|aigc|ai)/iu.test(entry));
    if (backgroundSnippet) {
      return `你提到的${backgroundSnippet.replace(/[。！？!?].*$/u, "").slice(0, 18)}`;
    }

    const snippet = prioritizedContext[0] ?? null;
    return snippet ? `你提到的“${snippet.replace(/[。！？!?].*$/u, "").slice(0, 18)}”` : null;
  }

  const cloudSnippet = prioritizedContext.find((entry) => /(aws|google cloud|cloud|credits|partnership)/iu.test(entry));
  if (cloudSnippet) {
    return "the cloud partnership details";
  }

  const roleSnippet = prioritizedContext.find((entry) => /(role|position|opening|job)/iu.test(entry));
  if (roleSnippet) {
    return "the role";
  }

  const snippet =
    prioritizedContext.find(
      (entry) =>
        bossSnippetLooksUsable(entry)
        && !bossSnippetLooksLikeCandidateName(entry)
        && !bossSnippetLooksLikeProfileMetadata(entry)
    ) ?? null;
  if (!snippet) {
    return null;
  }
  return `your note about "${snippet.replace(/[.!?].*$/u, "").slice(0, 28)}"`;
}
