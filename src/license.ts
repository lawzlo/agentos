import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import type { AgentModelProvider, AgentOsConfig, LicenseConfig } from "./config.js";
import { detectInstallSourceSync } from "./install-source.js";
import type {
  InstallSourceInfo,
  LicenseCapabilities,
  LicenseLease,
  LicenseState,
  LicenseTier
} from "./types/system.js";

interface StoredLicenseAuth {
  token: string;
  accountId?: string | null;
  updatedAt?: string | null;
}

interface LicenseServerPayload {
  lease?: LicenseLease;
  authToken?: string | null;
}

export const PREMIUM_PACKS = new Set<string>(["wechat-desktop", "slack-desktop", "outlook-desktop", "boss-browser"]);
const PREMIUM_MODEL_PROVIDERS = new Set<AgentModelProvider>(["claude_code_cli"]);

const FREE_CAPABILITIES: LicenseCapabilities = {
  maxWatches: 1,
  premiumPacksEnabled: false,
  advancedDebugEnabled: false,
  claudeCodeCliEnabled: false,
  autoUpdateChannel: "none"
};

const PRO_CAPABILITIES: LicenseCapabilities = {
  maxWatches: 10,
  premiumPacksEnabled: true,
  advancedDebugEnabled: true,
  claudeCodeCliEnabled: true,
  autoUpdateChannel: "stable"
};

function normalizeTier(value: unknown, fallback: LicenseTier = "free"): LicenseTier {
  return String(value ?? "").trim().toLowerCase() === "pro" ? "pro" : fallback;
}

function stableLeasePayload(lease: Pick<LicenseLease, "accountId" | "deviceId" | "tier" | "issuedAt" | "expiresAt" | "graceEndsAt">) {
  return JSON.stringify({
    accountId: lease.accountId,
    deviceId: lease.deviceId,
    tier: lease.tier,
    issuedAt: lease.issuedAt,
    expiresAt: lease.expiresAt,
    graceEndsAt: lease.graceEndsAt
  });
}

function capabilitiesForTier(tier: LicenseTier, config: Pick<LicenseConfig, "freeMaxWatches" | "proMaxWatches">): LicenseCapabilities {
  if (tier === "pro") {
    return {
      ...PRO_CAPABILITIES,
      maxWatches: Math.max(1, Number(config.proMaxWatches) || PRO_CAPABILITIES.maxWatches)
    };
  }
  return {
    ...FREE_CAPABILITIES,
    maxWatches: Math.max(1, Number(config.freeMaxWatches) || FREE_CAPABILITIES.maxWatches)
  };
}

function clampIsoString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function decodePublicKey(value: string | undefined): string | null {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  if (text.includes("BEGIN PUBLIC KEY")) {
    return text;
  }
  try {
    const decoded = Buffer.from(text, "base64").toString("utf8");
    return decoded.includes("BEGIN PUBLIC KEY") ? decoded : text;
  } catch {
    return text;
  }
}

function verifyLeaseSignature(lease: LicenseLease, publicKey: string | null): boolean {
  if (!publicKey) {
    return false;
  }
  try {
    return crypto.verify(
      null,
      Buffer.from(stableLeasePayload(lease)),
      publicKey,
      Buffer.from(String(lease.signature ?? ""), "base64")
    );
  } catch {
    return false;
  }
}

function deviceIdPath(dataDir: string) {
  return path.join(dataDir, "license-device.json");
}

function leasePath(dataDir: string) {
  return path.join(dataDir, "license-lease.json");
}

function authPath(dataDir: string) {
  return path.join(dataDir, "license-auth.json");
}

