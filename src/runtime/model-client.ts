import fs from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type {
  AgentModelConfig,
  AgentModelProvider,
  AgentModelTier
} from "../config.js";
import {
  defaultModelBaseUrl,
  defaultModelName,
  modelProviderLabel
} from "../config.js";
import type { RunBudgetStatus, RuntimeStep, TaskSpec, UsageSummary, WorldState } from "../types/runtime-schema.js";

const execFileAsync = promisify(execFile);
const modelUsageStorage = new AsyncLocalStorage<ModelUsageBudget>();

interface JsonSchemaRequest<TPayload> {
  schemaName: string;
  schema: Record<string, unknown>;
  systemPrompt: string;
  userPayload: TPayload;
  temperature?: number;
}

interface ImageJsonSchemaRequest<TResponse> {
  schemaName: string;
  schema: Record<string, unknown>;
  systemPrompt: string;
  userPrompt: string;
  imagePath: string;
  temperature?: number;
}

interface ModelPlanResponse {
  summary?: string;
  steps: RuntimeStep[];
}

interface ModelAutonomyDecision {
  done: boolean;
  reason: string;
  summary?: string | null;
  action?: RuntimeStep | null;
}

interface ModelDraftReply {
  replyText: string;
  confidence?: number | null;
  rationale?: string | null;
}

export interface ModelUsageBudget {
  id: string;
  maxRequests: number;
  status: RunBudgetStatus;
  usage: UsageSummary;
}

export interface ModelClientStatus {
  configured: boolean;
  provider: AgentModelProvider | null;
  providerLabel: string | null;
  modelName: string | null;
  baseUrl: string | null;
  tier: AgentModelTier | null;
}

type ClaudeCodeCliErrorKind = "reauth_required" | "unavailable" | "failed";

function emptyUsageSummary(): UsageSummary {
  return {
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null
  };
}

function normalizeTokenCount(value: unknown): number {
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
}

function usageSummaryFromOpenAI(payload: Record<string, unknown>): Partial<UsageSummary> {
  const usage = (payload.usage ?? {}) as Record<string, unknown>;
  return {
    inputTokens: normalizeTokenCount(usage.prompt_tokens),
    outputTokens: normalizeTokenCount(usage.completion_tokens),
    totalTokens: normalizeTokenCount(usage.total_tokens)
  };
}

function usageSummaryFromAnthropic(payload: Record<string, unknown>): Partial<UsageSummary> {
  const usage = (payload.usage ?? {}) as Record<string, unknown>;
  const inputTokens = normalizeTokenCount(usage.input_tokens);
  const outputTokens = normalizeTokenCount(usage.output_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: normalizeTokenCount(usage.total_tokens) || inputTokens + outputTokens
  };
}

function usageSummaryFromGemini(payload: Record<string, unknown>): Partial<UsageSummary> {
  const usage = (payload.usageMetadata ?? {}) as Record<string, unknown>;
  const inputTokens = normalizeTokenCount(usage.promptTokenCount);
  const outputTokens =
    normalizeTokenCount(usage.candidatesTokenCount) ||
    normalizeTokenCount(usage.outputTokenCount);
  return {
    inputTokens,
    outputTokens,
    totalTokens: normalizeTokenCount(usage.totalTokenCount) || inputTokens + outputTokens
  };
}

function usageSummaryFromClaudeCode(payload: Record<string, unknown>): Partial<UsageSummary> {
  const usage = (payload.usage ?? {}) as Record<string, unknown>;
  const inputTokens =
    normalizeTokenCount(usage.input_tokens) +
    normalizeTokenCount(usage.cache_creation_input_tokens) +
    normalizeTokenCount(usage.cache_read_input_tokens);
  const outputTokens = normalizeTokenCount(usage.output_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens
  };
}

function mergeUsage(summary: UsageSummary, patch: Partial<UsageSummary>): UsageSummary {
  const addedInputTokens = normalizeTokenCount(patch.inputTokens);
  const addedOutputTokens = normalizeTokenCount(patch.outputTokens);
  const addedTotalTokens = normalizeTokenCount(patch.totalTokens) || addedInputTokens + addedOutputTokens;
  return {
    requestCount: summary.requestCount + 1,
    inputTokens: summary.inputTokens + addedInputTokens,
    outputTokens: summary.outputTokens + addedOutputTokens,
    totalTokens: summary.totalTokens + addedTotalTokens,
    estimatedCostUsd: summary.estimatedCostUsd
  };
}

