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

test("native sidecar client rejects cleanly when the sidecar exits before handling a request", async () => {
  const tempDir = await createTempDir();
  const sidecarScript = path.join(tempDir, "exit-sidecar.mjs");

  await fs.writeFile(
    sidecarScript,
    `process.exit(0);\n`,
    "utf8"
  );

  const client = new NativeSidecarClient({
    dataDir: tempDir,
    executablePath: process.execPath,
    args: [sidecarScript]
  });

  try {
    await assert.rejects(
      () => client.request("health", { ping: true }, { timeoutMs: 1000 }),
      /Rust sidecar (write failed|stdin closed unexpectedly|exited unexpectedly)/i
    );
  } finally {
    await client.shutdown();
  }
});

test("native sidecar client prefers the repo release binary over the cached copy when both exist", async () => {
  const tempDir = await createTempDir();
  const dataDir = path.join(tempDir, "data");
  const manifestPath = path.join(tempDir, "rust", "agentos-native", "Cargo.toml");
  const targetBinary = path.join(tempDir, "rust", "agentos-native", "target", "release", "agentos-native");
  const cachedBinary = path.join(dataDir, "bin", "agentos-native");

  await fs.mkdir(path.dirname(targetBinary), { recursive: true });
  await fs.mkdir(path.dirname(cachedBinary), { recursive: true });
  await fs.writeFile(manifestPath, "[package]\nname = \"agentos-native\"\nversion = \"0.0.0\"\n", "utf8");
  await fs.writeFile(
    targetBinary,
    `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { binary: "target" } }) + "\\n");
});
`,
    "utf8"
  );
  await fs.writeFile(
    cachedBinary,
    `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { binary: "cached" } }) + "\\n");
});
`,
    "utf8"
  );
  await fs.chmod(targetBinary, 0o755);
  await fs.chmod(cachedBinary, 0o755);

  const client = new NativeSidecarClient({
    dataDir,
    manifestPath
  });

  try {
    const response = await client.request<{ binary: string }>("health", {});
    assert.equal(response.binary, "target");
  } finally {
    await client.shutdown();
  }
});
