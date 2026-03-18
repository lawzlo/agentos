import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";

import {
  defaultModelBaseUrl,
  defaultModelName,
  defaultModelTier,
  modelConfigPath,
  modelProviderLabel,
  readPersistedModelConfig,
  resolveConfig,
  type AgentModelProvider,
  type AgentModelTier,
  type PersistedModelConfig
} from "../../src/config.js";
import {
  fetchProviderModelCatalog,
  type ProviderModelCatalogResult,
  type ProviderModelChoice
} from "../../src/model-catalog.js";
import {
  config,
  isRemoteControlPlaneMode,
  print,
  restartLocalDaemon,
  type CliOptions
} from "../cli-utils.js";

const PROVIDERS: AgentModelProvider[] = ["openai", "anthropic", "gemini", "openai_compatible"];
const TIERS: AgentModelTier[] = ["fast", "balanced", "strong"];

function normalizeProvider(value: unknown): AgentModelProvider | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "claude") {
    return "anthropic";
  }
  if (normalized === "openai-compatible" || normalized === "openai_compatible" || normalized === "compatible") {
    return "openai_compatible";
  }
  return PROVIDERS.includes(normalized as AgentModelProvider) ? (normalized as AgentModelProvider) : null;
}

function normalizeTier(value: unknown): AgentModelTier | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return TIERS.includes(normalized as AgentModelTier) ? (normalized as AgentModelTier) : null;
}

function maskSecret(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= 8) {
    return `${normalized.slice(0, 2)}***`;
  }
  return `${normalized.slice(0, 4)}***${normalized.slice(-4)}`;
}

async function writePersistedConfig(payload: PersistedModelConfig) {
  const target = modelConfigPath(config.dataDir);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(
    target,
    JSON.stringify(
      {
        ...payload,
        updatedAt: new Date().toISOString()
      },
      null,
      2
    ),
    "utf8"
  );
  await fsp.chmod(target, 0o600).catch(() => {});
  return target;
}

function currentResolvedModel() {
  return resolveConfig({ dataDir: config.dataDir }).model;
}

function modelStatusPayload() {
  const persisted = readPersistedModelConfig(config.dataDir);
  const resolved = currentResolvedModel();
  const configured = Boolean(resolved.apiKey && resolved.name && resolved.baseUrl);
  return {
    configured,
    dataDir: config.dataDir,
    configPath: modelConfigPath(config.dataDir),
    provider: resolved.provider,
    providerLabel: modelProviderLabel(resolved.provider),
    model: resolved.name ?? null,
    tier: resolved.tier ?? null,
    baseUrl: resolved.baseUrl ?? null,
    apiKey: maskSecret(resolved.apiKey),
    source: persisted ? "saved_config" : "env_or_defaults",
    persisted: persisted
      ? {
          provider: persisted.provider ?? null,
          model: persisted.name ?? null,
          tier: persisted.tier ?? null,
          baseUrl: persisted.baseUrl ?? null,
          apiKey: maskSecret(persisted.apiKey)
        }
      : null
  };
}

function renderModelStatus(payload: ReturnType<typeof modelStatusPayload>) {
  const lines = [
    "AgentOS model status",
    "",
    `Configured: ${payload.configured ? "yes" : "no"}`,
    `Provider: ${payload.providerLabel}${payload.provider ? ` (${payload.provider})` : ""}`,
    `Model: ${payload.model ?? "not set"}`,
    `Tier: ${payload.tier ?? "not set"}`,
    `Base URL: ${payload.baseUrl ?? "not set"}`,
    `API key: ${payload.apiKey ?? "not set"}`,
    `Config path: ${payload.configPath}`
  ];
  if (!payload.configured) {
    lines.push("", "Next: run `agentos model setup`.");
  }
  return lines.join("\n");
}

interface PromptChoiceOption<T extends string> {
  value: T;
  label: string;
}

async function promptChoice<T extends string>({
  title,
  options,
  current
}: {
  title: string;
  options: PromptChoiceOption<T>[];
  current: T;
}): Promise<T> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY)
  });

  try {
    const rendered = options.map((option, index) => `${index + 1}. ${option.label}${option.value === current ? " (default)" : ""}`);
    const answer = (await readline.question(`${title}\n${rendered.join("\n")}\n> `)).trim();
    if (!answer) {
      return current;
    }

    const byIndex = Number(answer);
    if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= options.length) {
      return options[byIndex - 1].value;
    }

    const normalized = answer.toLowerCase();
    return (
      options.find((option) => option.value === answer || option.label.toLowerCase() === normalized)?.value ??
      current
    );
  } finally {
    readline.close();
  }
}

