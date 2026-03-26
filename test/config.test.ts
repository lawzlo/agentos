import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { createTempDir } from "./helpers.js";
import { defaultDataDir, detectBrowserExecutable, resolveConfig } from "../src/config.js";

test("resolveConfig uses precedence between environment and explicit overrides", async () => {
  const dataRoot = await createTempDir("agentos-config-env-");
  const browserBinary = path.join(dataRoot, "custom-chrome.sh");
  const previousValues = {
    AGENTOS_DATA_DIR: process.env.AGENTOS_DATA_DIR,
    AGENTOS_HEADLESS: process.env.AGENTOS_HEADLESS,
    AGENTOS_BROWSER_MODE: process.env.AGENTOS_BROWSER_MODE,
    AGENTOS_BROWSER_CDP_URL: process.env.AGENTOS_BROWSER_CDP_URL,
    AGENTOS_LEARNING_ENABLED: process.env.AGENTOS_LEARNING_ENABLED,
    MODEL_TIMEOUT_MS: process.env.MODEL_TIMEOUT_MS,
    AGENTOS_LICENSE_BASE_URL: process.env.AGENTOS_LICENSE_BASE_URL,
    AGENTOS_LICENSE_OFFLINE_GRACE_DAYS: process.env.AGENTOS_LICENSE_OFFLINE_GRACE_DAYS,
    AGENTOS_LICENSE_ENFORCE_IN_SOURCE: process.env.AGENTOS_LICENSE_ENFORCE_IN_SOURCE
  };

  process.env.AGENTOS_DATA_DIR = path.join(dataRoot, "from-env");
  process.env.AGENTOS_HEADLESS = "false";
  process.env.AGENTOS_BROWSER_MODE = "managed_profile";
  process.env.AGENTOS_BROWSER_CDP_URL = "http://127.0.0.1:9222";
  process.env.AGENTOS_LEARNING_ENABLED = "false";
  process.env.MODEL_TIMEOUT_MS = "12000";
  process.env.AGENTOS_BROWSER_EXECUTABLE = browserBinary;
  process.env.AGENTOS_LICENSE_BASE_URL = "https://license.agentos.local";
  process.env.AGENTOS_LICENSE_OFFLINE_GRACE_DAYS = "21";
  process.env.AGENTOS_LICENSE_ENFORCE_IN_SOURCE = "1";

  try {
    const config = resolveConfig({
      dataDir: path.join(dataRoot, "from-override"),
      headless: true,
      port: 4100,
      model: {
        timeoutMs: 3000,
        baseUrl: "https://model.local"
      },
      learning: {
        enabled: true,
        maxDepth: 9
      }
    });

    assert.equal(config.dataDir, path.join(dataRoot, "from-override"));
    assert.equal(config.daemonDir, path.join(config.dataDir, "daemon"));
    assert.equal(config.port, 4100);
    assert.equal(config.headless, true);
    assert.equal(config.browserMode, "managed_profile");
    assert.equal(config.browserExecutable, browserBinary);
    assert.equal(config.browserCdpUrl, "http://127.0.0.1:9222");
    assert.equal(config.learning.enabled, true);
    assert.equal(config.learning.maxDepth, 9);
    assert.equal(config.model.baseUrl, "https://model.local");
    assert.equal(config.model.timeoutMs, 3000);
    assert.equal(config.license.baseUrl, "https://license.agentos.local");
    assert.equal(config.license.offlineGraceDays, 21);
    assert.equal(config.license.enforceInSource, true);
    assert.equal(config.license.sourceCheckoutTier, "pro");
    assert.equal(config.dbPath, path.join(config.dataDir, "agentos.sqlite"));
    assert.equal(config.masterKeyPath, path.join(config.dataDir, "master.key"));
    assert.equal(config.inboxDir, path.join(config.dataDir, "inbox"));
  } finally {
    if (previousValues.AGENTOS_DATA_DIR === undefined) {
      delete process.env.AGENTOS_DATA_DIR;
    } else {
      process.env.AGENTOS_DATA_DIR = previousValues.AGENTOS_DATA_DIR;
    }
    if (previousValues.AGENTOS_HEADLESS === undefined) {
      delete process.env.AGENTOS_HEADLESS;
    } else {
      process.env.AGENTOS_HEADLESS = previousValues.AGENTOS_HEADLESS;
    }
    if (previousValues.AGENTOS_BROWSER_MODE === undefined) {
      delete process.env.AGENTOS_BROWSER_MODE;
    } else {
      process.env.AGENTOS_BROWSER_MODE = previousValues.AGENTOS_BROWSER_MODE;
    }
    if (previousValues.AGENTOS_BROWSER_CDP_URL === undefined) {
      delete process.env.AGENTOS_BROWSER_CDP_URL;
    } else {
      process.env.AGENTOS_BROWSER_CDP_URL = previousValues.AGENTOS_BROWSER_CDP_URL;
    }
    if (previousValues.AGENTOS_LEARNING_ENABLED === undefined) {
      delete process.env.AGENTOS_LEARNING_ENABLED;
    } else {
      process.env.AGENTOS_LEARNING_ENABLED = previousValues.AGENTOS_LEARNING_ENABLED;
    }
    if (previousValues.MODEL_TIMEOUT_MS === undefined) {
      delete process.env.MODEL_TIMEOUT_MS;
    } else {
      process.env.MODEL_TIMEOUT_MS = previousValues.MODEL_TIMEOUT_MS;
    }
    if (previousValues.AGENTOS_LICENSE_BASE_URL === undefined) {
      delete process.env.AGENTOS_LICENSE_BASE_URL;
    } else {
      process.env.AGENTOS_LICENSE_BASE_URL = previousValues.AGENTOS_LICENSE_BASE_URL;
    }
    if (previousValues.AGENTOS_LICENSE_OFFLINE_GRACE_DAYS === undefined) {
      delete process.env.AGENTOS_LICENSE_OFFLINE_GRACE_DAYS;
    } else {
      process.env.AGENTOS_LICENSE_OFFLINE_GRACE_DAYS = previousValues.AGENTOS_LICENSE_OFFLINE_GRACE_DAYS;
    }
    if (previousValues.AGENTOS_LICENSE_ENFORCE_IN_SOURCE === undefined) {
      delete process.env.AGENTOS_LICENSE_ENFORCE_IN_SOURCE;
    } else {
      process.env.AGENTOS_LICENSE_ENFORCE_IN_SOURCE = previousValues.AGENTOS_LICENSE_ENFORCE_IN_SOURCE;
    }
    delete process.env.AGENTOS_BROWSER_EXECUTABLE;
  }
});

