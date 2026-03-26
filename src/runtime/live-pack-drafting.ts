import type { AgentModelClient } from "./model-client.js";
import { inferReplyLanguage } from "./reply-language.js";
import type { OutlookSemanticFacts } from "./outlook-semantic-facts.js";
import type { SlackSemanticFacts } from "./slack-semantic-facts.js";
import type { WeChatSemanticFacts } from "./wechat-semantic-facts.js";

export interface LivePackDraftResponse {
  replyText: string;
  metadata: Record<string, unknown>;
}

interface DraftPackReplyControlPlane {
  modelClient: Pick<AgentModelClient, "isConfigured" | "draftReply">;
  listReplyStylePreferences(args: {
    livePack: string;
    preferredSurface: "browser" | "desktop";
    limit?: number;
  }): string[];
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
  controlPlane: DraftPackReplyControlPlane;
  livePack: string;
  preferredSurface: "browser" | "desktop";
}): string[] {
  return controlPlane.listReplyStylePreferences({
    livePack,
    preferredSurface,
    limit: 6
  });
}

export async function draftPackReply({
  controlPlane,
  livePack,
  preferredSurface,
  family,
  goal,
  summary,
  context,
  metadata = null
}: {
  controlPlane: DraftPackReplyControlPlane;
  livePack: string;
  preferredSurface: "browser" | "desktop";
  family: "chat" | "mail" | "generic";
  goal: string;
  summary: string;
  context: string[];
  metadata?: Record<string, unknown> | null;
}): Promise<LivePackDraftResponse> {
  const outlookSemanticFacts = ((metadata ?? {}) as { semanticFacts?: OutlookSemanticFacts | null }).semanticFacts ?? null;
  const slackSemanticFacts = ((metadata ?? {}) as { semanticFacts?: SlackSemanticFacts | null }).semanticFacts ?? null;
  const wechatSemanticFacts = ((metadata ?? {}) as { semanticFacts?: WeChatSemanticFacts | null }).semanticFacts ?? null;
  const effectiveContext =
    livePack === "outlook-desktop" && outlookSemanticFacts
        ? uniqueStrings([
            outlookSemanticFacts.latestInboundMessage,
            ...outlookSemanticFacts.salientContext,
            ...context
          ]).filter(Boolean)
        : livePack === "wechat-desktop" && wechatSemanticFacts
          ? uniqueStrings([
              wechatSemanticFacts.latestInboundMessage,
              ...wechatSemanticFacts.salientContext,
              ...context
            ]).filter(Boolean)
          : livePack.startsWith("slack-") && slackSemanticFacts
            ? uniqueStrings([
                slackSemanticFacts.latestInboundMessage,
                ...slackSemanticFacts.salientContext,
                ...context
              ]).filter(Boolean)
            : context;
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
        context: effectiveContext,
        stylePreferences,
        replyLanguageHint: inferReplyLanguage({ summary, context: effectiveContext })
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

  const fallback = draftHeuristicReply({
    family,
    goal,
    summary,
    context: effectiveContext,
    stylePreferences
  });
  if (modelError) {
    return {
      ...fallback,
      metadata: {
        ...fallback.metadata,
        modelError
      }
    };
  }
  return fallback;
}
