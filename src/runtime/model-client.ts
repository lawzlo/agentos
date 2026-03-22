import fs from "node:fs/promises";
import path from "node:path";

import type {
  AgentModelConfig,
  AgentModelProvider,
  AgentModelTier
} from "../config.js";
import { modelProviderLabel } from "../config.js";
import type { RuntimeStep, TaskSpec, WorldState } from "../types/runtime-schema.js";

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

export interface ModelClientStatus {
  configured: boolean;
  provider: AgentModelProvider | null;
  providerLabel: string | null;
  modelName: string | null;
  baseUrl: string | null;
  tier: AgentModelTier | null;
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

function parseJsonPayload<TResponse>(text: string, schemaName: string): TResponse {
  try {
    return JSON.parse(extractJsonText(text)) as TResponse;
  } catch (error) {
    throw new Error(
      `${schemaName} model returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
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

export class AgentModelClient {
  config: AgentModelConfig;
  constructor(config: AgentModelConfig) {
    this.config = config;
  }

  isConfigured(): boolean {
    return Boolean(this.config.apiKey && this.config.name && this.config.baseUrl);
  }

  supportsImageJson(): boolean {
    return this.isConfigured() && this.config.provider === "anthropic";
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
      throw new Error("Model client is not configured.");
    }

    if (this.config.provider !== "anthropic") {
      throw new Error(`Image JSON analysis is not supported for provider ${this.config.provider}.`);
    }

    const imageData = await fs.readFile(imagePath, { encoding: "base64" });
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
                  media_type: imageMediaType(imagePath),
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
      throw new Error(`image model request failed: ${response.status}`);
    }

    const payload = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const content = joinAnthropicText(payload);
    if (!content) {
      throw new Error(`${schemaName} model returned no content`);
    }

    return parseJsonPayload<TResponse>(content, schemaName);
  }

  async #requestOpenAICompatibleJson<TPayload, TResponse>({
    schemaName,
    schema,
    systemPrompt,
    userPayload,
    temperature
  }: JsonSchemaRequest<TPayload>): Promise<TResponse> {
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
      choices?: Array<{ message?: { content?: string } }>;
    };
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
      content?: Array<{ type?: string; text?: string }>;
    };
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
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };
    const content = joinGeminiText(payload);
    if (!content) {
      throw new Error(`${schemaName} model returned no content`);
    }

    return parseJsonPayload<TResponse>(content, schemaName);
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
        "You draft concise, low-risk replies for a personal local agent. Acknowledge the message, avoid making commitments you cannot verify, and follow any learned reply style preferences when they are compatible with the current context.",
      userPayload: payload,
      temperature: 0.2
    });
  }
}

export { AgentModelClient as OpenAICompatibleModelClient };
