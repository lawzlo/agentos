import type { AgentModelProvider, AgentModelTier } from "./config.js";

export interface ProviderModelCatalogEntry {
  id: string;
  label: string;
  provider: AgentModelProvider;
  stable: boolean;
  preview: boolean;
  supportsThinking: boolean | null;
  supportedMethods: string[];
}

export interface ProviderModelChoice {
  slot: "recommended" | "fast" | "strong";
  tier: AgentModelTier;
  modelId: string;
  label: string;
  reason: string;
  preview: boolean;
  stable: boolean;
  supportsThinking: boolean | null;
}

export interface ProviderModelCatalogResult {
  source: "live" | "unavailable";
  models: ProviderModelCatalogEntry[];
  choices: ProviderModelChoice[];
  warning: string | null;
}

const PREVIEW_PATTERN = /\b(preview|exp|experimental|beta|alpha|rc|nightly|test)\b/u;
const NON_TEXT_MODEL_PATTERN = /\b(audio|transcribe|tts|realtime|image|embedding|moderation|omni-moderation|vision|search|safety|rerank|video|veo|imagen|learnlm|aqa)\b/u;

const PROVIDER_SLOT_MATCHERS: Record<
  AgentModelProvider,
  Record<ProviderModelChoice["slot"], RegExp[]>
> = {
  openai: {
    recommended: [/^gpt-5\.4$/u, /^gpt-5\.2$/u, /^gpt-5$/u, /^gpt-4\.1$/u],
    fast: [/^gpt-5\.4-mini$/u, /^gpt-5\.2-mini$/u, /^gpt-5-mini$/u, /^gpt-4\.1-mini$/u],
    strong: [/^gpt-5\.4-pro$/u, /^gpt-5\.2-pro$/u, /^gpt-5-pro$/u, /^gpt-5\.4$/u, /^gpt-5\.2$/u]
  },
  anthropic: {
    recommended: [/^claude-sonnet-4-6/u, /^claude-sonnet-4-5/u, /^claude-sonnet-4/u, /^claude-3-7-sonnet/u],
    fast: [/^claude-haiku-4-5/u, /^claude-haiku-4/u, /^claude-3-5-haiku/u, /^claude-3-haiku/u],
    strong: [/^claude-opus-4-6/u, /^claude-opus-4-1/u, /^claude-opus-4/u, /^claude-sonnet-4-6/u, /^claude-sonnet-4/u]
  },
  gemini: {
    recommended: [/^gemini-2\.5-flash$/u, /^gemini-2\.0-flash$/u, /^gemini-1\.5-flash/u],
    fast: [/^gemini-2\.5-flash-lite$/u, /^gemini-2\.0-flash-lite$/u, /^gemini-2\.5-flash$/u, /^gemini-2\.0-flash$/u],
    strong: [/^gemini-2\.5-pro$/u, /^gemini-1\.5-pro/u, /^gemini-2\.5-flash$/u]
  },
  openai_compatible: {
    recommended: [],
    fast: [],
    strong: []
  }
};

function normalizeBaseUrl(baseUrl: string) {
  return String(baseUrl).replace(/\/$/, "");
}

function isPreviewLike(id: string) {
  return PREVIEW_PATTERN.test(String(id).toLowerCase());
}

function looksLikeTextModel(id: string) {
  const normalized = String(id).toLowerCase();
  if (NON_TEXT_MODEL_PATTERN.test(normalized)) {
    return false;
  }
  return true;
}

function buildEntry(
  provider: AgentModelProvider,
  id: string,
  label?: string | null,
  supportedMethods: string[] = [],
  supportsThinking: boolean | null = null
): ProviderModelCatalogEntry | null {
  const normalizedId = String(id).trim();
  if (!normalizedId || !looksLikeTextModel(normalizedId)) {
    return null;
  }

  return {
    id: normalizedId,
    label: String(label ?? normalizedId).trim() || normalizedId,
    provider,
    preview: isPreviewLike(normalizedId),
    stable: !isPreviewLike(normalizedId),
    supportsThinking,
    supportedMethods
  };
}

function genericFastScore(id: string) {
  return /(mini|haiku|flash|lite|small|nano)/u.test(id) ? 0 : 1;
}

function genericStrongScore(id: string) {
  return /(pro|opus|sonnet|ultra|large)/u.test(id) ? 0 : 1;
}

