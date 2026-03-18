import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { fetchProviderModelCatalog } from "../src/model-catalog.js";

async function startJsonServer(handler: (request: {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}) => {
  status?: number;
  payload: unknown;
}) {
  const server = http.createServer((req, res) => {
    const result = handler({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: req.headers
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

test("fetchProviderModelCatalog discovers OpenAI models and builds a curated shortlist", async () => {
  const server = await startJsonServer(() => ({
    payload: {
      data: [
        { id: "gpt-5.4-mini" },
        { id: "gpt-5.4" },
        { id: "gpt-5.4-pro" },
        { id: "gpt-5.4-preview" },
        { id: "text-embedding-3-large" }
      ]
    }
  }));

  try {
    const catalog = await fetchProviderModelCatalog({
      provider: "openai",
      baseUrl: server.baseUrl,
      apiKey: "sk-openai-test",
      timeoutMs: 5000
    });

    assert.equal(catalog.source, "live");
    assert.deepEqual(
      catalog.models.map((entry) => entry.id),
      ["gpt-5.4-mini", "gpt-5.4", "gpt-5.4-pro", "gpt-5.4-preview"]
    );
    assert.deepEqual(
      catalog.choices.map((choice) => [choice.slot, choice.modelId]),
      [
        ["recommended", "gpt-5.4"],
        ["fast", "gpt-5.4-mini"],
        ["strong", "gpt-5.4-pro"]
      ]
    );
  } finally {
    await server.close();
  }
});

test("fetchProviderModelCatalog discovers Gemini models with thinking metadata", async () => {
  const server = await startJsonServer((request) => {
    assert.match(request.url, /^\/models\?key=gem-test-key/u);
    return {
      payload: {
        models: [
          {
            name: "models/gemini-2.5-flash",
            displayName: "Gemini 2.5 Flash",
            supportedGenerationMethods: ["generateContent"],
            thinking: true
          },
          {
            name: "models/gemini-2.5-pro",
            displayName: "Gemini 2.5 Pro",
            supportedGenerationMethods: ["generateContent"],
            thinking: true
          },
          {
            name: "models/text-embedding-004",
            displayName: "Text Embedding",
            supportedGenerationMethods: ["embedContent"]
          }
        ]
      }
    };
  });

  try {
    const catalog = await fetchProviderModelCatalog({
      provider: "gemini",
      baseUrl: server.baseUrl,
      apiKey: "gem-test-key",
      timeoutMs: 5000
    });

    assert.equal(catalog.source, "live");
    assert.deepEqual(
      catalog.models.map((entry) => [entry.id, entry.supportsThinking]),
      [
        ["gemini-2.5-flash", true],
        ["gemini-2.5-pro", true]
      ]
    );
    assert.equal(catalog.choices.find((choice) => choice.slot === "recommended")?.modelId, "gemini-2.5-flash");
    assert.equal(catalog.choices.find((choice) => choice.slot === "strong")?.modelId, "gemini-2.5-pro");
  } finally {
    await server.close();
  }
});