async function promptSecretInput({
  title,
  defaultValue = "",
  allowEmpty = false
}: {
  title: string;
  defaultValue?: string;
  allowEmpty?: boolean;
}): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    return promptInput({ title, defaultValue, allowEmpty });
  }

  const suffix = defaultValue ? " [default hidden]" : "";
  process.stdout.write(`${title}${suffix}\n> `);

  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const wasRaw = Boolean((stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw);
    let value = "";

    const cleanup = (writeNewline = true) => {
      stdin.off("data", onData);
      if (!wasRaw) {
        stdin.setRawMode(false);
      }
      if (writeNewline) {
        stdout.write("\n");
      }
    };

    const onData = (chunk: string | Buffer) => {
      for (const char of String(chunk)) {
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Model setup cancelled."));
          return;
        }

        if (char === "\r" || char === "\n") {
          const finalValue = value || defaultValue;
          if (!finalValue && !allowEmpty) {
            continue;
          }
          cleanup();
          resolve(finalValue);
          return;
        }

        if (char === "\u007f" || char === "\b") {
          if (value.length) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }

        if (char.startsWith("\u001b")) {
          continue;
        }

        value += char;
        stdout.write("*");
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function promptInput({
  title,
  defaultValue = "",
  allowEmpty = false
}: {
  title: string;
  defaultValue?: string;
  allowEmpty?: boolean;
}): Promise<string> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY)
  });

  try {
    const suffix = defaultValue ? ` [default: ${defaultValue}]` : "";
    const answer = (await readline.question(`${title}${suffix}\n> `)).trim();
    if (!answer) {
      if (defaultValue) {
        return defaultValue;
      }
      if (allowEmpty) {
        return "";
      }
    }
    return answer;
  } finally {
    readline.close();
  }
}

function requireInteractiveSetup() {
  if (!process.stdin.isTTY) {
    throw new Error(
      "Non-interactive model setup needs flags like `--provider`, `--api-key`, `--tier`, `--model`, or `--base-url`."
    );
  }
}

function modelChoiceLabel(choice: ProviderModelChoice) {
  const badge =
    choice.slot === "recommended" ? "Recommended" : choice.slot === "fast" ? "Fast" : "Strong";
  const preview = choice.preview ? ", preview" : "";
  const thinking = choice.supportsThinking ? ", thinking" : "";
  return `${choice.label} (${choice.modelId}) [${badge}${preview}${thinking}]`;
}

function preferredChoiceForTier(catalog: ProviderModelCatalogResult, tier: AgentModelTier) {
  return (
    catalog.choices.find((choice) => choice.tier === tier) ??
    catalog.choices.find((choice) => choice.slot === "recommended") ??
    catalog.choices[0] ??
    null
  );
}

function inferTierFromCatalog(
  catalog: ProviderModelCatalogResult,
  modelId: string,
  fallback: AgentModelTier
) {
  return catalog.choices.find((choice) => choice.modelId === modelId)?.tier ?? fallback;
}