function matchIndex(id: string, patterns: RegExp[]) {
  if (!patterns.length) {
    return Number.POSITIVE_INFINITY;
  }
  const normalized = String(id).toLowerCase();
  const index = patterns.findIndex((pattern) => pattern.test(normalized));
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

function sortStableFirst(entries: ProviderModelCatalogEntry[]) {
  return [...entries].sort((left, right) => {
    if (left.stable !== right.stable) {
      return left.stable ? -1 : 1;
    }
    return left.id.localeCompare(right.id);
  });
}

function pickChoice(
  provider: AgentModelProvider,
  slot: ProviderModelChoice["slot"],
  entries: ProviderModelCatalogEntry[],
  selected: Set<string>
): ProviderModelCatalogEntry | null {
  const patterns = PROVIDER_SLOT_MATCHERS[provider][slot];
  const available = sortStableFirst(entries).filter((entry) => !selected.has(entry.id));

  const matched = available
    .map((entry) => ({
      entry,
      index: matchIndex(entry.id, patterns)
    }))
    .filter((item) => Number.isFinite(item.index))
    .sort((left, right) => left.index - right.index);
  if (matched.length) {
    return matched[0].entry;
  }

  if (!available.length) {
    return null;
  }

  if (slot === "fast") {
    return [...available].sort((left, right) => {
      const score = genericFastScore(left.id) - genericFastScore(right.id);
      if (score !== 0) {
        return score;
      }
      return left.id.localeCompare(right.id);
    })[0] ?? null;
  }

  if (slot === "strong") {
    return [...available].sort((left, right) => {
      const score = genericStrongScore(left.id) - genericStrongScore(right.id);
      if (score !== 0) {
        return score;
      }
      return left.id.localeCompare(right.id);
    })[0] ?? null;
  }

  return available[0] ?? null;
}

function slotReason(slot: ProviderModelChoice["slot"], entry: ProviderModelCatalogEntry) {
  const previewNote = entry.preview ? " Preview model." : "";
  if (slot === "recommended") {
    return `Best default for most AgentOS tasks.${previewNote}`;
  }
  if (slot === "fast") {
    return `Lower-latency and usually cheaper.${previewNote}`;
  }
  return `Prefer this when you want the strongest available model.${previewNote}`;
}

export function recommendProviderModels(
  provider: AgentModelProvider,
  entries: ProviderModelCatalogEntry[]
): ProviderModelChoice[] {
  const selected = new Set<string>();
  const choices: ProviderModelChoice[] = [];

  const slotMap: Array<{
    slot: ProviderModelChoice["slot"];
    tier: AgentModelTier;
  }> = [
    { slot: "recommended", tier: "balanced" },
    { slot: "strong", tier: "strong" },
    { slot: "fast", tier: "fast" }
  ];

  for (const mapping of slotMap) {
    const entry = pickChoice(provider, mapping.slot, entries, selected);
    if (!entry) {
      continue;
    }
    selected.add(entry.id);
    choices.push({
      slot: mapping.slot,
      tier: mapping.tier,
      modelId: entry.id,
      label: entry.label,
      reason: slotReason(mapping.slot, entry),
      preview: entry.preview,
      stable: entry.stable,
      supportsThinking: entry.supportsThinking
    });
  }

  const displayOrder: Record<ProviderModelChoice["slot"], number> = {
    recommended: 0,
    fast: 1,
    strong: 2
  };
  return choices.sort((left, right) => displayOrder[left.slot] - displayOrder[right.slot]);
}

async function fetchOpenAIStyleModels({
  provider,
  baseUrl,
  apiKey,
  timeoutMs
}: {
  provider: AgentModelProvider;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/models`, {
    headers: {
      authorization: `Bearer ${apiKey}`
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`Model list request failed: ${response.status}`);
  }
  const payload = (await response.json()) as {
    data?: Array<{ id?: string }>;
  };
  return (payload.data ?? [])
    .map((item) => buildEntry(provider, String(item.id ?? "")))
    .filter((entry): entry is ProviderModelCatalogEntry => Boolean(entry))
    .filter((entry) => {
      const normalized = entry.id.toLowerCase();
      if (provider === "openai") {
        return normalized.startsWith("gpt-");
      }
      return true;
    });
}

async function fetchAnthropicModels({
  baseUrl,
  apiKey,
  timeoutMs
}: {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/v1/models`, {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`Model list request failed: ${response.status}`);
  }
  const payload = (await response.json()) as {
    data?: Array<{ id?: string; display_name?: string }>;
  };
  return (payload.data ?? [])
    .map((item) => buildEntry("anthropic", String(item.id ?? ""), item.display_name ?? item.id))
    .filter((entry): entry is ProviderModelCatalogEntry => Boolean(entry))
    .filter((entry) => entry.id.toLowerCase().startsWith("claude-"));
}

async function fetchGeminiModels({
  baseUrl,
  apiKey,
  timeoutMs
}: {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/models?key=${encodeURIComponent(apiKey)}`, {
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`Model list request failed: ${response.status}`);
  }
  const payload = (await response.json()) as {
    models?: Array<{
      name?: string;
      displayName?: string;
      supportedGenerationMethods?: string[];
      thinking?: boolean;
    }>;
  };
  return (payload.models ?? [])
    .map((item) => {
      const id = String(item.name ?? "").replace(/^models\//u, "");
      const methods = Array.isArray(item.supportedGenerationMethods)
        ? item.supportedGenerationMethods.map((entry) => String(entry))
        : [];
      if (!methods.includes("generateContent")) {
        return null;
      }
      return buildEntry("gemini", id, item.displayName ?? id, methods, typeof item.thinking === "boolean" ? item.thinking : null);
    })
    .filter((entry): entry is ProviderModelCatalogEntry => Boolean(entry))
    .filter((entry) => entry.id.toLowerCase().startsWith("gemini-"));
}

export async function fetchProviderModelCatalog({
  provider,
  baseUrl,
  apiKey,
  timeoutMs
}: {
  provider: AgentModelProvider;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}): Promise<ProviderModelCatalogResult> {
  if (!apiKey || !baseUrl) {
    return {
      source: "unavailable",
      models: [],
      choices: [],
      warning: "API key or base URL is missing."
    };
  }

  try {
    const models =
      provider === "anthropic"
        ? await fetchAnthropicModels({ baseUrl, apiKey, timeoutMs })
        : provider === "gemini"
          ? await fetchGeminiModels({ baseUrl, apiKey, timeoutMs })
          : await fetchOpenAIStyleModels({ provider, baseUrl, apiKey, timeoutMs });

    return {
      source: "live",
      models,
      choices: recommendProviderModels(provider, models),
      warning: null
    };
  } catch (error) {
    return {
      source: "unavailable",
      models: [],
      choices: [],
      warning: error instanceof Error ? error.message : String(error)
    };
  }
}
