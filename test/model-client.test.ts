import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentModelClient } from "../src/runtime/model-client.js";

async function startCaptureServer(handler: (request: {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}) => Promise<{
  status?: number;
  payload: unknown;
}> | {
  status?: number;
  payload: unknown;
}) {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const bodyText = Buffer.concat(chunks).toString("utf8");
    const result = await handler({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: req.headers,
      body: bodyText ? JSON.parse(bodyText) : {}
    });
    res.writeHead(result.status ?? 200, {
      "content-type": "application/json; charset=utf-8"
    });
    res.end(JSON.stringify(result.payload));
  });

  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      const closePromise = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await closePromise;
    }
  };
}

test("openai-compatible model client uses chat completions structured output requests", async () => {
  let captured: Record<string, unknown> | null = null;
  const server = await startCaptureServer((request) => {
    captured = request as Record<string, unknown>;
    return {
      payload: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                replyText: "OpenAI style reply"
              })
            }
          }
        ]
      }
    };
  });

  try {
    const client = new AgentModelClient({
      provider: "openai_compatible",
      baseUrl: server.baseUrl,
      apiKey: "sk-openai-test",
      name: "demo-model",
      tier: "balanced",
      timeoutMs: 5000
    });
    const reply = await client.draftReply({
      goal: "Reply politely",
      livePack: "generic-mail-browser",
      summary: "Customer asked for a quick update.",
      context: ["Customer: can you send a quick update?"],
      stylePreferences: ["Keep replies concise and direct."]
    });

    assert.equal(reply.replyText, "OpenAI style reply");
    assert.equal(captured?.url, "/chat/completions");
    assert.equal((captured?.headers as http.IncomingHttpHeaders).authorization, "Bearer sk-openai-test");
    const body = captured?.body as Record<string, unknown>;
    assert.equal((body.response_format as { type?: string }).type, "json_schema");
    const userMessage = ((body.messages as Array<{ role?: string; content?: string }>) ?? []).find(
      (entry) => entry.role === "user"
    );
    const payload = JSON.parse(String(userMessage?.content ?? "{}"));
    assert.equal(payload.livePack, "generic-mail-browser");
    assert.equal(payload.stylePreferences[0], "Keep replies concise and direct.");
  } finally {
    await server.close();
  }
});

test("anthropic model client uses the Messages API", async () => {
  let captured: Record<string, unknown> | null = null;
  const server = await startCaptureServer((request) => {
    captured = request as Record<string, unknown>;
    return {
      payload: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              replyText: "Claude style reply"
            })
          }
        ]
      }
    };
  });

  try {
    const client = new AgentModelClient({
      provider: "anthropic",
      baseUrl: server.baseUrl,
      apiKey: "sk-ant-test",
      name: "claude-sonnet-4-5",
      tier: "balanced",
      timeoutMs: 5000
    });
    const reply = await client.draftReply({
      goal: "Reply politely",
      livePack: "slack-browser",
      summary: "Customer asked for status.",
      context: ["Customer: Any status update?"]
    });

    assert.equal(reply.replyText, "Claude style reply");
    assert.equal(captured?.url, "/v1/messages");
    assert.equal((captured?.headers as http.IncomingHttpHeaders)["x-api-key"], "sk-ant-test");
    assert.equal((captured?.headers as http.IncomingHttpHeaders)["anthropic-version"], "2023-06-01");
    const body = captured?.body as Record<string, unknown>;
    assert.equal(body.model, "claude-sonnet-4-5");
    assert.equal(Array.isArray(body.messages), true);
    assert.equal("output_config" in body, false);
    assert.match(String((body.messages as Array<{ content?: string }>)?.[0]?.content ?? ""), /JSON Schema:/);
  } finally {
    await server.close();
  }
});