async function resolveModelSetupInput(options: CliOptions) {
  const persisted = readPersistedModelConfig(config.dataDir) ?? {};
  const resolved = currentResolvedModel();
  const persistedProvider = normalizeProvider(persisted.provider);
  const resolvedProvider = normalizeProvider(resolved.provider);
  let provider =
    normalizeProvider(options.provider) ??
    persistedProvider ??
    resolvedProvider ??
    "openai";
  let tier = normalizeTier(options.tier) ?? defaultModelTier();

  if (!normalizeProvider(options.provider) && !process.env.MODEL_PROVIDER && process.stdin.isTTY) {
    provider = await promptChoice({
      title: "Choose a model provider",
      options: PROVIDERS.map((value) => ({
        value,
        label: `${modelProviderLabel(value)} (${value})`
      })),
      current: provider,
    });
  }

  const persistedMatchesProvider = persistedProvider === provider;
  const resolvedMatchesProvider = resolvedProvider === provider;
  const defaultBaseUrl =
    provider === "openai_compatible"
      ? String(
          options.baseUrl ??
            (persistedMatchesProvider ? persisted.baseUrl : undefined) ??
            (resolvedMatchesProvider ? resolved.baseUrl : undefined) ??
            ""
        ).trim()
      : defaultModelBaseUrl(provider) ?? "";
  const defaultModel = String(
    options.model ??
      (persistedMatchesProvider ? persisted.name : undefined) ??
      (resolvedMatchesProvider ? resolved.name : undefined) ??
      defaultModelName(provider, tier) ??
      ""
  ).trim();
  const existingKey = String(
    options.apiKey ??
      (persistedMatchesProvider ? persisted.apiKey : undefined) ??
      (resolvedMatchesProvider ? resolved.apiKey : undefined) ??
      ""
  ).trim();

  let apiKey = String(options.apiKey ?? "").trim();
  if (!apiKey) {
    if (existingKey) {
      apiKey = existingKey;
    } else {
      requireInteractiveSetup();
      apiKey = await promptSecretInput({
        title: `Paste your ${modelProviderLabel(provider)} API key`,
        allowEmpty: false
      });
    }
  }

  let baseUrl = String(options.baseUrl ?? "").trim();
  if (!baseUrl) {
    if (provider === "openai_compatible") {
      if (defaultBaseUrl) {
        baseUrl = defaultBaseUrl;
      } else {
        requireInteractiveSetup();
        baseUrl = await promptInput({
          title: "Enter the OpenAI-compatible base URL",
          allowEmpty: false
        });
      }
    } else {
      baseUrl = defaultBaseUrl;
    }
  }

  let model = String(options.model ?? "").trim();
  const catalog =
    apiKey && baseUrl
      ? await fetchProviderModelCatalog({
          provider,
          baseUrl,
          apiKey,
          timeoutMs: resolved.timeoutMs
        })
      : {
          source: "unavailable" as const,
          models: [],
          choices: [],
          warning: "API key or base URL is missing."
        };

  if (model) {
    tier = inferTierFromCatalog(catalog, model, tier);
  }

  if (!model && catalog.choices.length) {
    const defaultChoice = preferredChoiceForTier(
      catalog,
      normalizeTier(options.tier) ??
        normalizeTier(persisted.tier) ??
        normalizeTier(resolved.tier) ??
        defaultModelTier()
    );

    if (process.stdin.isTTY && !options.model) {
      const selected = await promptChoice({
        title: "Choose a model",
        options: [
          ...catalog.choices.map((choice) => ({
            value: choice.modelId,
            label: modelChoiceLabel(choice)
          })),
          {
            value: "__custom__",
            label: "Custom model id"
          }
        ],
        current: defaultChoice?.modelId ?? "__custom__"
      });

      if (selected === "__custom__") {
        model = await promptInput({
          title: "Enter the model name",
          defaultValue: defaultModel,
          allowEmpty: false
        });
        tier =
          normalizeTier(options.tier) ??
          normalizeTier(persisted.tier) ??
          normalizeTier(resolved.tier) ??
          defaultModelTier();
      } else {
        model = selected;
        tier = inferTierFromCatalog(catalog, selected, tier);
      }
    } else if (defaultChoice) {
      model = defaultChoice.modelId;
      tier = defaultChoice.tier;
    }
  }

  if (!model) {
    if (!normalizeTier(options.tier) && !process.env.MODEL_TIER && process.stdin.isTTY) {
      tier = await promptChoice({
        title: "Choose a model preset",
        options: TIERS.map((value) => ({
          value,
          label: value
        })),
        current:
          normalizeTier(persisted.tier) ??
          normalizeTier(resolved.tier) ??
          tier
      });
    } else {
      tier =
        normalizeTier(options.tier) ??
        normalizeTier(persisted.tier) ??
        normalizeTier(resolved.tier) ??
          tier;
    }

    const fallbackModel = String(
      options.model ??
        (persistedMatchesProvider ? persisted.name : undefined) ??
        (resolvedMatchesProvider ? resolved.name : undefined) ??
        defaultModelName(provider, tier) ??
        ""
    ).trim();

    if (fallbackModel) {
      model = fallbackModel;
    } else {
      requireInteractiveSetup();
      model = await promptInput({
        title: "Enter the model name",
        allowEmpty: false
      });
    }
  }

  return {
    provider,
    tier,
    apiKey,
    baseUrl,
    model,
    timeoutMs: resolved.timeoutMs,
    catalogSource: catalog.source,
    catalogWarning: catalog.warning,
    catalogChoices: catalog.choices
  };
}

