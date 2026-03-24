import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createTempDir } from "./helpers.js";
import { resolveConfig } from "../src/config.js";
import { minimumLicenseTierForPack, resolveLicenseState, storeLicenseLease } from "../src/license.js";
import type { LicenseLease } from "../src/types/system.js";

function signLease(
  lease: Omit<LicenseLease, "signature">,
  privateKey: crypto.KeyObject
): LicenseLease {
  const payload = JSON.stringify({
    accountId: lease.accountId,
    deviceId: lease.deviceId,
    tier: lease.tier,
    issuedAt: lease.issuedAt,
    expiresAt: lease.expiresAt,
    graceEndsAt: lease.graceEndsAt
  });
  return {
    ...lease,
    signature: crypto.sign(null, Buffer.from(payload), privateKey).toString("base64")
  };
}

test("source checkout defaults to developer-mode Pro when source enforcement is off", async () => {
  const dataDir = await createTempDir("agentos-license-source-");
  const config = resolveConfig({ dataDir });

  const state = resolveLicenseState(config, {
    source: "source",
    label: "source checkout",
    installRoot: null,
    wrapperPath: null,
    metadataPath: null,
    managedInstallation: false,
    bundledRuntime: false,
    runtimeExecutablePath: process.execPath,
    uninstallHint: null,
    buildChannel: "source",
    licenseEnforced: false
  });

  assert.equal(state.developerMode, true);
  assert.equal(state.tier, "pro");
  assert.equal(state.status, "active");
});

test("managed install without a lease falls back to Free", async () => {
  const dataDir = await createTempDir("agentos-license-free-");
  const config = resolveConfig({
    dataDir,
    license: {
      enforceInSource: true
    }
  });

  const state = resolveLicenseState(config, {
    source: "macos_pkg",
    label: "pkg",
    installRoot: "/opt/agentos/0.1.0",
    wrapperPath: "/usr/local/bin/agentos",
    metadataPath: "/opt/agentos/0.1.0/install-metadata.json",
    managedInstallation: true,
    bundledRuntime: true,
    runtimeExecutablePath: "/opt/agentos/0.1.0/runtime/bin/node",
    uninstallHint: null,
    buildChannel: "stable",
    licenseEnforced: true
  });

  assert.equal(state.tier, "free");
  assert.equal(state.status, "unlicensed");
  assert.equal(state.capabilities.premiumPacksEnabled, false);
});

test("valid signed lease resolves to active Pro and grace leases remain Pro during offline grace", async () => {
  const dataDir = await createTempDir("agentos-license-pro-");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const config = resolveConfig({
    dataDir,
    license: {
      publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
      enforceInSource: true
    }
  });

  const baseInstallSource = {
    source: "windows_msi" as const,
    label: "Windows MSI installation",
    installRoot: "AgentOS\\0.1.0",
    wrapperPath: "agentos.cmd",
    metadataPath: "AgentOS\\0.1.0\\install-metadata.json",
    managedInstallation: true,
    bundledRuntime: true,
    runtimeExecutablePath: "%ProgramFiles%\\AgentOS\\0.1.0\\runtime\\node.exe",
    uninstallHint: null,
    buildChannel: "stable",
    licenseEnforced: true
  };
  const deviceId = resolveLicenseState(config, baseInstallSource).deviceId ?? "";
  const now = Date.now();
  const activeLease = signLease(
    {
      accountId: "acct_123",
      deviceId,
      tier: "pro",
      issuedAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      graceEndsAt: new Date(now + 86_400_000).toISOString()
    },
    privateKey
  );
  await storeLicenseLease(dataDir, activeLease);

  const activeState = resolveLicenseState(config, baseInstallSource);
  assert.equal(activeState.status, "active");
  assert.equal(activeState.tier, "pro");
  assert.equal(activeState.capabilities.claudeCodeCliEnabled, true);

  const graceLease = signLease(
    {
      ...activeLease,
      issuedAt: new Date(now - 172_800_000).toISOString(),
      expiresAt: new Date(now - 60_000).toISOString(),
      graceEndsAt: new Date(now + 60_000).toISOString()
    },
    privateKey
  );
  await storeLicenseLease(dataDir, graceLease);

  const graceState = resolveLicenseState(config, baseInstallSource);
  assert.equal(graceState.status, "grace");
  assert.equal(graceState.tier, "pro");
});

test("invalid lease signature falls back to Free invalid state", async () => {
  const dataDir = await createTempDir("agentos-license-invalid-");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const { privateKey: wrongPrivateKey } = crypto.generateKeyPairSync("ed25519");
  const config = resolveConfig({
    dataDir,
    license: {
      publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
      enforceInSource: true
    }
  });

  const installSource = {
    source: "macos_pkg" as const,
    label: "pkg",
    installRoot: "/opt/agentos/0.1.0",
    wrapperPath: "/usr/local/bin/agentos",
    metadataPath: "/opt/agentos/0.1.0/install-metadata.json",
    managedInstallation: true,
    bundledRuntime: true,
    runtimeExecutablePath: "/opt/agentos/0.1.0/runtime/bin/node",
    uninstallHint: null,
    buildChannel: "stable",
    licenseEnforced: true
  };
  const deviceId = resolveLicenseState(config, installSource).deviceId ?? "";
  await storeLicenseLease(
    dataDir,
    signLease(
      {
        accountId: "acct_bad",
        deviceId,
        tier: "pro",
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        graceEndsAt: new Date(Date.now() + 120_000).toISOString()
      },
      wrongPrivateKey
    )
  );

  const state = resolveLicenseState(config, installSource);
  assert.equal(state.status, "invalid");
  assert.equal(state.tier, "free");
  assert.equal(state.reason?.includes("signature"), true);

  assert.equal(minimumLicenseTierForPack("generic-mail-browser"), "free");
  assert.equal(minimumLicenseTierForPack("outlook-desktop"), "pro");

  void privateKey;
});