test("detectBrowserExecutable prefers explicit environment override", async () => {
  const dataRoot = await createTempDir("agentos-browser-path-");
  const browserExecutable = path.join(dataRoot, "chromium-bin");
  const previous = process.env.AGENTOS_BROWSER_EXECUTABLE;
  process.env.AGENTOS_BROWSER_EXECUTABLE = browserExecutable;

  try {
    assert.equal(detectBrowserExecutable(), browserExecutable);
  } finally {
    if (previous === undefined) {
      delete process.env.AGENTOS_BROWSER_EXECUTABLE;
    } else {
      process.env.AGENTOS_BROWSER_EXECUTABLE = previous;
    }
  }
});

test("resolveConfig default learning sources include home derived locations", async () => {
  const config = resolveConfig({ dataDir: os.tmpdir() });

  assert.equal(config.learning.contentRoots.includes(path.join(os.homedir(), "Downloads")), true);
  assert.equal(config.learning.contentRoots.includes(path.join(os.homedir(), "Desktop")), true);
  assert.equal(config.learning.excludedPaths.includes(path.join(os.homedir(), ".cache")), true);
  assert.equal(config.learning.metadataRoots.includes(os.homedir()), true);
  assert.equal(config.learning.textExtensions.includes("md"), true);
});

test("defaultDataDir resolves under the user's home directory", () => {
  const previous = process.env.AGENTOS_DATA_DIR;
  delete process.env.AGENTOS_DATA_DIR;

  try {
    assert.equal(defaultDataDir(), path.join(os.homedir(), ".agentos"));
    assert.equal(resolveConfig().dataDir, path.join(os.homedir(), ".agentos"));
  } finally {
    if (previous === undefined) {
      delete process.env.AGENTOS_DATA_DIR;
    } else {
      process.env.AGENTOS_DATA_DIR = previous;
    }
  }
});