export async function commandModelSetup(options: CliOptions) {
  const payload = await resolveModelSetupInput(options);
  const savedPath = await writePersistedConfig({
    provider: payload.provider,
    tier: payload.tier,
    apiKey: payload.apiKey,
    baseUrl: payload.baseUrl || undefined,
    name: payload.model,
    timeoutMs: payload.timeoutMs
  });

  let daemonRestarted = false;
  let daemonPort: number | string | null = null;
  if (!isRemoteControlPlaneMode()) {
    const restarted = await restartLocalDaemon();
    daemonRestarted = restarted.restarted;
    daemonPort = restarted.daemon?.port ?? null;
  }

  const result = {
    ok: true,
    dataDir: config.dataDir,
    configPath: savedPath,
    provider: payload.provider,
    providerLabel: modelProviderLabel(payload.provider),
    model: payload.model,
    tier: payload.tier,
    baseUrl: payload.baseUrl || null,
    apiKey: maskSecret(payload.apiKey),
    catalogSource: payload.catalogSource,
    catalogWarning: payload.catalogWarning,
    catalogChoices: payload.catalogChoices.map((choice) => ({
      slot: choice.slot,
      modelId: choice.modelId,
      label: choice.label,
      tier: choice.tier,
      preview: choice.preview,
      supportsThinking: choice.supportsThinking
    })),
    daemonRestarted,
    daemonPort,
    nextSteps: [
      daemonRestarted
        ? `The local AgentOS daemon was restarted on http://127.0.0.1:${daemonPort ?? 3017}.`
        : isRemoteControlPlaneMode()
          ? "Restart the remote AgentOS daemon so it reloads the saved model configuration."
          : "Run `agentos setup` to confirm model access is now ready.",
      'Then try `agentos "Open example.com, click More information, then capture a screenshot" --surface browser`.'
    ]
  };

  print(
    options.json
      ? result
      : [
          "AgentOS model setup",
          "",
          `Saved ${result.providerLabel} / ${result.model} (${result.tier}) to ${savedPath}`,
          `API key: ${result.apiKey}`,
          result.catalogSource === "live"
            ? `Fetched live models from ${result.providerLabel} and chose from a curated shortlist.`
            : result.catalogWarning
              ? `Live model discovery was unavailable: ${result.catalogWarning}`
              : "Live model discovery was unavailable. AgentOS used local defaults.",
          daemonRestarted
            ? `Restarted the local daemon on http://127.0.0.1:${daemonPort ?? 3017}.`
            : isRemoteControlPlaneMode()
              ? "Remote control plane detected. Restart that daemon to apply the new model config."
              : "No running local daemon was detected. The new model config will apply on the next start.",
          "",
          ...result.nextSteps.map((entry) => `- ${entry}`)
        ].join("\n"),
    options
  );
}

export async function commandModelStatus(options: CliOptions) {
  const payload = modelStatusPayload();
  print(options.json ? payload : renderModelStatus(payload), options);
}

export async function commandModelClear(options: CliOptions) {
  const target = modelConfigPath(config.dataDir);
  await fsp.rm(target, { force: true });

  let daemonRestarted = false;
  let daemonPort: number | string | null = null;
  if (!isRemoteControlPlaneMode()) {
    const restarted = await restartLocalDaemon();
    daemonRestarted = restarted.restarted;
    daemonPort = restarted.daemon?.port ?? null;
  }

  const result = {
    ok: true,
    cleared: true,
    configPath: target,
    daemonRestarted,
    daemonPort,
    nextSteps: [
      "Run `agentos model setup` when you want to configure a provider again."
    ]
  };
  print(
    options.json
      ? result
      : [
          "AgentOS model config cleared",
          "",
          `Removed ${target}`,
          daemonRestarted
            ? `Restarted the local daemon on http://127.0.0.1:${daemonPort ?? 3017}.`
            : isRemoteControlPlaneMode()
              ? "Remote control plane detected. Restart that daemon to drop the cleared config."
              : "No running local daemon was detected.",
          "",
          ...result.nextSteps.map((entry) => `- ${entry}`)
        ].join("\n"),
    options
  );
}

export async function commandModel(
  subcommand: string | undefined,
  _positionals: string[],
  options: CliOptions
) {
  if (!subcommand || subcommand === "status") {
    await commandModelStatus(options);
    return;
  }

  if (subcommand === "setup") {
    await commandModelSetup(options);
    return;
  }

  if (subcommand === "clear") {
    await commandModelClear(options);
    return;
  }

  throw new Error(`Unsupported model command: ${subcommand}`);
}
