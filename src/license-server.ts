import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { AddressInfo } from "node:net";

import type { LicenseLease, LicenseTier } from "./types/system.js";

interface ActivationTokenRecord {
  accountId: string;
  tier: LicenseTier;
  createdAt: string;
}

interface SessionRecord {
  authToken: string;
  accountId: string;
  tier: LicenseTier;
  createdAt: string;
  updatedAt: string;
}

interface LicenseServerState {
  activationTokens: Record<string, ActivationTokenRecord>;
  sessions: Record<string, SessionRecord>;
}

export interface LicenseServerPaths {
  dataDir: string;
  privateKeyPath: string;
  publicKeyPath: string;
  statePath: string;
}

export interface LicenseServerOptions {
  dataDir: string;
  host?: string;
  port?: number;
  privateKeyPath?: string;
  publicKeyPath?: string;
  leaseDurationDays?: number;
  offlineGraceDays?: number;
}

export interface StartedLicenseServer {
  host: string;
  port: number;
  baseUrl: string;
  paths: LicenseServerPaths;
  close(): Promise<void>;
}

function normalizeTier(value: unknown, fallback: LicenseTier = "free"): LicenseTier {
  return String(value ?? "").trim().toLowerCase() === "pro" ? "pro" : fallback;
}

function stableLeasePayload(
  lease: Pick<LicenseLease, "accountId" | "deviceId" | "tier" | "issuedAt" | "expiresAt" | "graceEndsAt">
) {
  return JSON.stringify({
    accountId: lease.accountId,
    deviceId: lease.deviceId,
    tier: lease.tier,
    issuedAt: lease.issuedAt,
    expiresAt: lease.expiresAt,
    graceEndsAt: lease.graceEndsAt
  });
}

function writeFileMode(targetPath: string, content: string) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, "utf8");
  try {
    fs.chmodSync(targetPath, 0o600);
  } catch {}
}

export function licenseServerPaths(dataDir: string): LicenseServerPaths {
  return {
    dataDir,
    privateKeyPath: path.join(dataDir, "ed25519-private.pem"),
    publicKeyPath: path.join(dataDir, "ed25519-public.pem"),
    statePath: path.join(dataDir, "license-server-state.json")
  };
}

export function ensureLicenseServerKeyPair({
  dataDir,
  privateKeyPath,
  publicKeyPath
}: {
  dataDir: string;
  privateKeyPath?: string;
  publicKeyPath?: string;
}): LicenseServerPaths {
  const defaults = licenseServerPaths(dataDir);
  const resolved: LicenseServerPaths = {
    ...defaults,
    privateKeyPath: privateKeyPath ? path.resolve(privateKeyPath) : defaults.privateKeyPath,
    publicKeyPath: publicKeyPath ? path.resolve(publicKeyPath) : defaults.publicKeyPath
  };

  if (fs.existsSync(resolved.privateKeyPath) && fs.existsSync(resolved.publicKeyPath)) {
    return resolved;
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  writeFileMode(resolved.privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }).toString());
  writeFileMode(resolved.publicKeyPath, publicKey.export({ format: "pem", type: "spki" }).toString());
  return resolved;
}

async function readServerState(statePath: string): Promise<LicenseServerState> {
  try {
    const raw = await fsp.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LicenseServerState>;
    return {
      activationTokens:
        parsed.activationTokens && typeof parsed.activationTokens === "object" ? parsed.activationTokens as Record<string, ActivationTokenRecord> : {},
      sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions as Record<string, SessionRecord> : {}
    };
  } catch {
    return {
      activationTokens: {},
      sessions: {}
    };
  }
}

async function writeServerState(statePath: string, state: LicenseServerState) {
  await fsp.mkdir(path.dirname(statePath), { recursive: true });
  await fsp.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
  await fsp.chmod(statePath, 0o600).catch(() => undefined);
}

function issueSignedLease({
  accountId,
  deviceId,
  tier,
  privateKey,
  leaseDurationDays = 30,
  offlineGraceDays = 14
}: {
  accountId: string;
  deviceId: string;
  tier: LicenseTier;
  privateKey: string;
  leaseDurationDays?: number;
  offlineGraceDays?: number;
}): LicenseLease {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + Math.max(1, leaseDurationDays) * 24 * 60 * 60 * 1000);
  const graceEndsAt = new Date(expiresAt.getTime() + Math.max(0, offlineGraceDays) * 24 * 60 * 60 * 1000);
  const unsigned = {
    accountId,
    deviceId,
    tier,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    graceEndsAt: graceEndsAt.toISOString()
  };
  const signature = crypto.sign(null, Buffer.from(stableLeasePayload(unsigned)), privateKey).toString("base64");
  return {
    ...unsigned,
    signature
  };
}

