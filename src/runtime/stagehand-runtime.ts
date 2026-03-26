import { pathToFileURL } from "node:url";

import type { Page } from "playwright-core";

import type { AgentModelConfig } from "../config.js";
import type {
  BrowserExecutionInput,
  BrowserExecutionResult
} from "../types/runtime-schema.js";

type StagehandProvider = "openai" | "anthropic" | "gemini";

interface StagehandLike {
  init?: () => Promise<void>;
  close?: () => Promise<void>;
  act: (instruction: unknown, options?: Record<string, unknown>) => Promise<unknown>;
  observe?: (instruction: string, options?: Record<string, unknown>) => Promise<unknown>;
  extract?: (
    instruction: string,
    schema?: unknown,
    options?: Record<string, unknown>
  ) => Promise<unknown>;
  agent?: (options?: Record<string, unknown>) => {
    execute: (input: Record<string, unknown>) => Promise<unknown>;
  };
}

interface StagehandConstructorArgs {
  env: "LOCAL";
  localBrowserLaunchOptions: {
    cdpUrl: string;
  };
  model: {
    modelName?: string;
    provider: StagehandProvider;
    apiKey: string;
    temperature: number;
    baseURL?: string;
  };
}

type StagehandConstructor = new (args: StagehandConstructorArgs) => StagehandLike;

export interface StagehandRuntime {
  act: (instruction: string, options: { page: Page; timeoutMs?: number; variables?: Record<string, unknown> }) => Promise<unknown>;
  observe: (
    instruction: string,
    options: { page: Page; timeoutMs?: number; onlyVisible?: boolean; returnAction?: boolean }
  ) => Promise<unknown>;
  observeThenAct: (
    instruction: string,
    options: { page: Page; timeoutMs?: number; variables?: Record<string, unknown> }
  ) => Promise<unknown>;
  extract: (
    instruction: string,
    schema: Record<string, unknown> | null | undefined,
    options: { page: Page; timeoutMs?: number }
  ) => Promise<unknown>;
  execute: (input: BrowserExecutionInput, page: Page) => Promise<BrowserExecutionResult>;
  close: () => Promise<void>;
}

function supportedStagehandProvider(provider: AgentModelConfig["provider"]): StagehandProvider | null {
  if (provider === "openai" || provider === "anthropic" || provider === "gemini") {
    return provider;
  }
  if (provider === "openai_compatible") {
    return "openai";
  }
  return null;
}

async function loadStagehandModule(modulePath: string): Promise<{ Stagehand?: StagehandConstructor; default?: unknown }> {
  const normalized = String(modulePath ?? "").trim();
  const target =
    normalized.startsWith("/") || normalized.startsWith(".")
      ? pathToFileURL(normalized).href
      : normalized;
  return (await import(target)) as { Stagehand?: StagehandConstructor; default?: unknown };
}

function resolveStagehandConstructor(mod: { Stagehand?: StagehandConstructor; default?: unknown }): StagehandConstructor {
  const candidate =
    mod.Stagehand
    ?? ((mod.default as { Stagehand?: StagehandConstructor } | undefined)?.Stagehand)
    ?? (typeof mod.default === "function" ? (mod.default as StagehandConstructor) : null);
  if (!candidate) {
    throw new Error("Stagehand module does not export a Stagehand constructor.");
  }
  return candidate;
}

function resolveStagehandModuleSpecifier(): string {
  const explicit = String(process.env.AGENTOS_STAGEHAND_MODULE ?? "").trim();
  return explicit || "@browserbasehq/stagehand";
}

function buildStagehandModelConfig(modelConfig: AgentModelConfig): StagehandConstructorArgs["model"] {
  const provider = supportedStagehandProvider(modelConfig.provider);
  if (!provider) {
    throw new Error(
      `Stagehand browser runtime does not support model provider ${String(modelConfig.provider)}. Use openai, openai_compatible, anthropic, or gemini.`
    );
  }
  if (!modelConfig.apiKey) {
    throw new Error("Stagehand browser runtime requires a configured model API key.");
  }

  return {
    modelName: modelConfig.name,
    provider,
    apiKey: modelConfig.apiKey,
    temperature: 0,
    ...(provider === "openai" && modelConfig.baseUrl ? { baseURL: modelConfig.baseUrl } : {})
  };
}

