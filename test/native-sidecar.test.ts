import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { NativeSidecarClient } from "../src/runtime/native-sidecar.js";
import { createTempDir } from "./helpers.js";

test("native sidecar client can exchange JSON requests over stdio", async () => {
  const tempDir = await createTempDir();
  const sidecarScript = path.join(tempDir, "fake-sidecar.mjs");

  await fs.writeFile(
    sidecarScript,
    `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({
    id: request.id,
    ok: true,
    result: {
      echoedMethod: request.method,
      params: request.params
    }
  }) + "\\n");
});
`,
    "utf8"
  );

  const client = new NativeSidecarClient({
    dataDir: tempDir,
    executablePath: process.execPath,
    args: [sidecarScript]
  });

  try {
    const response = await client.request<{ echoedMethod: string; params: Record<string, unknown> }>("health", {
      ping: true
    });
    assert.equal(response.echoedMethod, "health");
    assert.equal(response.params.ping, true);
  } finally {
    await client.shutdown();
  }
});