test("anthropic model client can analyze an image into structured JSON", async () => {
  let captured: Record<string, unknown> | null = null;
  const server = await startCaptureServer((request) => {
    captured = request as Record<string, unknown>;
    return {
      payload: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              openThread: "Tan",
              visibleUnreadThreads: [{ name: "Tan", evidence: "badge", approxSidebarY: 0.2 }],
              composer: {
                present: true,
                evidence: "bottom input",
                approxBox: { x: 0.3, y: 0.84, width: 0.6, height: 0.12 }
              }
            })
          }
        ]
      }
    };
  });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentos-model-image-"));
  const imagePath = path.join(tempDir, "wechat.png");

  try {
    await fs.writeFile(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));
    const client = new AgentModelClient({
      provider: "anthropic",
      baseUrl: server.baseUrl,
      apiKey: "sk-ant-test",
      name: "claude-opus-4-6",
      tier: "strong",
      timeoutMs: 5000
    });

    const payload = await client.analyzeImageJson<{
      openThread: string | null;
      visibleUnreadThreads: unknown[];
      composer: Record<string, unknown>;
    }>({
      schemaName: "agentos_wechat_visual",
      schema: {
        type: "object",
        properties: {
          openThread: { type: ["string", "null"] },
          visibleUnreadThreads: { type: "array" },
          composer: { type: "object" }
        },
        required: ["openThread", "visibleUnreadThreads", "composer"],
        additionalProperties: false
      },
      systemPrompt: "Analyze the image and return structured UI data.",
      userPrompt: "Find the unread thread and composer.",
      imagePath
    });

    assert.equal(payload.openThread, "Tan");
    assert.equal(Array.isArray(payload.visibleUnreadThreads), true);
    const body = captured?.body as Record<string, unknown>;
    const messages = (body.messages as Array<{ content?: Array<Record<string, unknown>> }>) ?? [];
    const content = messages[0]?.content ?? [];
    const imageBlock = content.find((entry) => entry.type === "image") as
      | { source?: { media_type?: string; data?: string } }
      | undefined;
    assert.equal(body.model, "claude-opus-4-6");
    assert.equal(imageBlock?.source?.media_type, "image/png");
    assert.equal(typeof imageBlock?.source?.data, "string");
  } finally {
    await server.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("anthropic model client tolerates extra trailing prose around image JSON output", async () => {
  const server = await startCaptureServer(() => ({
    payload: {
      content: [
        {
          type: "text",
          text: [
            "Here is the grounded result:",
            JSON.stringify({
              openThread: "Tan",
              visibleUnreadThreads: [],
              composer: {
                present: true,
                evidence: "bottom input",
                approxBox: { x: 0.3, y: 0.84, width: 0.6, height: 0.12 }
              }
            }),
            "Done."
          ].join("\n")
        }
      ]
    }
  }));

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentos-model-image-trailing-"));
  const imagePath = path.join(tempDir, "wechat.png");

  try {
    await fs.writeFile(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));
    const client = new AgentModelClient({
      provider: "anthropic",
      baseUrl: server.baseUrl,
      apiKey: "sk-ant-test",
      name: "claude-opus-4-6",
      tier: "strong",
      timeoutMs: 5000
    });

    const payload = await client.analyzeImageJson<{
      openThread: string | null;
      visibleUnreadThreads: unknown[];
      composer: { present: boolean };
    }>({
      schemaName: "agentos_wechat_visual_trailing",
      schema: {
        type: "object",
        properties: {
          openThread: { type: ["string", "null"] },
          visibleUnreadThreads: { type: "array" },
          composer: { type: "object" }
        },
        required: ["openThread", "visibleUnreadThreads", "composer"],
        additionalProperties: false
      },
      systemPrompt: "Analyze the image and return structured UI data.",
      userPrompt: "Find the unread thread and composer.",
      imagePath
    });

    assert.equal(payload.openThread, "Tan");
    assert.equal(payload.composer.present, true);
  } finally {
    await server.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("gemini model client uses generateContent with JSON schema output", async () => {
  let captured: Record<string, unknown> | null = null;
  const server = await startCaptureServer((request) => {
    captured = request as Record<string, unknown>;
    return {
      payload: {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    replyText: "Gemini style reply"
                  })
                }
              ]
            }
          }
        ]
      }
    };
  });

  try {
    const client = new AgentModelClient({
      provider: "gemini",
      baseUrl: server.baseUrl,
      apiKey: "gem-test-key",
      name: "gemini-2.5-flash",
      tier: "balanced",
      timeoutMs: 5000
    });
    const reply = await client.draftReply({
      goal: "Reply politely",
      livePack: "wechat-desktop",
      summary: "客户问进度",
      context: ["客户：现在方便同步进度吗？"]
    });

    assert.equal(reply.replyText, "Gemini style reply");
    assert.match(String(captured?.url ?? ""), /\/models\/gemini-2\.5-flash:generateContent\?key=gem-test-key$/u);
    const body = captured?.body as Record<string, unknown>;
    assert.equal(
      ((body.generationConfig as { responseMimeType?: string })?.responseMimeType ?? null),
      "application/json"
    );
    assert.equal(
      typeof ((body.generationConfig as { responseJsonSchema?: unknown })?.responseJsonSchema ?? null),
      "object"
    );
  } finally {
    await server.close();
  }
});

