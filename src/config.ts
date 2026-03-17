import fs from "node:fs";
import path from "node:path";
import type { LivePack } from "./runtime/live-pack-registry.js";

const CHROME_CANDIDATES: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ]
};

export interface AgentModelConfig {
  baseUrl?: string;
  apiKey?: string;
  name?: string;
  timeoutMs: number;
}

export interface AgentOsConfig {
  port: number;
  dataDir: string;
  daemonDir: string;
  dbPath: string;
  masterKeyPath: string;
  inboxDir: string;
  headless: boolean;
  browserExecutable?: string;
  livePacks: Record<string, LivePack> | null;
  model: AgentModelConfig;
}

export interface ConfigOverrides {
  port?: number | string;
  dataDir?: string;
  headless?: boolean;
  browserExecutable?: string;
  livePacks?: Record<string, LivePack> | null;
  model?: Partial<AgentModelConfig>;
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((entry) => fs.existsSync(entry));
}

export function detectBrowserExecutable(): string | undefined {
  if (process.env.AGENTOS_BROWSER_EXECUTABLE) {
    return process.env.AGENTOS_BROWSER_EXECUTABLE;
  }

  return firstExisting(CHROME_CANDIDATES[process.platform] ?? []);
}

export function resolveConfig(overrides: ConfigOverrides = {}): AgentOsConfig {
  const dataDir =
    overrides.dataDir ??
    process.env.AGENTOS_DATA_DIR ??
    path.join(process.cwd(), ".agentos");
  const daemonDir = path.join(dataDir, "daemon");

  return {
    port: Number(overrides.port ?? process.env.PORT ?? 3017),
    dataDir,
    daemonDir,
    dbPath: path.join(dataDir, "agentos.sqlite"),
    masterKeyPath: path.join(dataDir, "master.key"),
    inboxDir: path.join(dataDir, "inbox"),
    headless: overrides.headless ?? process.env.AGENTOS_HEADLESS !== "false",
    browserExecutable: overrides.browserExecutable ?? detectBrowserExecutable(),
    livePacks: overrides.livePacks ?? null,
    model: {
      baseUrl: overrides.model?.baseUrl ?? process.env.MODEL_BASE_URL,
      apiKey: overrides.model?.apiKey ?? process.env.MODEL_API_KEY,
      name: overrides.model?.name ?? process.env.MODEL_NAME,
      timeoutMs: Number(
        overrides.model?.timeoutMs ?? process.env.MODEL_TIMEOUT_MS ?? 45000
      )
    }
  };
}