test("resolveConfig defaults browser automation to headed unless explicitly enabled", () => {
  const previous = process.env.AGENTOS_HEADLESS;
  const previousMode = process.env.AGENTOS_BROWSER_MODE;
  delete process.env.AGENTOS_HEADLESS;
  delete process.env.AGENTOS_BROWSER_MODE;

  try {
    assert.equal(resolveConfig({ dataDir: os.tmpdir() }).headless, false);
    assert.equal(resolveConfig({ dataDir: os.tmpdir() }).browserMode, "attach_existing");
    process.env.AGENTOS_HEADLESS = "true";
    assert.equal(resolveConfig({ dataDir: os.tmpdir() }).headless, true);
  } finally {
    if (previous === undefined) {
      delete process.env.AGENTOS_HEADLESS;
    } else {
      process.env.AGENTOS_HEADLESS = previous;
    }
    if (previousMode === undefined) {
      delete process.env.AGENTOS_BROWSER_MODE;
    } else {
      process.env.AGENTOS_BROWSER_MODE = previousMode;
    }
  }
});

test("resolveConfig normalizes browser CDP endpoint inputs", () => {
  const previousPort = process.env.AGENTOS_BROWSER_REMOTE_DEBUGGING_PORT;
  delete process.env.AGENTOS_BROWSER_CDP_URL;
  process.env.AGENTOS_BROWSER_REMOTE_DEBUGGING_PORT = "9223";

  try {
    assert.equal(resolveConfig({ dataDir: os.tmpdir() }).browserCdpUrl, "http://127.0.0.1:9223");
    assert.equal(
      resolveConfig({ dataDir: os.tmpdir(), browserCdpUrl: "ws://127.0.0.1:9224/devtools/browser/test" }).browserCdpUrl,
      "ws://127.0.0.1:9224/devtools/browser/test"
    );
  } finally {
    if (previousPort === undefined) {
      delete process.env.AGENTOS_BROWSER_REMOTE_DEBUGGING_PORT;
    } else {
      process.env.AGENTOS_BROWSER_REMOTE_DEBUGGING_PORT = previousPort;
    }
  }
});

test("resolveConfig reads saved model config from the data directory", async () => {
  const dataDir = await createTempDir("agentos-config-model-");
  await fs.writeFile(
    path.join(dataDir, "model-config.json"),
    JSON.stringify({
      provider: "anthropic",
      tier: "balanced",
      apiKey: "sk-ant-test",
      name: "claude-sonnet-4-5"
    }),
    "utf8"
  );

  const config = resolveConfig({ dataDir });
  assert.equal(config.model.provider, "anthropic");
  assert.equal(config.model.tier, "balanced");
  assert.equal(config.model.apiKey, "sk-ant-test");
  assert.equal(config.model.name, "claude-sonnet-4-5");
  assert.equal(config.model.baseUrl, "https://api.anthropic.com");
});

test("resolveConfig supports the claude_code_cli provider without API credentials", async () => {
  const dataDir = await createTempDir("agentos-config-claude-code-");
  await fs.writeFile(
    path.join(dataDir, "model-config.json"),
    JSON.stringify({
      provider: "claude_code_cli",
      tier: "balanced",
      name: "sonnet"
    }),
    "utf8"
  );

  const config = resolveConfig({ dataDir });
  assert.equal(config.model.provider, "claude_code_cli");
  assert.equal(config.model.tier, "balanced");
  assert.equal(config.model.name, "sonnet");
  assert.equal(config.model.apiKey, undefined);
  assert.equal(config.model.baseUrl, undefined);
});