test("gemini model client can analyze an image into structured JSON", async () => {
  let captured: Record<string, unknown> | null = null;
  const server = await startCaptureServer((request) => {
    captured = request as Record<string, unknown>;
    return {
      payload: {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    openThread: "Inbox",
                    visibleUnreadThreads: [
                      {
                        name: "Inbox",
                        evidence: "bold unread row",
                        approxBox: { x: 0.2, y: 0.25, width: 0.2, height: 0.08 }
                      }
                    ],
                    composer: {
                      present: true,
                      evidence: "message box",
                      approxBox: { x: 0.3, y: 0.82, width: 0.6, height: 0.13 }
                    }
                  })
                }
              ]
            }
          }
        ]
      }
    };
  });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentos-model-gemini-image-"));
  const imagePath = path.join(tempDir, "slack.png");

  try {
    await fs.writeFile(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));
    const client = new AgentModelClient({
      provider: "gemini",
      baseUrl: server.baseUrl,
      apiKey: "gem-test-key",
      name: "gemini-2.5-flash",
      tier: "balanced",
      timeoutMs: 5000
    });

    const payload = await client.analyzeImageJson<{
      openThread: string | null;
      visibleUnreadThreads: unknown[];
      composer: { present: boolean };
    }>({
      schemaName: "agentos_desktop_visual",
      schema: {
        type: "object",
        properties: {
          openThread: { type: ["string", "null"] },
          visibleUnreadThreads: { type: "array" },
          composer: { type: "object" }
        },
        required: ["openThread", "visibleUnreadThreads", "composer"],
        additionalProperties: false
      },
      systemPrompt: "Analyze the desktop screenshot and return structured UI state.",
      userPrompt: "Find the unread thread and message composer.",
      imagePath
    });

    assert.equal(payload.openThread, "Inbox");
    assert.equal(payload.composer.present, true);
    assert.match(String(captured?.url ?? ""), /\/models\/gemini-2\.5-flash:generateContent\?key=gem-test-key$/u);
    const body = captured?.body as Record<string, unknown>;
    const parts =
      (((body.contents as Array<{ parts?: Array<Record<string, unknown>> }>)?.[0]?.parts ?? []) as Array<Record<string, unknown>>);
    const imagePart = parts.find((part) => "inline_data" in part) as
      | { inline_data?: { mime_type?: string; data?: string } }
      | undefined;
    assert.equal(imagePart?.inline_data?.mime_type, "image/png");
    assert.equal(typeof imagePart?.inline_data?.data, "string");
    assert.equal(
      ((body.generationConfig as { responseMimeType?: string })?.responseMimeType ?? null),
      "application/json"
    );
  } finally {
    await server.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("model client tracks usage and enforces a per-run request budget", async () => {
  let requestCount = 0;
  const server = await startCaptureServer(() => {
    requestCount += 1;
    return {
      payload: {
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18
        },
        choices: [
          {
            message: {
              content: JSON.stringify({
                replyText: "Budgeted reply"
              })
            }
          }
        ]
      }
    };
  });

  try {
    const client = new AgentModelClient({
      provider: "openai_compatible",
      baseUrl: server.baseUrl,
      apiKey: "sk-openai-test",
      name: "demo-model",
      tier: "balanced",
      timeoutMs: 5000
    });
    const budget = client.createUsageBudget({
      id: "watch:test-budget",
      maxRequests: 1
    });

    const reply = await client.runWithUsageBudget(budget, async () =>
      client.draftReply({
        goal: "Reply politely",
        livePack: "slack-desktop",
        summary: "Budget check",
        context: ["Can you confirm the budget guard?"]
      })
    );

    assert.equal(reply.replyText, "Budgeted reply");
    assert.equal(budget.usage.requestCount, 1);
    assert.equal(budget.usage.inputTokens, 11);
    assert.equal(budget.usage.outputTokens, 7);
    assert.equal(budget.usage.totalTokens, 18);

    await assert.rejects(
      () =>
        client.runWithUsageBudget(budget, async () =>
          client.draftReply({
            goal: "Reply politely",
            livePack: "slack-desktop",
            summary: "Budget check again",
            context: ["Second call should be blocked."]
          })
        ),
      /budget exceeded/i
    );
    assert.equal(requestCount, 1);
  } finally {
    await server.close();
  }
});