function claudeCodeCommand(): string {
  return String(process.env.AGENTOS_CLAUDE_CODE_BIN ?? process.env.CLAUDE_CODE_BIN ?? "claude").trim() || "claude";
}

class ClaudeCodeCliError extends Error {
  kind: ClaudeCodeCliErrorKind;
  stderr: string;

  constructor(kind: ClaudeCodeCliErrorKind, message: string, stderr = "") {
    super(message);
    this.name = "ClaudeCodeCliError";
    this.kind = kind;
    this.stderr = stderr;
  }
}

function classifyClaudeCodeCliError(detail: string): ClaudeCodeCliErrorKind {
  const normalized = String(detail ?? "").toLowerCase();
  if (
    normalized.includes("oauth token has expired")
    || normalized.includes("please obtain a new token")
    || normalized.includes("run claude /login")
    || normalized.includes("reauth")
    || normalized.includes("authentication required")
  ) {
    return "reauth_required";
  }
  if (
    normalized.includes("enoent")
    || normalized.includes("not found")
    || normalized.includes("command not found")
    || normalized.includes("spawn claude")
  ) {
    return "unavailable";
  }
  return "failed";
}

function extractClaudeCodeCliErrorDetail(stdout: string, stderr: string, signal: NodeJS.Signals | null): string {
  const trimmedStdout = String(stdout ?? "").trim();
  if (trimmedStdout) {
    try {
      const payload = JSON.parse(trimmedStdout) as {
        result?: unknown;
        is_error?: unknown;
        subtype?: unknown;
      };
      const resultText = String(payload.result ?? "").trim();
      if (payload.is_error === true && resultText) {
        return resultText;
      }
    } catch {
      // Ignore malformed CLI stdout and fall back to stderr below.
    }
  }

  const trimmedStderr = String(stderr ?? "").trim();
  if (trimmedStderr) {
    return trimmedStderr;
  }
  return signal ? `signal: ${signal}` : "";
}

async function runClaudeCodeCommand(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(claudeCodeCommand(), args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = setTimeout(() => {
      timeoutHandle = null;
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Claude Code CLI request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      const detail = error instanceof Error ? error.message : String(error ?? "Claude Code CLI process failed");
      reject(new ClaudeCodeCliError(classifyClaudeCodeCliError(detail), detail, detail));
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = extractClaudeCodeCliErrorDetail(stdout, stderr, signal);
      const suffix = detail ? `: ${detail.slice(0, 400)}` : "";
      const message = `Claude Code CLI exited with code ${code ?? "unknown"}${suffix}`;
      reject(new ClaudeCodeCliError(classifyClaudeCodeCliError(detail || message), message, detail));
    });
  });
}

export class ModelBudgetExceededError extends Error {
  budget: ModelUsageBudget;
  constructor(budget: ModelUsageBudget) {
    super(`Model request budget exceeded after ${budget.usage.requestCount} request(s).`);
    this.name = "ModelBudgetExceededError";
    this.budget = budget;
  }
}

function stripCodeFence(text: string): string {
  const trimmed = String(text ?? "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]+?)\s*```$/u);
  return fenced?.[1]?.trim() ?? trimmed;
}

function extractJsonText(text: string): string {
  const normalized = stripCodeFence(text);
  const firstBrace = normalized.search(/[{\[]/u);
  const lastBrace = Math.max(normalized.lastIndexOf("}"), normalized.lastIndexOf("]"));
  if (firstBrace >= 0 && lastBrace >= firstBrace) {
    return normalized.slice(firstBrace, lastBrace + 1);
  }
  return normalized;
}

function findBalancedJsonSlice(text: string, startIndex: number): string | null {
  const opening = text[startIndex];
  const closing = opening === "{" ? "}" : opening === "[" ? "]" : null;
  if (!closing) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === opening) {
      depth += 1;
      continue;
    }
    if (char === closing) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }
  return null;
}

function extractJsonCandidates(text: string): string[] {
  const normalized = stripCodeFence(text);
  const candidates = new Set<string>();
  const broadCandidate = extractJsonText(normalized).trim();
  if (broadCandidate) {
    candidates.add(broadCandidate);
  }
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char !== "{" && char !== "[") {
      continue;
    }
    const balanced = findBalancedJsonSlice(normalized, index)?.trim();
    if (balanced) {
      candidates.add(balanced);
    }
  }
  return Array.from(candidates);
}