export async function issueLicenseActivationToken({
  dataDir,
  accountId,
  tier = "pro",
  token = crypto.randomUUID()
}: {
  dataDir: string;
  accountId: string;
  tier?: LicenseTier;
  token?: string;
}): Promise<{ token: string; record: ActivationTokenRecord; paths: LicenseServerPaths }> {
  const paths = ensureLicenseServerKeyPair({ dataDir });
  const state = await readServerState(paths.statePath);
  const record: ActivationTokenRecord = {
    accountId: String(accountId ?? "").trim() || "acct-default",
    tier: normalizeTier(tier, "pro"),
    createdAt: new Date().toISOString()
  };
  state.activationTokens[String(token).trim()] = record;
  await writeServerState(paths.statePath, state);
  return {
    token: String(token).trim(),
    record,
    paths
  };
}

async function readRequestJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (!chunks.length) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJson(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

export async function startLicenseServer(options: LicenseServerOptions): Promise<StartedLicenseServer> {
  const paths = ensureLicenseServerKeyPair({
    dataDir: options.dataDir,
    privateKeyPath: options.privateKeyPath,
    publicKeyPath: options.publicKeyPath
  });
  const privateKey = await fsp.readFile(paths.privateKeyPath, "utf8");
  const host = String(options.host ?? "127.0.0.1").trim() || "127.0.0.1";
  const port = Number(options.port ?? 0);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/health") {
      writeJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/licenses/public-key") {
      writeJson(res, 200, {
        publicKey: await fsp.readFile(paths.publicKeyPath, "utf8"),
        publicKeyPath: paths.publicKeyPath
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/licenses/activate") {
      const body = await readRequestJson(req);
      const token = String(body.token ?? "").trim();
      const deviceId = String(body.deviceId ?? "").trim();
      if (!token || !deviceId) {
        writeJson(res, 400, { error: "Activation requires a token and deviceId." });
        return;
      }

      const state = await readServerState(paths.statePath);
      const activation = state.activationTokens[token];
      if (!activation) {
        writeJson(res, 401, { error: "Unknown activation token." });
        return;
      }

      const authToken = crypto.randomUUID();
      const now = new Date().toISOString();
      state.sessions[authToken] = {
        authToken,
        accountId: activation.accountId,
        tier: activation.tier,
        createdAt: now,
        updatedAt: now
      };
      await writeServerState(paths.statePath, state);
      writeJson(res, 200, {
        lease: issueSignedLease({
          accountId: activation.accountId,
          deviceId,
          tier: activation.tier,
          privateKey,
          leaseDurationDays: options.leaseDurationDays,
          offlineGraceDays: options.offlineGraceDays
        }),
        authToken
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/licenses/refresh") {
      const body = await readRequestJson(req);
      const authToken = String(body.authToken ?? "").trim();
      const deviceId = String(body.deviceId ?? "").trim();
      if (!authToken || !deviceId) {
        writeJson(res, 400, { error: "Refresh requires an authToken and deviceId." });
        return;
      }

      const state = await readServerState(paths.statePath);
      const session = state.sessions[authToken];
      if (!session) {
        writeJson(res, 401, { error: "Unknown license session." });
        return;
      }

      state.sessions[authToken] = {
        ...session,
        updatedAt: new Date().toISOString()
      };
      await writeServerState(paths.statePath, state);
      writeJson(res, 200, {
        lease: issueSignedLease({
          accountId: session.accountId,
          deviceId,
          tier: session.tier,
          privateKey,
          leaseDurationDays: options.leaseDurationDays,
          offlineGraceDays: options.offlineGraceDays
        }),
        authToken
      });
      return;
    }

    writeJson(res, 404, { error: "Not found." });
  });

  await new Promise<void>((resolve) => server.listen(port, host, () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    host,
    port: address.port,
    baseUrl: `http://${host}:${address.port}`,
    paths,
    async close() {
      const closePromise = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await closePromise;
    }
  };
}
