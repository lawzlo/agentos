export class OpenAICompatibleModelClient {
  config: any;
  constructor(config) {
    this.config = config;
  }

  isConfigured() {
    return Boolean(this.config.baseUrl && this.config.apiKey && this.config.name);
  }

  async #requestJson({ schemaName, schema, systemPrompt, userPayload, temperature = 0.1 }) {
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

    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(`${schemaName} model returned no content`);
    }

    return JSON.parse(content);
  }

  async planTask(taskSpec) {
    return this.#requestJson({
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

  async decideNextAction(payload) {
    return this.#requestJson({
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
}