function readJsonFileSync<T>(targetPath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(targetPath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJsonFile(targetPath: string, payload: unknown) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.writeFile(targetPath, JSON.stringify(payload, null, 2), "utf8");
  await fsp.chmod(targetPath, 0o600).catch(() => undefined);
}

export function getOrCreateDeviceId(dataDir: string): string {
  const existing = readJsonFileSync<{ deviceId?: string }>(deviceIdPath(dataDir));
  const persisted = String(existing?.deviceId ?? "").trim();
  if (persisted) {
    return persisted;
  }
  const generated = crypto.randomUUID();
  fs.mkdirSync(path.dirname(deviceIdPath(dataDir)), { recursive: true });
  fs.writeFileSync(deviceIdPath(dataDir), JSON.stringify({ deviceId: generated }, null, 2), "utf8");
  try {
    fs.chmodSync(deviceIdPath(dataDir), 0o600);
  } catch {}
  return generated;
}

export function readCachedLease(dataDir: string): LicenseLease | null {
  const raw = readJsonFileSync<LicenseLease>(leasePath(dataDir));
  if (!raw) {
    return null;
  }
  const issuedAt = clampIsoString(raw.issuedAt);
  const expiresAt = clampIsoString(raw.expiresAt);
  const graceEndsAt = clampIsoString(raw.graceEndsAt);
  const accountId = String(raw.accountId ?? "").trim();
  const deviceId = String(raw.deviceId ?? "").trim();
  const signature = String(raw.signature ?? "").trim();
  if (!accountId || !deviceId || !issuedAt || !expiresAt || !graceEndsAt || !signature) {
    return null;
  }
  return {
    accountId,
    deviceId,
    tier: normalizeTier(raw.tier, "free"),
    issuedAt,
    expiresAt,
    graceEndsAt,
    signature
  };
}

export function readCachedLicenseAuth(dataDir: string): StoredLicenseAuth | null {
  const raw = readJsonFileSync<StoredLicenseAuth>(authPath(dataDir));
  const token = String(raw?.token ?? "").trim();
  if (!token) {
    return null;
  }
  return {
    token,
    accountId: String(raw?.accountId ?? "").trim() || null,
    updatedAt: clampIsoString(raw?.updatedAt)
  };
}

export async function storeLicenseLease(dataDir: string, lease: LicenseLease) {
  await writeJsonFile(leasePath(dataDir), lease);
}

export async function storeLicenseAuth(dataDir: string, authToken: string, accountId: string | null = null) {
  await writeJsonFile(authPath(dataDir), {
    token: authToken,
    accountId,
    updatedAt: new Date().toISOString()
  });
}

export async function clearLicenseCredentials(dataDir: string) {
  await Promise.all([
    fsp.rm(leasePath(dataDir), { force: true }),
    fsp.rm(authPath(dataDir), { force: true })
  ]);
}

export function minimumLicenseTierForPack(packName: string | null | undefined): LicenseTier {
  return PREMIUM_PACKS.has(String(packName ?? "").trim()) ? "pro" : "free";
}

export function isPremiumPack(packName: string | null | undefined): boolean {
  return minimumLicenseTierForPack(packName) === "pro";
}

export function isPremiumModelProvider(provider: AgentModelProvider | null | undefined): boolean {
  return PREMIUM_MODEL_PROVIDERS.has(String(provider ?? "").trim() as AgentModelProvider);
}

function developerSourceState(config: AgentOsConfig, installSource: InstallSourceInfo): LicenseState {
  const tier = normalizeTier(config.license.sourceCheckoutTier, "pro");
  return {
    status: "active",
    tier,
    claimedTier: tier,
    accountId: null,
    deviceId: getOrCreateDeviceId(config.dataDir),
    issuedAt: null,
    expiresAt: null,
    graceEndsAt: null,
    developerMode: true,
    installSource: installSource.source,
    capabilities: capabilitiesForTier(tier, config.license),
    reason: "Source checkout defaults to developer mode.",
    minimumPackTier: "pro"
  };
}

export function resolveLicenseState(
  config: AgentOsConfig,
  installSource: InstallSourceInfo = detectInstallSourceSync()
): LicenseState {
  if (installSource.source === "source" && !config.license.enforceInSource) {
    return developerSourceState(config, installSource);
  }

  const deviceId = getOrCreateDeviceId(config.dataDir);
  const publicKey = decodePublicKey(config.license.publicKey);
  const lease = readCachedLease(config.dataDir);

  if (!lease) {
    return {
      status: "unlicensed",
      tier: "free",
      claimedTier: null,
      accountId: null,
      deviceId,
      issuedAt: null,
      expiresAt: null,
      graceEndsAt: null,
      developerMode: false,
      installSource: installSource.source,
      capabilities: capabilitiesForTier("free", config.license),
      reason: "No cached Pro license lease found.",
      minimumPackTier: "pro"
    };
  }

  const claimedTier = normalizeTier(lease.tier, "free");
  const baseState = {
    claimedTier,
    accountId: lease.accountId,
    deviceId,
    issuedAt: lease.issuedAt,
    expiresAt: lease.expiresAt,
    graceEndsAt: lease.graceEndsAt,
    developerMode: false,
    installSource: installSource.source,
    minimumPackTier: "pro" as const
  };

  if (lease.deviceId !== deviceId) {
    return {
      ...baseState,
      status: "invalid",
      tier: "free",
      capabilities: capabilitiesForTier("free", config.license),
      reason: "The cached license lease is bound to a different device."
    };
  }

  if (!verifyLeaseSignature(lease, publicKey)) {
    return {
      ...baseState,
      status: "invalid",
      tier: "free",
      capabilities: capabilitiesForTier("free", config.license),
      reason: publicKey ? "The cached license lease failed signature verification." : "No license public key is configured."
    };
  }

  const now = Date.now();
  const expiresAtMs = Date.parse(lease.expiresAt);
  const graceEndsAtMs = Date.parse(lease.graceEndsAt);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(graceEndsAtMs)) {
    return {
      ...baseState,
      status: "invalid",
      tier: "free",
      capabilities: capabilitiesForTier("free", config.license),
      reason: "The cached license lease contains invalid timestamps."
    };
  }

  if (now <= expiresAtMs) {
    return {
      ...baseState,
      status: "active",
      tier: claimedTier,
      capabilities: capabilitiesForTier(claimedTier, config.license),
      reason: null
    };
  }

  if (now <= graceEndsAtMs) {
    return {
      ...baseState,
      status: "grace",
      tier: claimedTier,
      capabilities: capabilitiesForTier(claimedTier, config.license),
      reason: "The cached license lease is expired but still within offline grace."
    };
  }

  return {
    ...baseState,
    status: "expired",
    tier: "free",
    capabilities: capabilitiesForTier("free", config.license),
    reason: "The cached license lease and offline grace have both expired."
  };
}

