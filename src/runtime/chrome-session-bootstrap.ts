import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { promisify } from "node:util";

import {
  resolveChromeProfileSource,
  type ChromeProfileSource
} from "./chrome-profile-utils.js";

const execFileAsync = promisify(execFile);
const DEFAULT_ATTACH_EXISTING_CDP_BASE_URL = "http://127.0.0.1:9222";
const LOCAL_CDP_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface ChromeAttachSession {
  cdpUrl: string;
  cdpBaseUrl: string;
  debugPort: number;
  bootstrapped: boolean;
}

interface ChromeCdpBootstrapTarget {
  cdpBaseUrl: string;
  debugPort: number;
  local: boolean;
}

export interface ChromeSessionBootstrapDeps {
  fetchImpl?: typeof fetch;
  waitImpl?: (ms: number) => Promise<void>;
  spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  execFileImpl?: (file: string, args: readonly string[]) => Promise<void>;
  resolveChromeProfileSourceImpl?: (preferredPath?: string | null) => Promise<ChromeProfileSource | null>;
  platform?: NodeJS.Platform;
}

function waitForMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeAppleScript(text: string): string {
  return String(text).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function normalizeBootstrapEndpoint(value: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return DEFAULT_ATTACH_EXISTING_CDP_BASE_URL;
  }
  if (/^\d+$/u.test(normalized)) {
    return `http://127.0.0.1:${normalized}`;
  }
  if (/^[^:/]+:\d+$/u.test(normalized)) {
    return `http://${normalized}`;
  }
  return normalized;
}

function defaultPortForProtocol(protocol: string): number {
  return protocol === "https:" || protocol === "wss:" ? 443 : 80;
}

