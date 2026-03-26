import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LivePack } from "./runtime/live-pack-registry.js";
import type { LicenseTier } from "./types/system.js";

const CHROME_CANDIDATES: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ]
};

export interface AgentModelConfig {
  provider: AgentModelProvider;
  baseUrl?: string;
  apiKey?: string;
  name?: string;
  tier?: AgentModelTier;
  timeoutMs: number;
}

export type AgentModelProvider = "openai" | "anthropic" | "gemini" | "openai_compatible" | "claude_code_cli";
export type AgentModelTier = "fast" | "balanced" | "strong";

export interface PersistedModelConfig {
  provider?: AgentModelProvider;
  baseUrl?: string;
  apiKey?: string;
  name?: string;
  tier?: AgentModelTier;
  timeoutMs?: number;
  updatedAt?: string;
}

export interface AgentOsConfig {
  port: number;
  dataDir: string;
  daemonDir: string;
  dbPath: string;
  masterKeyPath: string;
  inboxDir: string;
  headless: boolean;
  browserMode: BrowserMode;
  browserExecutable?: string;
  browserCdpUrl?: string;
  livePacks: Record<string, LivePack> | null;
  model: AgentModelConfig;
  license: LicenseConfig;
  learning: LearningConfig;
  jobs: JobsConfig;
}

export type BrowserMode = "attach_existing" | "managed_profile";

export interface ConfigOverrides {
  port?: number | string;
  dataDir?: string;
  headless?: boolean;
  browserMode?: BrowserMode;
  browserExecutable?: string;
  browserCdpUrl?: string;
  livePacks?: Record<string, LivePack> | null;
  model?: Partial<AgentModelConfig>;
  license?: Partial<LicenseConfig>;
  learning?: Partial<LearningConfig>;
  jobs?: Partial<JobsConfig>;
}

export interface LicenseConfig {
  baseUrl?: string;
  publicKey?: string;
  offlineGraceDays: number;
  enforceInSource: boolean;
  sourceCheckoutTier: LicenseTier;
  freeMaxWatches: number;
  proMaxWatches: number;
}

export interface LearningConfig {
  enabled: boolean;
  metadataRoots: string[];
  contentRoots: string[];
  excludedPaths: string[];
  textExtensions: string[];
  maxContentBytes: number;
  scanIntervalMs: number;
  maxFilesPerScan: number;
  maxDepth: number;
}

export interface JobsConfig {
  enabled: boolean;
  pollIntervalMs: number;
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((entry) => fs.existsSync(entry));
}

function safeReadTextFile(targetPath: string | null | undefined): string | undefined {
  const normalized = String(targetPath ?? "").trim();
  if (!normalized) {
    return undefined;
  }
  try {
    return fs.readFileSync(path.isAbsolute(normalized) ? normalized : path.resolve(normalized), "utf8");
  } catch {
    return undefined;
  }
}

const DEFAULT_MODEL_TIER: AgentModelTier = "balanced";

const MODEL_LABELS: Record<AgentModelProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic Claude",
  gemini: "Google Gemini",
  openai_compatible: "OpenAI-compatible",
  claude_code_cli: "Claude Code CLI"
};

const PROVIDER_DEFAULT_BASE_URL: Partial<Record<AgentModelProvider, string>> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com/v1beta"
};

const PROVIDER_DEFAULT_MODELS: Record<AgentModelProvider, Record<AgentModelTier, string | null>> = {
  openai: {
    fast: "gpt-5-mini",
    balanced: "gpt-5",
    strong: "gpt-5"
  },
  anthropic: {
    fast: "claude-haiku-4-5",
    balanced: "claude-sonnet-4-5",
    strong: "claude-opus-4-5"
  },
  gemini: {
    fast: "gemini-2.0-flash",
    balanced: "gemini-2.5-flash",
    strong: "gemini-2.5-pro"
  },
  openai_compatible: {
    fast: null,
    balanced: null,
    strong: null
  },
  claude_code_cli: {
    fast: "sonnet",
    balanced: "sonnet",
    strong: "opus"
  }
};