test("claude_code_cli model client uses local Claude Code print mode for structured plans and drafts", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentos-claude-code-cli-"));
  const fakeCliPath = path.join(tempDir, "fake-claude");
  const capturePath = path.join(tempDir, "capture.json");
  const previousCli = process.env.AGENTOS_CLAUDE_CODE_BIN;
  process.env.AGENTOS_CLAUDE_CODE_BIN = fakeCliPath;

  try {
    await fs.writeFile(
      fakeCliPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.AGENTOS_CLAUDE_CODE_CAPTURE, JSON.stringify({ args }, null, 2), "utf8");
const schemaIndex = args.indexOf("--json-schema");
const schema = schemaIndex >= 0 ? JSON.parse(args[schemaIndex + 1]) : {};
if (schema.properties && schema.properties.steps) {
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    structured_output: {
      summary: "Local Claude Code plan",
      steps: [
        {
          label: "Focus Slack",
          surface: "desktop",
          action: "focusApp",
          params: { name: "Slack" }
        }
      ]
    }
  }));
} else if (schema.properties && schema.properties.replyText) {
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    structured_output: {
      replyText: "Local Claude Code reply",
      confidence: 0.91
    }
  }));
} else {
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    structured_output: {
      latestInboundMessage: "Can we talk Wednesday afternoon?",
      salientContext: ["Can we talk Wednesday afternoon?"],
      speakerRole: "candidate",
      threadSummary: "Lazaro Waters"
    }
  }));
}
`,
      "utf8"
    );
    await fs.chmod(fakeCliPath, 0o755);
    process.env.AGENTOS_CLAUDE_CODE_CAPTURE = capturePath;

    const client = new AgentModelClient({
      provider: "claude_code_cli",
      name: "sonnet",
      tier: "balanced",
      timeoutMs: 5000
    });

    const plan = await client.planTask({
      goal: "Focus Slack",
      preferredSurface: "desktop",
      inputs: {},
      steps: []
    });
    assert.equal(plan.summary, "Local Claude Code plan");
    assert.equal(plan.steps[0]?.action, "focusApp");

    const draft = await client.draftReply({
      goal: "Reply politely",
      livePack: "slack-desktop",
      summary: "Need a quick reply",
      context: ["Can you send a quick acknowledgment?"]
    });
    assert.equal(draft.replyText, "Local Claude Code reply");

    const semanticFacts = await client.completeJson<
      { thread: string },
      {
        latestInboundMessage: string;
        salientContext: string[];
        speakerRole: string;
        threadSummary: string;
      }
    >({
      schemaName: "agentos_boss_semantic_facts",
      schema: {
        type: "object",
        properties: {
          latestInboundMessage: { type: "string" },
          salientContext: { type: "array", items: { type: "string" } },
          speakerRole: { type: "string" },
          threadSummary: { type: "string" }
        },
        required: ["latestInboundMessage", "salientContext", "speakerRole", "threadSummary"],
        additionalProperties: false
      },
      systemPrompt: "Return semantic facts.",
      userPayload: {
        thread: "Lazaro Waters"
      }
    });
    assert.equal(semanticFacts.latestInboundMessage, "Can we talk Wednesday afternoon?");
    assert.equal(semanticFacts.speakerRole, "candidate");

    const captured = JSON.parse(await fs.readFile(capturePath, "utf8"));
    assert.equal(captured.args.includes("-p"), true);
    assert.equal(captured.args.includes("--no-session-persistence"), true);
    assert.equal(captured.args.includes("--bare"), false);
    assert.equal(captured.args.includes("--json-schema"), true);
    assert.equal(captured.args.includes("--output-format"), true);
    assert.equal(captured.args[captured.args.indexOf("--output-format") + 1], "json");
    assert.equal(captured.args.includes("--system-prompt"), true);
    assert.equal(captured.args.includes("--permission-mode"), true);
    assert.equal(captured.args[captured.args.indexOf("--permission-mode") + 1], "plan");
    assert.equal(captured.args.includes("--tools"), true);
    assert.equal(captured.args[captured.args.indexOf("--tools") + 1], "");
    assert.equal(captured.args[captured.args.indexOf("--model") + 1], "sonnet");
  } finally {
    if (previousCli === undefined) {
      delete process.env.AGENTOS_CLAUDE_CODE_BIN;
    } else {
      process.env.AGENTOS_CLAUDE_CODE_BIN = previousCli;
    }
    delete process.env.AGENTOS_CLAUDE_CODE_CAPTURE;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("claude_code_cli closes stdin so the local CLI does not fail waiting for piped input", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentos-claude-code-stdin-"));
  const fakeCliPath = path.join(tempDir, "fake-claude-stdin");
  const previousCli = process.env.AGENTOS_CLAUDE_CODE_BIN;
  process.env.AGENTOS_CLAUDE_CODE_BIN = fakeCliPath;

  try {
    await fs.writeFile(
      fakeCliPath,
      `#!/usr/bin/env node