function asBlocker(detail: string): BrowserExecutionResult {
  return {
    status: "blocked",
    finalUrl: "",
    blockers: [
      {
        kind: "runtime_unavailable",
        detail,
        suggestedAction: "Install/configure Stagehand and retry."
      }
    ],
    verification: null
  };
}

export async function createStagehandRuntime({
  cdpUrl,
  modelConfig
}: {
  cdpUrl: string;
  modelConfig: AgentModelConfig;
}): Promise<StagehandRuntime> {
  const specifier = resolveStagehandModuleSpecifier();
  let mod: { Stagehand?: StagehandConstructor; default?: unknown };
  try {
    mod = await loadStagehandModule(specifier);
  } catch (error) {
    throw new Error(
      `Stagehand runtime is unavailable. Could not import ${specifier}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const Stagehand = resolveStagehandConstructor(mod);
  const instance = new Stagehand({
    env: "LOCAL",
    localBrowserLaunchOptions: { cdpUrl },
    model: buildStagehandModelConfig(modelConfig)
  });

  if (typeof instance.init === "function") {
    await instance.init();
  }

  return {
    async observe(instruction, options) {
      if (typeof instance.observe !== "function") {
        throw new Error("Stagehand observe() is unavailable in the current runtime.");
      }
      return await instance.observe(instruction, {
        page: options.page,
        returnAction: options.returnAction ?? true,
        onlyVisible: options.onlyVisible ?? true,
        timeout: options.timeoutMs ?? modelConfig.timeoutMs
      });
    },
    async act(instruction, options) {
      return await instance.act(instruction, {
        page: options.page,
        timeout: options.timeoutMs ?? modelConfig.timeoutMs,
        variables: options.variables ?? {}
      });
    },
    async observeThenAct(instruction, options) {
      try {
        const observed = await this.observe(instruction, {
          page: options.page,
          timeoutMs: options.timeoutMs,
          onlyVisible: true,
          returnAction: true
        });
        if (Array.isArray(observed) && observed.length > 0) {
          return await instance.act(observed[0], {
            page: options.page,
            timeout: options.timeoutMs ?? modelConfig.timeoutMs,
            variables: options.variables ?? {}
          });
        }
        if (observed && typeof observed === "object") {
          return await instance.act(observed, {
            page: options.page,
            timeout: options.timeoutMs ?? modelConfig.timeoutMs,
            variables: options.variables ?? {}
          });
        }
      } catch {
        // Fall back to direct act below.
      }
      return await this.act(instruction, options);
    },
    async extract(instruction, schema, options) {
      if (typeof instance.extract !== "function") {
        throw new Error("Stagehand extract() is unavailable in the current runtime.");
      }
      return await instance.extract(instruction, schema ?? undefined, {
        page: options.page,
        timeout: options.timeoutMs ?? modelConfig.timeoutMs
      });
    },
    async execute(input, page) {
      const actions = Array.isArray(input.actions)
        ? input.actions.map((entry) => String(entry ?? "").trim()).filter(Boolean)
        : [];
      const timeoutMs = Number(input.timeoutMs ?? modelConfig.timeoutMs);

      try {
        if (actions.length > 0) {
          for (const action of actions) {
            await this.observeThenAct(action, {
              page,
              timeoutMs,
              variables: input.variables ?? {}
            });
          }
          return {
            status: "completed",
            finalUrl: page.url(),
            blockers: [],
            verification: null
          };
        }

        if (!input.instruction.trim()) {
          return asBlocker("Browser execution requires an instruction.");
        }

        if (typeof instance.agent !== "function") {
          throw new Error("Stagehand agent() is unavailable in the current runtime.");
        }
        const agent = instance.agent({ mode: "hybrid" });
        const result = await agent.execute({
          instruction: input.instruction,
          page,
          maxSteps: Math.max(1, Number(input.maxSteps || 1))
        });
        const extractedResult =
          input.successCriteria && input.verificationSchema
            ? await this.extract(input.successCriteria, input.verificationSchema, { page, timeoutMs })
            : null;
        return {
          status: "completed",
          finalUrl: page.url(),
          blockers: [],
          extractedResult: extractedResult ?? result,
          verification: extractedResult && typeof extractedResult === "object" ? (extractedResult as Record<string, unknown>) : null
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return asBlocker(message);
      }
    },
    async close() {
      if (typeof instance.close === "function") {
        await instance.close();
      }
    }
  };
}
