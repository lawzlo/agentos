import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";

import { createTempDir } from "./helpers.js";
import { defaultDataDir, detectBrowserExecutable, resolveConfig } from "../src/config.js";

test("resolveConfig uses precedence between environment and explicit overrides", async () => {
  const dataRoot = await createTempDir("agentos-config-env-");
  const browserBinary = path.join(dataRoot, "custom-chrome.sh");
  const previousValues = {
    AGENTOS_DATA_DIR: process.env.AGENTOS_DATA_DIR,
    AGENTOS_HEADLESS: process.env.AGENTOS_HEADLESS,
    AGENTOS_LEARNING_ENABLED: process.env.AGENTOS_LEARNING_ENABLED,
    MODEL_TIMEOUT_MS: process.env.MODEL_TIMEOUT_MS
  };

  process.env.AGENTOS_DATA_DIR = path.join(dataRoot, "from-env");
  process.env.AGENTOS_HEADLESS = "false";
  process.env.AGENTOS_LEARNING_ENABLED = "false";
  process.env.MODEL_TIMEOUT_MS = "12000";
  process.env.AGENTOS_BROWSER_EXECUTABLE = browserBinary;

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
    assert.equal(config.browserExecutable, browserBinary);
    assert.equal(config.learning.enabled, true);
    assert.equal(config.learning.maxDepth, 9);
    assert.equal(config.model.baseUrl, "https://model.local");
    assert.equal(config.model.timeoutMs, 3000);
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
