import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";

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