function normalizeModelProvider(value: unknown): AgentModelProvider | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === "openai-compatible" || normalized === "openai_compatible" || normalized === "compatible") {
    return "openai_compatible";
  }

  if (
    normalized === "claude_code_cli" ||
    normalized === "claude-code-cli" ||
    normalized === "claude_code" ||
    normalized === "claudecode"
  ) {
    return "claude_code_cli";
  }

  if (normalized === "claude") {
    return "anthropic";
  }

  return ["openai", "anthropic", "gemini", "openai_compatible", "claude_code_cli"].includes(normalized)
    ? (normalized as AgentModelProvider)
    : null;
}

function normalizeModelTier(value: unknown): AgentModelTier | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return ["fast", "balanced", "strong"].includes(normalized)
    ? (normalized as AgentModelTier)
    : null;
}

function providerEnvApiKey(provider: AgentModelProvider): string | null {
  if (provider === "openai") {
    return process.env.OPENAI_API_KEY ?? null;
  }
  if (provider === "anthropic") {
    return process.env.ANTHROPIC_API_KEY ?? null;
  }
  if (provider === "gemini") {
    return process.env.GEMINI_API_KEY ?? null;
  }
  return null;
}

function normalizeBrowserMode(value: unknown): BrowserMode | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (
    normalized === "attach_existing" ||
    normalized === "attach-existing" ||
    normalized === "attach" ||
    normalized === "existing"
  ) {
    return "attach_existing";
  }

  if (
    normalized === "managed_profile" ||
    normalized === "managed-profile" ||
    normalized === "managed"
  ) {
    return "managed_profile";
  }

  return null;
}

function normalizeBrowserCdpUrl(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return undefined;
  }

  if (/^\d+$/u.test(normalized)) {
    return `http://127.0.0.1:${normalized}`;
  }

  if (/^https?:\/\//iu.test(normalized) || /^wss?:\/\//iu.test(normalized)) {
    return normalized;
  }

  if (/^[^:/]+:\d+$/u.test(normalized)) {
    return `http://${normalized}`;
  }

  return normalized;
}

function resolveModelProvider({
  overrideProvider,
  envProvider,
  persistedProvider,
  inferredBaseUrl
}: {
  overrideProvider?: unknown;
  envProvider?: unknown;
  persistedProvider?: unknown;
  inferredBaseUrl?: unknown;
}): AgentModelProvider {
  const explicit =
    normalizeModelProvider(overrideProvider) ??
    normalizeModelProvider(envProvider) ??
    normalizeModelProvider(persistedProvider);
  if (explicit) {
    return explicit;
  }

  return String(inferredBaseUrl ?? "").trim() ? "openai_compatible" : "openai";
}

export function defaultModelBaseUrl(provider: AgentModelProvider): string | undefined {
  return PROVIDER_DEFAULT_BASE_URL[provider];
}

export function defaultModelName(
  provider: AgentModelProvider,
  tier: AgentModelTier = DEFAULT_MODEL_TIER
): string | undefined {
  return PROVIDER_DEFAULT_MODELS[provider][tier] ?? undefined;
}

export function modelProviderLabel(provider: AgentModelProvider | null | undefined): string {
  if (!provider) {
    return "Not configured";
  }
  return MODEL_LABELS[provider];
}

export function defaultModelTier(): AgentModelTier {
  return DEFAULT_MODEL_TIER;
}

export function modelConfigPath(dataDir = defaultDataDir()): string {
  return path.join(dataDir, "model-config.json");
}

