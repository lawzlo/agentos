import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { createTempDir } from "./helpers.js";
import { resolveConfig } from "../src/config.js";
import { activateLicense, refreshLicense } from "../src/license.js";
import {
  issueLicenseActivationToken,
  licenseServerPaths,
  startLicenseServer
} from "../src/license-server.js";

test("minimal license service can activate and refresh a Pro lease", async () => {
  const dataDir = await createTempDir("agentos-license-service-");
  const serviceDataDir = await createTempDir("agentos-license-service-backend-");

  const started = await startLicenseServer({
    dataDir: serviceDataDir,
    host: "127.0.0.1",
    port: 0,
    leaseDurationDays: 30,
    offlineGraceDays: 14
  });

  try {
    const issued = await issueLicenseActivationToken({
      dataDir: serviceDataDir,
      accountId: "acct_pro",
      tier: "pro"
    });
    const publicKey = await fs.readFile(licenseServerPaths(serviceDataDir).publicKeyPath, "utf8");
    const config = resolveConfig({
      dataDir,
      license: {
        baseUrl: started.baseUrl,
        publicKey,
        enforceInSource: true
      }
    });

    const activated = await activateLicense(config, issued.token);
    assert.equal(activated.status, "active");
    assert.equal(activated.tier, "pro");
    assert.equal(activated.accountId, "acct_pro");
    assert.equal(activated.capabilities.premiumPacksEnabled, true);

    const refreshed = await refreshLicense(config);
    assert.equal(refreshed.status, "active");
    assert.equal(refreshed.tier, "pro");
    assert.equal(refreshed.accountId, "acct_pro");
  } finally {
    await started.close();
  }
});