function resolveBootstrapTarget(endpoint: string | null | undefined): ChromeCdpBootstrapTarget {
  const normalized = normalizeBootstrapEndpoint(String(endpoint ?? ""));
  const parsed = new URL(normalized);
  const debugPort = parsed.port ? Number(parsed.port) : defaultPortForProtocol(parsed.protocol);
  const baseProtocol =
    parsed.protocol === "ws:"
      ? "http:"
      : parsed.protocol === "wss:"
        ? "https:"
        : parsed.protocol;
  const cdpBaseUrl = `${baseProtocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;

  return {
    cdpBaseUrl,
    debugPort,
    local: LOCAL_CDP_HOSTS.has(parsed.hostname)
  };
}

async function fetchCdpWebSocketUrl(
  cdpBaseUrl: string,
  fetchImpl: typeof fetch
): Promise<string | null> {
  try {
    const response = await fetchImpl(`${cdpBaseUrl}/json/version`);
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { webSocketDebuggerUrl?: string };
    return typeof payload.webSocketDebuggerUrl === "string" && payload.webSocketDebuggerUrl
      ? payload.webSocketDebuggerUrl
      : null;
  } catch {
    return null;
  }
}

async function waitForCdpWebSocketUrl(
  cdpBaseUrl: string,
  timeoutMs: number,
  deps: Pick<ChromeSessionBootstrapDeps, "fetchImpl" | "waitImpl">
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const waitImpl = deps.waitImpl ?? waitForMs;
  const deadline = Date.now() + timeoutMs;
  let lastError = "timeout";

  while (Date.now() < deadline) {
    try {
      const cdpUrl = await fetchCdpWebSocketUrl(cdpBaseUrl, fetchImpl);
      if (cdpUrl) {
        return cdpUrl;
      }
      lastError = "endpoint unavailable";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await waitImpl(250);
  }

  throw new Error(`Browser CDP endpoint did not become ready at ${cdpBaseUrl}: ${lastError}`);
}

function inferMacAppName(browserExecutable: string): string | null {
  const normalized = String(browserExecutable ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized.includes("google chrome")) {
    return "Google Chrome";
  }
  if (normalized.includes("chromium")) {
    return "Chromium";
  }
  if (normalized.includes("microsoft edge") || normalized.includes("msedge")) {
    return "Microsoft Edge";
  }
  return null;
}

function buildChromeLaunchArgs({
  debugPort,
  profileSource
}: {
  debugPort: number;
  profileSource: ChromeProfileSource | null;
}): string[] {
  const args = [
    `--remote-debugging-port=${debugPort}`,
    "--remote-debugging-address=127.0.0.1",
    "--restore-last-session",
    "--no-first-run",
    "--no-default-browser-check"
  ];

  if (profileSource?.userDataDir) {
    args.push(`--user-data-dir=${profileSource.userDataDir}`);
  }
  if (profileSource?.profileDirectory) {
    args.push(`--profile-directory=${profileSource.profileDirectory}`);
  }

  return args;
}

async function quitRunningMacBrowser({
  browserExecutable,
  execFileImpl,
  waitImpl
}: {
  browserExecutable: string;
  execFileImpl: NonNullable<ChromeSessionBootstrapDeps["execFileImpl"]>;
  waitImpl: NonNullable<ChromeSessionBootstrapDeps["waitImpl"]>;
}): Promise<void> {
  const appName = inferMacAppName(browserExecutable);
  if (!appName) {
    return;
  }

  const escapedAppName = escapeAppleScript(appName);
  await execFileImpl("osascript", [
    "-e",
    `if application "${escapedAppName}" is running then tell application "${escapedAppName}" to quit`
  ]);
  await waitImpl(1200);
}

function launchBrowserProcess({
  browserExecutable,
  args,
  spawnImpl
}: {
  browserExecutable: string;
  args: string[];
  spawnImpl: NonNullable<ChromeSessionBootstrapDeps["spawnImpl"]>;
}): void {
  const child = spawnImpl(browserExecutable, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref?.();
}

export async function ensureAttachableChromeSession(
  {
    browserExecutable,
    browserCdpUrl,
    timeoutMs = 30000
  }: {
    browserExecutable: string | null;
    browserCdpUrl?: string | null;
    timeoutMs?: number;
  },
  deps: ChromeSessionBootstrapDeps = {}
): Promise<ChromeAttachSession> {
  const target = resolveBootstrapTarget(browserCdpUrl);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const waitImpl = deps.waitImpl ?? waitForMs;
  const spawnImpl = deps.spawnImpl ?? spawn;
  const execFileImpl =
    deps.execFileImpl
    ?? (async (file: string, args: readonly string[]) => {
      await execFileAsync(file, [...args]);
    });
  const resolveChromeProfileSourceImpl = deps.resolveChromeProfileSourceImpl ?? resolveChromeProfileSource;
  const platform = deps.platform ?? process.platform;

  const existingCdpUrl = await fetchCdpWebSocketUrl(target.cdpBaseUrl, fetchImpl);
  if (existingCdpUrl) {
    return {
      cdpUrl: existingCdpUrl,
      cdpBaseUrl: target.cdpBaseUrl,
      debugPort: target.debugPort,
      bootstrapped: false
    };
  }

  if (!target.local) {
    throw new Error(
      `Configured browser CDP endpoint ${target.cdpBaseUrl} is unavailable and cannot be bootstrapped because it is not local.`
    );
  }

  if (!browserExecutable) {
    throw new Error(
      `No attachable Chrome session is available at ${target.cdpBaseUrl}, and AgentOS could not bootstrap Chrome because no browser executable was detected.`
    );
  }

  const profileSource = await resolveChromeProfileSourceImpl(null);
  if (platform === "darwin") {
    await quitRunningMacBrowser({
      browserExecutable,
      execFileImpl,
      waitImpl
    });
  }

  launchBrowserProcess({
    browserExecutable,
    args: buildChromeLaunchArgs({
      debugPort: target.debugPort,
      profileSource
    }),
    spawnImpl
  });

  const cdpUrl = await waitForCdpWebSocketUrl(target.cdpBaseUrl, timeoutMs, {
    fetchImpl,
    waitImpl
  });
  return {
    cdpUrl,
    cdpBaseUrl: target.cdpBaseUrl,
    debugPort: target.debugPort,
    bootstrapped: true
  };
}