let settled = false;
function finish() {
  if (settled) return;
  settled = true;
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    structured_output: {
      replyText: "stdin closed reply"
    }
  }));
}
process.stdin.setEncoding("utf8");
process.stdin.on("end", finish);
process.stdin.resume();
setTimeout(() => {
  if (settled) return;
  console.error("Warning: no stdin data received in 3s, proceeding without it.");
  process.exit(1);
}, 50);
`,
      "utf8"
    );
    await fs.chmod(fakeCliPath, 0o755);

    const client = new AgentModelClient({
      provider: "claude_code_cli",
      name: "sonnet",
      tier: "balanced",
      timeoutMs: 5000
    });

    const draft = await client.draftReply({
      goal: "Reply politely",
      livePack: "outlook-desktop",
      summary: "Need a quick reply",
      context: ["Please confirm receipt."]
    });

    assert.equal(draft.replyText, "stdin closed reply");
  } finally {
    if (previousCli === undefined) {
      delete process.env.AGENTOS_CLAUDE_CODE_BIN;
    } else {
      process.env.AGENTOS_CLAUDE_CODE_BIN = previousCli;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("claude_code_cli reports a clear reauthentication message when the local Claude session has expired", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentos-claude-code-reauth-"));
  const fakeCliPath = path.join(tempDir, "fake-claude-reauth");
  const previousCli = process.env.AGENTOS_CLAUDE_CODE_BIN;
  process.env.AGENTOS_CLAUDE_CODE_BIN = fakeCliPath;

  try {
    await fs.writeFile(
      fakeCliPath,
      `#!/usr/bin/env node
console.error("OAuth token has expired. Please obtain a new token or refresh your existing token.");
process.exit(1);
`,
      "utf8"
    );
    await fs.chmod(fakeCliPath, 0o755);

    const client = new AgentModelClient({
      provider: "claude_code_cli",
      name: "sonnet",
      tier: "balanced",
      timeoutMs: 5000
    });

    await assert.rejects(
      () =>
        client.draftReply({
          goal: "Reply politely",
          livePack: "outlook-desktop",
          summary: "Need a quick reply",
          context: ["Please confirm receipt."]
        }),
      /claude \/login/i
    );
  } finally {
    if (previousCli === undefined) {
      delete process.env.AGENTOS_CLAUDE_CODE_BIN;
    } else {
      process.env.AGENTOS_CLAUDE_CODE_BIN = previousCli;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("claude_code_cli recognizes reauthentication errors reported in stdout json", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentos-claude-code-reauth-stdout-"));
  const fakeCliPath = path.join(tempDir, "fake-claude-reauth-stdout");
  const previousCli = process.env.AGENTOS_CLAUDE_CODE_BIN;
  process.env.AGENTOS_CLAUDE_CODE_BIN = fakeCliPath;

  try {
    await fs.writeFile(
      fakeCliPath,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: true,
  result: "Failed to authenticate. API Error: 401 {\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"authentication_error\\",\\"message\\":\\"OAuth token has expired. Please obtain a new token or refresh your existing token.\\"}}"
}));
process.exit(1);
`,
      "utf8"
    );
    await fs.chmod(fakeCliPath, 0o755);

    const client = new AgentModelClient({
      provider: "claude_code_cli",
      name: "sonnet",
      tier: "balanced",
      timeoutMs: 5000
    });

    await assert.rejects(
      () =>
        client.draftReply({
          goal: "Reply politely",
          livePack: "outlook-desktop",
          summary: "Need a quick reply",
          context: ["Please confirm receipt."]
        }),
      /claude \/login/i
    );
  } finally {
    if (previousCli === undefined) {
      delete process.env.AGENTOS_CLAUDE_CODE_BIN;
    } else {
      process.env.AGENTOS_CLAUDE_CODE_BIN = previousCli;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