export function readPersistedModelConfig(dataDir = defaultDataDir()): PersistedModelConfig | null {
  const target = modelConfigPath(dataDir);
  try {
    const raw = fs.readFileSync(target, "utf8");
    const parsed = JSON.parse(raw) as PersistedModelConfig;
    return {
      provider: normalizeModelProvider(parsed.provider) ?? undefined,
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : undefined,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : undefined,
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      tier: normalizeModelTier(parsed.tier) ?? undefined,
      timeoutMs: Number.isFinite(Number(parsed.timeoutMs)) ? Number(parsed.timeoutMs) : undefined,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined
    };
  } catch {
    return null;
  }
}

export function defaultDataDir(): string {
  return path.join(os.homedir(), ".agentos");
}

export function detectBrowserExecutable(): string | undefined {
  if (process.env.AGENTOS_BROWSER_EXECUTABLE) {
    return process.env.AGENTOS_BROWSER_EXECUTABLE;
  }

  return firstExisting(CHROME_CANDIDATES[process.platform] ?? []);
}

export function resolveConfig(overrides: ConfigOverrides = {}): AgentOsConfig {
  const dataDir =
    overrides.dataDir ??
    process.env.AGENTOS_DATA_DIR ??
    defaultDataDir();
  const persistedModel = readPersistedModelConfig(dataDir) ?? {};
  const resolvedModelProvider = resolveModelProvider({
    overrideProvider: overrides.model?.provider,
    envProvider: process.env.MODEL_PROVIDER,
    persistedProvider: persistedModel.provider,
    inferredBaseUrl: overrides.model?.baseUrl ?? process.env.MODEL_BASE_URL ?? persistedModel.baseUrl
  });
  const resolvedModelTier =
    normalizeModelTier(overrides.model?.tier) ??
    normalizeModelTier(process.env.MODEL_TIER) ??
    normalizeModelTier(persistedModel.tier) ??
    DEFAULT_MODEL_TIER;
  const daemonDir = path.join(dataDir, "daemon");
  const homeDir = os.homedir();
  const learningMetadataRoots = overrides.learning?.metadataRoots ?? [homeDir];
  const defaultContentRoots = [
    path.join(homeDir, "Downloads"),
    path.join(homeDir, "Documents"),
    path.join(homeDir, "Desktop"),
    path.join(dataDir, "workspaces")
  ];
  const learningContentRoots = overrides.learning?.contentRoots ?? defaultContentRoots.filter((entry, index, values) => {
    return values.indexOf(entry) === index;
  });
  const excludedPaths =
    overrides.learning?.excludedPaths ??
    [
      path.join(homeDir, ".cache"),
      path.join(homeDir, ".Trash"),
      path.join(homeDir, "Library", "Caches"),
      path.join(homeDir, "Library", "Logs"),
      path.join(homeDir, "Library", "Developer"),
      path.join(dataDir, "dist"),
      path.join(dataDir, "target")
    ];
  const configuredLicensePublicKeyPath =
    typeof process.env.AGENTOS_LICENSE_PUBLIC_KEY_PATH === "string"
      ? process.env.AGENTOS_LICENSE_PUBLIC_KEY_PATH.trim()
      : "";
  const resolvedLicensePublicKey =
    overrides.license?.publicKey ??
    process.env.AGENTOS_LICENSE_PUBLIC_KEY ??
    safeReadTextFile(configuredLicensePublicKeyPath);
  const resolvedSourceCheckoutTier =
    String(overrides.license?.sourceCheckoutTier ?? process.env.AGENTOS_LICENSE_SOURCE_TIER ?? "pro").trim().toLowerCase() ===
    "free"
      ? "free"
      : "pro";
  const resolvedBrowserMode =
    normalizeBrowserMode(overrides.browserMode) ??
    normalizeBrowserMode(process.env.AGENTOS_BROWSER_MODE) ??
    "attach_existing";
  const resolvedBrowserCdpUrl =
    normalizeBrowserCdpUrl(overrides.browserCdpUrl) ??
    normalizeBrowserCdpUrl(process.env.AGENTOS_BROWSER_CDP_URL) ??
    normalizeBrowserCdpUrl(process.env.AGENTOS_BROWSER_REMOTE_DEBUGGING_PORT);

  return {
    port: Number(overrides.port ?? process.env.PORT ?? 3017),
    dataDir,
    daemonDir,
    dbPath: path.join(dataDir, "agentos.sqlite"),
    masterKeyPath: path.join(dataDir, "master.key"),
    inboxDir: path.join(dataDir, "inbox"),
    headless: overrides.headless ?? process.env.AGENTOS_HEADLESS === "true",
    browserMode: resolvedBrowserMode,
    browserExecutable: overrides.browserExecutable ?? detectBrowserExecutable(),
    browserCdpUrl: resolvedBrowserCdpUrl,
    livePacks: overrides.livePacks ?? null,
    model: {
      provider: resolvedModelProvider,
      baseUrl:
        overrides.model?.baseUrl ??
        process.env.MODEL_BASE_URL ??
        persistedModel.baseUrl ??
        defaultModelBaseUrl(resolvedModelProvider),
      apiKey:
        overrides.model?.apiKey ??
        process.env.MODEL_API_KEY ??
        providerEnvApiKey(resolvedModelProvider) ??
        persistedModel.apiKey,
      name:
        overrides.model?.name ??
        process.env.MODEL_NAME ??
        persistedModel.name ??
        defaultModelName(resolvedModelProvider, resolvedModelTier),
      tier: resolvedModelTier,
      timeoutMs: Number(
        overrides.model?.timeoutMs ?? process.env.MODEL_TIMEOUT_MS ?? persistedModel.timeoutMs ?? 45000
      )
    },
    license: {
      baseUrl:
        overrides.license?.baseUrl ??
        process.env.AGENTOS_LICENSE_BASE_URL ??
        process.env.AGENTOS_API_BASE_URL ??
        undefined,
      publicKey: resolvedLicensePublicKey,
      offlineGraceDays: Number(
        overrides.license?.offlineGraceDays ?? process.env.AGENTOS_LICENSE_OFFLINE_GRACE_DAYS ?? 14
      ),
      enforceInSource:
        overrides.license?.enforceInSource ?? process.env.AGENTOS_LICENSE_ENFORCE_IN_SOURCE === "1",
      sourceCheckoutTier: resolvedSourceCheckoutTier,
      freeMaxWatches: Number(overrides.license?.freeMaxWatches ?? process.env.AGENTOS_FREE_MAX_WATCHES ?? 1),
      proMaxWatches: Number(overrides.license?.proMaxWatches ?? process.env.AGENTOS_PRO_MAX_WATCHES ?? 10)
    },
    learning: {
      enabled: overrides.learning?.enabled ?? process.env.AGENTOS_LEARNING_ENABLED !== "false",
      metadataRoots: learningMetadataRoots,
      contentRoots: learningContentRoots,
      excludedPaths,
      textExtensions:
        overrides.learning?.textExtensions ?? ["txt", "md", "json", "csv", "html", "eml", "pdf"],
      maxContentBytes: Number(overrides.learning?.maxContentBytes ?? process.env.AGENTOS_LEARNING_MAX_CONTENT_BYTES ?? 262144),
      scanIntervalMs: Number(overrides.learning?.scanIntervalMs ?? process.env.AGENTOS_LEARNING_SCAN_INTERVAL_MS ?? 300000),
      maxFilesPerScan: Number(overrides.learning?.maxFilesPerScan ?? process.env.AGENTOS_LEARNING_MAX_FILES_PER_SCAN ?? 2000),
      maxDepth: Number(overrides.learning?.maxDepth ?? process.env.AGENTOS_LEARNING_MAX_DEPTH ?? 8)
    },
    jobs: {
      enabled: overrides.jobs?.enabled ?? process.env.AGENTOS_JOBS_ENABLED !== "false",
      pollIntervalMs: Number(overrides.jobs?.pollIntervalMs ?? process.env.AGENTOS_JOB_POLL_INTERVAL_MS ?? 30000)
    }
  };
}
