import process from "node:process";
import { createInterface } from "node:readline/promises";
import path from "node:path";

import { detectInstallSourceSync } from "../../src/install-source.js";
import {
  activateLicense,
  clearLicenseCredentials,
  refreshLicense,
  resolveLicenseState
} from "../../src/license.js";
import {
  ensureLicenseServerKeyPair,
  issueLicenseActivationToken,
  startLicenseServer
} from "../../src/license-server.js";
import { boolOption, config, isRemoteControlPlaneMode, print, restartLocalDaemon, type CliOptions } from "../cli-utils.js";

async function promptToken(promptLabel: string) {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY)
  });
  try {
    const answer = (await readline.question(`${promptLabel}\n> `)).trim();
    if (!answer) {
      throw new Error("A license token is required.");
    }
    return answer;
  } finally {
    readline.close();
  }
}

function renderLicenseStatus() {
  const installSource = detectInstallSourceSync();
  const state = resolveLicenseState(config, installSource);
  return {
    installSource,
    license: state
  };
}

async function maybeRestartDaemon() {
  if (isRemoteControlPlaneMode()) {
    return {
      restarted: false,
      daemon: null
    };
  }
  return restartLocalDaemon();
}

export async function commandLicense(subcommand: string | undefined, positionals: string[], options: CliOptions) {
  if (!subcommand || subcommand === "status") {
    if (boolOption(options.refresh)) {
      await refreshLicense(config).catch(() => undefined);
    }
    const payload = renderLicenseStatus();
    if (options.json) {
      print(payload, options);
      return;
    }
    print(
      [
        "AgentOS license status",
        "",
        `Tier: ${payload.license.tier.toUpperCase()}`,
        `Status: ${payload.license.status}`,
        `Install source: ${payload.installSource.label}`,
        `Developer mode: ${payload.license.developerMode ? "yes" : "no"}`,
        `Device id: ${payload.license.deviceId ?? "unknown"}`,
        `Account: ${payload.license.accountId ?? "not linked"}`,
        `Reason: ${payload.license.reason ?? "none"}`,
        `Max watches: ${payload.license.capabilities.maxWatches}`,
        `Premium packs: ${payload.license.capabilities.premiumPacksEnabled ? "enabled" : "disabled"}`,
        `Claude Code CLI: ${payload.license.capabilities.claudeCodeCliEnabled ? "enabled" : "disabled"}`
      ].join("\n"),
      options
    );
    return;
  }

  if (subcommand === "activate" || subcommand === "login") {
    const token =
      (typeof options.token === "string" ? options.token : null)
      ?? (typeof positionals[0] === "string" ? positionals[0] : null)
      ?? (process.stdin.isTTY ? await promptToken("Paste your AgentOS Pro activation token") : null);
    if (!token) {
      throw new Error("License activation requires --token <value> or interactive input.");
    }
    const license = await activateLicense(config, token);
    const restarted = await maybeRestartDaemon();
    const payload = {
      ok: true,
      license,
      daemonRestarted: restarted.restarted,
      daemonPort: restarted.daemon?.port ?? null
    };
    print(
      options.json
        ? payload
        : [
            "AgentOS license activated",
            "",
            `Tier: ${license.tier.toUpperCase()}`,
            `Status: ${license.status}`,
            `Account: ${license.accountId ?? "unknown"}`,
            restarted.restarted
              ? `Restarted the local daemon on http://127.0.0.1:${restarted.daemon?.port ?? 3017}.`
              : isRemoteControlPlaneMode()
                ? "Remote control plane detected. Restart that daemon to reload the updated license."
                : "No running local daemon was detected."
          ].join("\n"),
      options
    );
    return;
  }

  if (subcommand === "refresh") {
    const license = await refreshLicense(config);
    const restarted = await maybeRestartDaemon();
    print(
      options.json
        ? { ok: true, license, daemonRestarted: restarted.restarted, daemonPort: restarted.daemon?.port ?? null }
        : [
            "AgentOS license refreshed",
            "",
            `Tier: ${license.tier.toUpperCase()}`,
            `Status: ${license.status}`,
            restarted.restarted
              ? `Restarted the local daemon on http://127.0.0.1:${restarted.daemon?.port ?? 3017}.`
              : "No running local daemon was detected."
          ].join("\n"),
      options
    );
    return;
  }

  if (subcommand === "init-dev") {
    const dataDir = typeof options.dataDir === "string"
      ? path.resolve(String(options.dataDir))
      : path.join(config.dataDir, "license-service");
    const paths = ensureLicenseServerKeyPair({
      dataDir,
      privateKeyPath: typeof options.privateKeyPath === "string" ? String(options.privateKeyPath) : undefined,
      publicKeyPath: typeof options.publicKeyPath === "string" ? String(options.publicKeyPath) : undefined
    });
    print(
      options.json
        ? { ok: true, dataDir, ...paths }
        : [
            "AgentOS dev license keys ready",
            "",
            `Data dir: ${dataDir}`,
            `Private key: ${paths.privateKeyPath}`,
            `Public key: ${paths.publicKeyPath}`,
            "",
            `Set AGENTOS_LICENSE_PUBLIC_KEY_PATH=${paths.publicKeyPath} in the client runtime.`
          ].join("\n"),
      options
    );
    return;
  }

  if (subcommand === "issue-token") {
    const dataDir = typeof options.dataDir === "string"
      ? path.resolve(String(options.dataDir))
      : path.join(config.dataDir, "license-service");
    const accountId =
      (typeof options.account === "string" ? String(options.account).trim() : "")
      || (typeof positionals[0] === "string" ? String(positionals[0]).trim() : "")
      || "acct-pro";
    const tier = String(options.tier ?? "pro").trim().toLowerCase() === "free" ? "free" : "pro";
    const token = typeof options.token === "string" ? String(options.token).trim() : undefined;
    const issued = await issueLicenseActivationToken({
      dataDir,
      accountId,
      tier,
      ...(token ? { token } : {})
    });
    print(
      options.json
        ? { ok: true, token: issued.token, accountId: issued.record.accountId, tier: issued.record.tier, dataDir }
        : [
            "AgentOS license token issued",
            "",
            `Account: ${issued.record.accountId}`,
            `Tier: ${issued.record.tier.toUpperCase()}`,
            `Token: ${issued.token}`,
            "",
            `Use: agentos license activate --token ${issued.token}`
          ].join("\n"),
      options
    );
    return;
  }

  if (subcommand === "serve") {
    const dataDir = typeof options.dataDir === "string"
      ? path.resolve(String(options.dataDir))
      : path.join(config.dataDir, "license-service");
    const started = await startLicenseServer({
      dataDir,
      host: typeof options.host === "string" ? String(options.host) : undefined,
      port: typeof options.port === "string" ? Number(options.port) : undefined,
      privateKeyPath: typeof options.privateKeyPath === "string" ? String(options.privateKeyPath) : undefined,
      publicKeyPath: typeof options.publicKeyPath === "string" ? String(options.publicKeyPath) : undefined,
      leaseDurationDays: typeof options.leaseDays === "string" ? Number(options.leaseDays) : undefined,
      offlineGraceDays: typeof options.offlineGraceDays === "string" ? Number(options.offlineGraceDays) : undefined
    });
    print(
      options.json
        ? {
            ok: true,
            baseUrl: started.baseUrl,
            host: started.host,
            port: started.port,
            dataDir,
            publicKeyPath: started.paths.publicKeyPath,
            privateKeyPath: started.paths.privateKeyPath
          }
        : [
            "AgentOS license service running",
            "",
            `Base URL: ${started.baseUrl}`,
            `Data dir: ${dataDir}`,
            `Public key: ${started.paths.publicKeyPath}`,
            `Private key: ${started.paths.privateKeyPath}`,
            "",
            "Press Ctrl+C to stop."
          ].join("\n"),
      options
    );

    await new Promise<void>((resolve) => {
      const stop = async () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        await started.close();
        resolve();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
    return;
  }

  if (subcommand === "logout") {
    await clearLicenseCredentials(config.dataDir);
    const restarted = await maybeRestartDaemon();
    print(
      options.json
        ? { ok: true, cleared: true, daemonRestarted: restarted.restarted, daemonPort: restarted.daemon?.port ?? null }
        : [
            "AgentOS license cleared",
            "",
            restarted.restarted
              ? `Restarted the local daemon on http://127.0.0.1:${restarted.daemon?.port ?? 3017}.`
              : "No running local daemon was detected. AgentOS will fall back to Free mode on the next start."
          ].join("\n"),
      options
    );
    return;
  }

  throw new Error(`Unsupported license command: ${subcommand}`);
}