function parseJsonPayload<TResponse>(text: string, schemaName: string): TResponse {
  let lastError: unknown = null;
  for (const candidate of extractJsonCandidates(text)) {
    try {
      return JSON.parse(candidate) as TResponse;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `${schemaName} model returned invalid JSON: ${lastError instanceof Error ? lastError.message : String(lastError ?? "no JSON object found")}`
  );
}

function joinAnthropicText(payload: {
  content?: Array<{ type?: string; text?: string }>;
}): string {
  return (payload.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text ?? ""))
    .join("\n")
    .trim();
}

function joinGeminiText(payload: {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}): string {
  return (payload.candidates?.[0]?.content?.parts ?? [])
    .map((part) => String(part?.text ?? ""))
    .join("\n")
    .trim();
}

function anthropicJsonPrompt(schemaName: string, schema: Record<string, unknown>, userPayload: unknown): string {
  return [
    `Schema name: ${schemaName}`,
    "Return only valid JSON that matches this JSON Schema exactly.",
    "Do not include markdown fences, prose, or extra keys.",
    `JSON Schema:\n${JSON.stringify(schema)}`,
    `Payload:\n${JSON.stringify(userPayload)}`
  ].join("\n\n");
}

function imageMediaType(filePath: string): string {
  const extension = path.extname(String(filePath ?? "")).trim().toLowerCase();
  switch (extension) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

async function prepareImageForModel(filePath: string): Promise<{ imagePath: string; cleanup: (() => Promise<void>) | null }> {
  const normalizedPath = String(filePath ?? "").trim();
  if (!normalizedPath) {
    return { imagePath: normalizedPath, cleanup: null };
  }

  let stat: { size?: number } | null = null;
  try {
    stat = await fs.stat(normalizedPath);
  } catch {
    return { imagePath: normalizedPath, cleanup: null };
  }

  const size = Number(stat?.size ?? 0);
  if (process.platform !== "darwin" || !Number.isFinite(size) || size <= 4_500_000) {
    return { imagePath: normalizedPath, cleanup: null };
  }

  const parsed = path.parse(normalizedPath);
  const resizedPath = path.join(parsed.dir, `${parsed.name}-vlm-${Date.now()}.png`);
  try {
    await execFileAsync("sips", ["-Z", "2200", normalizedPath, "--out", resizedPath]);
    return {
      imagePath: resizedPath,
      cleanup: async () => {
        await fs.rm(resizedPath, { force: true }).catch(() => null);
      }
    };
  } catch {
    await fs.rm(resizedPath, { force: true }).catch(() => null);
    return { imagePath: normalizedPath, cleanup: null };
  }
}

export class AgentModelClient {
  config: AgentModelConfig;
  constructor(config: AgentModelConfig) {
    this.config = config;
  }

  createUsageBudget({
    id,
    maxRequests
  }: {
    id: string;
    maxRequests: number;
  }): ModelUsageBudget {
    return {
      id,
      maxRequests: Math.max(0, Number(maxRequests) || 0),
      status: "ok",
      usage: emptyUsageSummary()
    };
  }

  async runWithUsageBudget<TResult>(
    budget: ModelUsageBudget,
    work: () => Promise<TResult>
  ): Promise<TResult> {
    return modelUsageStorage.run(budget, work);
  }

  usageSummary(budget: ModelUsageBudget | null | undefined): UsageSummary {
    return {
      ...(budget?.usage ?? emptyUsageSummary())
    };
  }

  isConfigured(): boolean {
    if (this.config.provider === "claude_code_cli") {
      return Boolean(this.config.name);
    }
    return Boolean(this.config.apiKey && this.config.name && this.config.baseUrl);
  }

  supportsImageJson(): boolean {
    if (this.isConfigured() && (this.config.provider === "anthropic" || this.config.provider === "gemini")) {
      return true;
    }

    return Boolean(this.#resolveImageFallbackConfig());
  }

  describe(): ModelClientStatus {
    return {
      configured: this.isConfigured(),
      provider: this.config.provider ?? null,
      providerLabel: this.config.provider ? modelProviderLabel(this.config.provider) : null,
      modelName: this.config.name ?? null,
      baseUrl: this.config.baseUrl ?? null,
      tier: this.config.tier ?? null
    };
  }

  #assertBudgetCapacity(): void {
    const budget = modelUsageStorage.getStore();
    if (!budget) {
      return;
    }

    if (budget.maxRequests > 0 && budget.usage.requestCount >= budget.maxRequests) {
      budget.status = "exceeded";
      throw new ModelBudgetExceededError(budget);
    }
  }

  #recordUsage(summary: Partial<UsageSummary>): void {
    const budget = modelUsageStorage.getStore();
    if (!budget) {
      return;
    }

    budget.usage = mergeUsage(budget.usage, summary);
  }

  async #requestJson<TPayload, TResponse>({
    schemaName,
    schema,
    systemPrompt,
    userPayload,
    temperature = 0.1
  }: JsonSchemaRequest<TPayload>): Promise<TResponse> {
    if (!this.isConfigured()) {
      throw new Error("Model client is not configured.");
    }

    if (this.config.provider === "anthropic") {
      return this.#requestAnthropicJson({
        schemaName,
        schema,
        systemPrompt,
        userPayload,
        temperature
      });
    }

    if (this.config.provider === "gemini") {
      return this.#requestGeminiJson({
        schemaName,
        schema,
        systemPrompt,
        userPayload,
        temperature
      });
    }

    if (this.config.provider === "claude_code_cli") {
      return this.#requestClaudeCodeJson({
        schemaName,
        schema,
        systemPrompt,
        userPayload
      });
    }

    return this.#requestOpenAICompatibleJson({
      schemaName,
      schema,
      systemPrompt,
      userPayload,
      temperature
    });
  }

  async analyzeImageJson<TResponse>({
    schemaName,
    schema,
    systemPrompt,
    userPrompt,
    imagePath,
    temperature = 0
  }: ImageJsonSchemaRequest<TResponse>): Promise<TResponse> {
    if (!this.isConfigured()) {
      const fallback = this.#resolveImageFallbackClient();
      if (fallback) {
        return fallback.analyzeImageJson({
          schemaName,
          schema,
          systemPrompt,
          userPrompt,
          imagePath,
          temperature
        });
      }
      throw new Error("Model client is not configured.");
    }

    if (this.config.provider === "anthropic") {
      try {
        return await this.#requestAnthropicImageJson({
          schemaName,
          schema,
          systemPrompt,
          userPrompt,
          imagePath,
          temperature
        });
      } catch (error) {
        const fallback = this.#resolveImageFallbackClient(["anthropic"]);
        if (fallback && shouldFallbackImageError(error)) {
          return fallback.analyzeImageJson({
            schemaName,
            schema,
            systemPrompt,
            userPrompt,
            imagePath,
            temperature
          });
        }
        throw error;
      }
    }

    if (this.config.provider === "gemini") {
      return this.#requestGeminiImageJson({
        schemaName,
        schema,
        systemPrompt,
        userPrompt,
        imagePath,
        temperature
      });
    }

    const fallback = this.#resolveImageFallbackClient([this.config.provider]);
    if (fallback) {
      return fallback.analyzeImageJson({
        schemaName,
        schema,
        systemPrompt,
        userPrompt,
        imagePath,
        temperature
      });
    }

    throw new Error(`Image JSON analysis is not supported for provider ${this.config.provider}.`);
  }

  async #requestOpenAICompatibleJson<TPayload, TResponse>({
    schemaName,
    schema,
    systemPrompt,
    userPayload,
    temperature
  }: JsonSchemaRequest<TPayload>): Promise<TResponse> {
    this.#assertBudgetCapacity();
    const response = await fetch(`${String(this.config.baseUrl).replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: this.config.name,
        temperature,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: schemaName,
            schema
          }
        },
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: JSON.stringify(userPayload)
          }
        ]
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs)
    });

    if (!response.ok) {
      throw new Error(`planner model request failed: ${response.status}`);
    }

    const payload = (await response.json()) as {
      usage?: Record<string, unknown>;
      choices?: Array<{ message?: { content?: string } }>;
    };
    this.#recordUsage(usageSummaryFromOpenAI(payload as Record<string, unknown>));
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(`${schemaName} model returned no content`);
    }

    return JSON.parse(content) as TResponse;
  }

  async #requestAnthropicJson<TPayload, TResponse>({
    schemaName,
    schema,
    systemPrompt,
    userPayload,
    temperature
  }: JsonSchemaRequest<TPayload>): Promise<TResponse> {
    this.#assertBudgetCapacity();
    const response = await fetch(`${String(this.config.baseUrl).replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": String(this.config.apiKey),
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: this.config.name,
        max_tokens: 2048,
        temperature,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: anthropicJsonPrompt(schemaName, schema, userPayload)
          }
        ]
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs)
    });

    if (!response.ok) {
      throw new Error(`planner model request failed: ${response.status}`);
    }

    const payload = (await response.json()) as {
      usage?: Record<string, unknown>;
      content?: Array<{ type?: string; text?: string }>;
    };
    this.#recordUsage(usageSummaryFromAnthropic(payload as Record<string, unknown>));
    const content = joinAnthropicText(payload);
    if (!content) {
      throw new Error(`${schemaName} model returned no content`);
    }

    return parseJsonPayload<TResponse>(content, schemaName);
  }

  async #requestGeminiJson<TPayload, TResponse>({
    schemaName,
    schema,
    systemPrompt,
    userPayload,
    temperature
  }: JsonSchemaRequest<TPayload>): Promise<TResponse> {
    this.#assertBudgetCapacity();
    const baseUrl = String(this.config.baseUrl).replace(/\/$/, "");
    const model = encodeURIComponent(String(this.config.name));
    const response = await fetch(`${baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(String(this.config.apiKey))}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: `${systemPrompt}\nReturn only valid JSON that matches the provided schema.`
            }
          ]
        },
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `Schema name: ${schemaName}\nJSON schema:\n${JSON.stringify(schema)}\n\nPayload:\n${JSON.stringify(userPayload)}`
              }
            ]
          }
        ],
        generationConfig: {
          temperature,
          responseMimeType: "application/json",
          responseJsonSchema: schema
        }
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs)
    });

    if (!response.ok) {
      throw new Error(`planner model request failed: ${response.status}`);
    }

    const payload = (await response.json()) as {
      usageMetadata?: Record<string, unknown>;
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };
    this.#recordUsage(usageSummaryFromGemini(payload as Record<string, unknown>));
    const content = joinGeminiText(payload);
    if (!content) {
      throw new Error(`${schemaName} model returned no content`);
    }

    return parseJsonPayload<TResponse>(content, schemaName);
  }

  async #requestClaudeCodeJson<TPayload, TResponse>({
    schemaName,
    schema,
    systemPrompt,
    userPayload
  }: JsonSchemaRequest<TPayload>): Promise<TResponse> {
    this.#assertBudgetCapacity();
    const prompt = [
      `Schema name: ${schemaName}`,
      "Return only valid JSON that matches the provided JSON Schema exactly.",
      "Do not include markdown fences, prose, or extra keys.",
      `JSON Schema:\n${JSON.stringify(schema)}`,
      `Payload:\n${JSON.stringify(userPayload)}`
    ].join("\n\n");

    const args = [
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "plan",
      "--tools",
      "",
      "--no-session-persistence",
      "--model",
      String(this.config.name),
      "--system-prompt",
      systemPrompt,
      "--json-schema",
      JSON.stringify(schema),
      prompt
    ];

    try {
      const result = await runClaudeCodeCommand(args, this.config.timeoutMs);
      const payload = JSON.parse(String(result.stdout ?? "{}")) as {
        structured_output?: TResponse;
        result?: string;
        usage?: Record<string, unknown>;
      };
      this.#recordUsage(usageSummaryFromClaudeCode(payload as Record<string, unknown>));
      if (payload.structured_output) {
        return payload.structured_output;
      }
      return parseJsonPayload<TResponse>(String(payload.result ?? ""), schemaName);
    } catch (error) {
      if (error instanceof ClaudeCodeCliError) {
        if (error.kind === "reauth_required") {
          throw new Error("Claude Code CLI requires reauthentication. Run `claude /login` in your terminal and try again.");
        }
        if (error.kind === "unavailable") {
          throw new Error("Claude Code CLI is unavailable. Install `claude` or point AGENTOS_CLAUDE_CODE_BIN at a working Claude Code binary.");
        }
      }
      const stderr =
        error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "").trim() : "";
      const detail = stderr ? `: ${stderr.slice(0, 400)}` : "";
      throw new Error(`Claude Code CLI request failed${detail}`);
    }
  }

  async #requestAnthropicImageJson<TResponse>({
    schemaName,
    schema,
    systemPrompt,
    userPrompt,
    imagePath,
    temperature
  }: ImageJsonSchemaRequest<TResponse>): Promise<TResponse> {
    this.#assertBudgetCapacity();
    const preparedImage = await prepareImageForModel(imagePath);
    try {
      const imageData = await fs.readFile(preparedImage.imagePath, { encoding: "base64" });
      const response = await fetch(`${String(this.config.baseUrl).replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": String(this.config.apiKey),
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: this.config.name,
          max_tokens: 2048,
          temperature,
          system: systemPrompt,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: [
                    `Schema name: ${schemaName}`,
                    "Return only valid JSON that matches this JSON Schema exactly.",
                    "Do not include markdown fences, prose, or extra keys.",
                    `JSON Schema:\n${JSON.stringify(schema)}`,
                    userPrompt
                  ].join("\n\n")
                },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: imageMediaType(preparedImage.imagePath),
                    data: imageData
                  }
                }
              ]
            }
          ]
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs)
      });

      if (!response.ok) {
        const errorBody = (await response.text().catch(() => "")).trim();
        const detail = errorBody ? `: ${errorBody.slice(0, 400)}` : "";
        throw new Error(`image model request failed: ${response.status}${detail}`);
      }

      const payload = (await response.json()) as {
        usage?: Record<string, unknown>;
        content?: Array<{ type?: string; text?: string }>;
      };
      this.#recordUsage(usageSummaryFromAnthropic(payload as Record<string, unknown>));
      const content = joinAnthropicText(payload);
      if (!content) {
        throw new Error(`${schemaName} model returned no content`);
      }

      return parseJsonPayload<TResponse>(content, schemaName);
    } finally {
      await preparedImage.cleanup?.();
    }
  }

  async #requestGeminiImageJson<TResponse>({
    schemaName,
    schema,
    systemPrompt,
    userPrompt,
    imagePath,
    temperature
  }: ImageJsonSchemaRequest<TResponse>): Promise<TResponse> {
    this.#assertBudgetCapacity();
    const preparedImage = await prepareImageForModel(imagePath);
    try {
      const imageData = await fs.readFile(preparedImage.imagePath, { encoding: "base64" });
      const baseUrl = String(this.config.baseUrl).replace(/\/$/, "");
      const model = encodeURIComponent(String(this.config.name));
      const response = await fetch(`${baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(String(this.config.apiKey))}`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: systemPrompt
              }
            ]
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  inline_data: {
                    mime_type: imageMediaType(preparedImage.imagePath),
                    data: imageData
                  }
                },
                {
                  text: [
                    `Schema name: ${schemaName}`,
                    "Return only valid JSON that matches this JSON Schema exactly.",
                    "Do not include markdown fences, prose, or extra keys.",
                    `JSON Schema:\n${JSON.stringify(schema)}`,
                    userPrompt
                  ].join("\n\n")
                }
              ]
            }
          ],
          generationConfig: {
            temperature,
            responseMimeType: "application/json",
            responseJsonSchema: schema
          }
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs)
      });

      if (!response.ok) {
        const errorBody = (await response.text().catch(() => "")).trim();
        const detail = errorBody ? `: ${errorBody.slice(0, 400)}` : "";
        throw new Error(`image model request failed: ${response.status}${detail}`);
      }

      const payload = (await response.json()) as {
        usageMetadata?: Record<string, unknown>;
        candidates?: Array<{
          content?: {
            parts?: Array<{ text?: string }>;
          };
        }>;
      };
      this.#recordUsage(usageSummaryFromGemini(payload as Record<string, unknown>));
      const content = joinGeminiText(payload);
      if (!content) {
        throw new Error(`${schemaName} model returned no content`);
      }

      return parseJsonPayload<TResponse>(content, schemaName);
    } finally {
      await preparedImage.cleanup?.();
    }
  }

  #resolveImageFallbackClient(excludedProviders: AgentModelProvider[] = []): AgentModelClient | null {
    const config = this.#resolveImageFallbackConfig(excludedProviders);
    return config ? new AgentModelClient(config) : null;
  }

  #resolveImageFallbackConfig(excludedProviders: AgentModelProvider[] = []): AgentModelConfig | null {
    const excluded = new Set<AgentModelProvider>(excludedProviders);
    const tier = this.config.tier ?? "balanced";
    const geminiKey = String(process.env.GEMINI_API_KEY ?? "").trim();
    if (!excluded.has("gemini") && geminiKey) {
      return {
        provider: "gemini",
        apiKey: geminiKey,
        baseUrl: defaultModelBaseUrl("gemini"),
        name: defaultModelName("gemini", tier) ?? "gemini-2.5-flash",
        tier,
        timeoutMs: this.config.timeoutMs
      };
    }
    return null;
  }

  async planTask(taskSpec: TaskSpec): Promise<ModelPlanResponse> {
    return this.#requestJson<TaskSpec, ModelPlanResponse>({
      schemaName: "agentos_plan",
      schema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                surface: { type: "string" },
                action: { type: "string" },
                params: { type: "object" },
                expect: { type: "object" },
                saveAs: { type: ["string", "null"] },
                checkpoint: { type: ["boolean", "null"] }
              },
              required: ["label", "surface", "action", "params"],
              additionalProperties: false
            }
          }
        },
        required: ["steps"],
        additionalProperties: false
      },
      systemPrompt:
        "You are the Planner agent of AgentOS. Produce a concise step plan for a local worker. Use browser or desktop surfaces.",
      userPayload: taskSpec
    });
  }

  async decideNextAction(payload: {
    taskSpec: TaskSpec;
    preferredSurface: "browser" | "desktop";
    observation: WorldState;
    previousSteps: Array<{ label: string; action: string; surface: string; result: unknown }>;
    allowedActions: string[];
  }): Promise<ModelAutonomyDecision> {
    return this.#requestJson<typeof payload, ModelAutonomyDecision>({
      schemaName: "agentos_autonomy_decision",
      schema: {
        type: "object",
        properties: {
          done: { type: "boolean" },
          reason: { type: "string" },
          summary: { type: ["string", "null"] },
          action: {
            type: ["object", "null"],
            properties: {
              label: { type: "string" },
              surface: { type: "string" },
              action: { type: "string" },
              params: { type: "object" },
              expect: { type: ["object", "null"] },
              saveAs: { type: ["string", "null"] },
              checkpoint: { type: ["boolean", "null"] }
            },
            required: ["label", "surface", "action", "params"],
            additionalProperties: false
          }
        },
        required: ["done", "reason"],
        additionalProperties: false
      },
      systemPrompt:
        "You are the Autonomy agent of AgentOS. Decide one safe next action at a time from the visible local observation. Return done=true only when the task is verifiably complete.",
      userPayload: payload,
      temperature: 0
    });
  }

  async draftReply(payload: {
    goal: string;
    livePack: string;
    summary: string;
    context: string[];
    stylePreferences?: string[];
    replyLanguageHint?: "en" | "zh" | null;
  }): Promise<ModelDraftReply> {
    return this.#requestJson<typeof payload, ModelDraftReply>({
      schemaName: "agentos_live_reply",
      schema: {
        type: "object",
        properties: {
          replyText: { type: "string" },
          confidence: { type: ["number", "null"] },
          rationale: { type: ["string", "null"] }
        },
        required: ["replyText"],
        additionalProperties: false
      },
      systemPrompt:
        "You draft concise, low-risk replies for a personal local agent. Acknowledge the message, avoid making commitments you cannot verify, and follow any learned reply style preferences when they are compatible with the current context. If replyLanguageHint is set, you must write the reply in that language. Otherwise, match the predominant language used in the current thread.",
      userPayload: payload,
      temperature: 0.2
    });
  }
}

export { AgentModelClient as OpenAICompatibleModelClient };

function shouldFallbackImageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  return normalized.includes("credit balance is too low") ||
    normalized.includes("quota") ||
    normalized.includes("billing") ||
    normalized.includes("payment") ||
    normalized.includes("insufficient");
}