export class LicenseService {
  #config: AgentOsConfig;
  #installSource: InstallSourceInfo;
  #state: LicenseState;

  constructor(config: AgentOsConfig, installSource: InstallSourceInfo = detectInstallSourceSync()) {
    this.#config = config;
    this.#installSource = installSource;
    this.#state = resolveLicenseState(config, installSource);
  }

  getState(): LicenseState {
    return this.#state;
  }

  refresh(): LicenseState {
    this.#state = resolveLicenseState(this.#config, this.#installSource);
    return this.#state;
  }

  getCapabilities(): LicenseCapabilities {
    return this.#state.capabilities;
  }

  requiresProPack(packName: string | null | undefined): boolean {
    return isPremiumPack(packName);
  }

  canUsePack(packName: string | null | undefined): boolean {
    return minimumLicenseTierForPack(packName) === "free" || this.#state.capabilities.premiumPacksEnabled;
  }

  assertPackAllowed(packName: string | null | undefined) {
    if (this.canUsePack(packName)) {
      return;
    }
    throw new Error(`Pack ${String(packName ?? "").trim() || "(unknown)"} requires AgentOS Pro.`);
  }

  canUseModelProvider(provider: AgentModelProvider | null | undefined): boolean {
    return !isPremiumModelProvider(provider) || this.#state.capabilities.claudeCodeCliEnabled;
  }

  assertModelProviderAllowed(provider: AgentModelProvider | null | undefined) {
    if (this.canUseModelProvider(provider)) {
      return;
    }
    throw new Error(`Model provider ${String(provider ?? "").trim() || "(unknown)"} requires AgentOS Pro.`);
  }

  maxWatches(): number {
    return this.#state.capabilities.maxWatches;
  }
}

async function requestLicenseServer(
  config: AgentOsConfig,
  pathname: string,
  payload: Record<string, unknown>
): Promise<LicenseServerPayload> {
  const baseUrl = String(config.license.baseUrl ?? "").trim();
  if (!baseUrl) {
    throw new Error("AGENTOS_LICENSE_BASE_URL is not configured.");
  }
  const response = await fetch(new URL(pathname, `${baseUrl.replace(/\/+$/, "")}/`).toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  }).catch((error) => {
    throw new Error(`Failed to reach the license service: ${error.message}`);
  });
  const body = (await response.json().catch(() => ({}))) as LicenseServerPayload & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `License service request failed: ${response.status}`);
  }
  return body;
}

async function validateAndStoreLease(config: AgentOsConfig, payload: LicenseServerPayload) {
  const lease = payload.lease;
  if (!lease) {
    throw new Error("The license service did not return a lease.");
  }
  const installSource = detectInstallSourceSync();
  const deviceId = getOrCreateDeviceId(config.dataDir);
  if (lease.deviceId !== deviceId) {
    throw new Error("The returned lease is bound to a different device.");
  }
  const normalizedLease: LicenseLease = {
    ...lease,
    tier: normalizeTier(lease.tier, "free"),
    issuedAt: clampIsoString(lease.issuedAt) ?? "",
    expiresAt: clampIsoString(lease.expiresAt) ?? "",
    graceEndsAt: clampIsoString(lease.graceEndsAt) ?? ""
  };
  if (!verifyLeaseSignature(normalizedLease, decodePublicKey(config.license.publicKey))) {
    throw new Error("The returned lease failed signature verification.");
  }
  await storeLicenseLease(config.dataDir, normalizedLease);
  if (typeof payload.authToken === "string" && payload.authToken.trim()) {
    await storeLicenseAuth(config.dataDir, payload.authToken.trim(), normalizedLease.accountId);
  }
  return resolveLicenseState(config, installSource);
}

export async function activateLicense(config: AgentOsConfig, token: string) {
  const installSource = detectInstallSourceSync();
  const payload = await requestLicenseServer(config, "/v1/licenses/activate", {
    token,
    deviceId: getOrCreateDeviceId(config.dataDir),
    installSource: installSource.source,
    buildChannel: installSource.buildChannel ?? null
  });
  return validateAndStoreLease(config, payload);
}

export async function refreshLicense(config: AgentOsConfig) {
  const auth = readCachedLicenseAuth(config.dataDir);
  if (!auth?.token) {
    throw new Error("No cached license session is available to refresh.");
  }
  const installSource = detectInstallSourceSync();
  const payload = await requestLicenseServer(config, "/v1/licenses/refresh", {
    authToken: auth.token,
    deviceId: getOrCreateDeviceId(config.dataDir),
    installSource: installSource.source,
    buildChannel: installSource.buildChannel ?? null
  });
  return validateAndStoreLease(config, payload);
}
