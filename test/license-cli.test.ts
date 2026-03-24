import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createTempDir } from "./helpers.js";

const execFileAsync = promisify(execFile);

function signLease(privateKey: crypto.KeyObject, payload: {
  accountId: string;
  deviceId: string;
  tier: "free" | "pro";
  issuedAt: string;
  expiresAt: string;
  graceEndsAt: string;
}) {
  return {
    ...payload,
    signature: crypto
      .sign(null, Buffer.from(JSON.stringify(payload)), privateKey)
      .toString("base64")
  };
}

test("license activate stores a Pro lease and logout clears it", async () => {
  const dataDir = await createTempDir("agentos-license-cli-");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const deviceId = crypto.randomUUID();
  const now = Date.now();
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (req.method === "POST" && req.url === "/v1/licenses/activate") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          authToken: "auth_123",
          lease: signLease(privateKey, {
            accountId: "acct_cli",
            deviceId: String(body.deviceId ?? deviceId),
            tier: "pro",
            issuedAt: new Date(now - 60_000).toISOString(),
            expiresAt: new Date(now + 60_000).toISOString(),
            graceEndsAt: new Date(now + 86_400_000).toISOString()
          })
        })
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const address = server.address() as AddressInfo;
  const env = {
    ...process.env,
    AGENTOS_DATA_DIR: dataDir,
    AGENTOS_LICENSE_BASE_URL: `http://127.0.0.1:${address.port}`,
    AGENTOS_LICENSE_PUBLIC_KEY: publicKey.export({ format: "pem", type: "spki" }).toString(),
    AGENTOS_LICENSE_ENFORCE_IN_SOURCE: "1"
  };

  try {
    const activated = await execFileAsync(
      process.execPath,
      ["dist/bin/agentos.js", "license", "activate", "--token", "pro-token", "--json"],
      {
        cwd: process.cwd(),
        env
      }
    );
    const activatedPayload = JSON.parse(activated.stdout);
    assert.equal(activatedPayload.license.tier, "pro");
    assert.equal(activatedPayload.license.status, "active");

    const status = await execFileAsync(
      process.execPath,
      ["dist/bin/agentos.js", "license", "status", "--json"],
      {
        cwd: process.cwd(),
        env
      }
    );
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.license.tier, "pro");
    assert.equal(statusPayload.license.status, "active");

    await execFileAsync(process.execPath, ["dist/bin/agentos.js", "license", "logout", "--json"], {
      cwd: process.cwd(),
      env
    });
    const afterLogout = await execFileAsync(
      process.execPath,
      ["dist/bin/agentos.js", "license", "status", "--json"],
      {
        cwd: process.cwd(),
        env
      }
    );
    const logoutPayload = JSON.parse(afterLogout.stdout);
    assert.equal(logoutPayload.license.tier, "free");
    assert.equal(logoutPayload.license.status, "unlicensed");
  } finally {
    const closePromise = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await closePromise;
  }
});
