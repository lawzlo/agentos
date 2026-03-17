import type { AgentModelConfig } from "../config.js";
import type { RuntimeStep, TaskSpec, WorldState } from "../types/runtime-schema.js";

interface JsonSchemaRequest<TPayload> {
  schemaName: string;
  schema: Record<string, unknown>;
  systemPrompt: string;
  userPayload: TPayload;
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

export class OpenAICompatibleModelClient {
  config: AgentModelConfig;
  constructor(config: AgentModelConfig) {
    this.config = config;
  }

  isConfigured(): boolean {
    return Boolean(this.config.baseUrl && this.config.apiKey && this.config.name);
  }

  async #requestJson<TPayload, TResponse>({
    schemaName,
    schema,
    systemPrompt,
    userPayload,
    temperature = 0.1
  }: JsonSchemaRequest<TPayload>): Promise<TResponse> {
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
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
        "You draft concise, low-risk replies for a personal local agent. Acknowledge the message, avoid making commitments you cannot verify, and prefer a short confirmation style.",
      userPayload: payload,
      temperature: 0.2
    });
  }
}
