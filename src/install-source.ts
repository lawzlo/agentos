import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { InstallSource, InstallSourceInfo } from "./types/system.js";

interface InstallMetadataFile {
  source?: InstallSource;
  installRoot?: string | null;
  wrapperPath?: string | null;
  bundledRuntime?: boolean;
  runtimeExecutablePath?: string | null;
  buildChannel?: string | null;
  licenseEnforced?: boolean | null;
}

function currentDistRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function sourceInstallInfo(distRoot: string): InstallSourceInfo {
  return {
    source: "source",
    label: "source checkout or npm link",
    installRoot: path.resolve(distRoot, ".."),
    wrapperPath: null,
    metadataPath: null,
    managedInstallation: false,
    bundledRuntime: false,
    runtimeExecutablePath: process.execPath,
    uninstallHint: "Run `agentos uninstall` or `npm run cli:unlink` from the source checkout.",
    buildChannel: "source",
    licenseEnforced: false
  };
}

function parseInstallMetadata(metadataPath: string): InstallMetadataFile | null {
  try {
    return JSON.parse(fs.readFileSync(metadataPath, "utf8")) as InstallMetadataFile;
  } catch {
    return null;
  }
}

function installInfoFromMetadata({
  installRoot,
  metadataPath,
  metadata
}: {
  installRoot: string;
  metadataPath: string;
  metadata: InstallMetadataFile;
}): InstallSourceInfo {
  const source = metadata.source ?? "unknown";
  if (source === "macos_pkg") {
    return {
      source,
      label: "macOS pkg installation",
      installRoot: metadata.installRoot ?? installRoot,
      wrapperPath: metadata.wrapperPath ?? "/usr/local/bin/agentos",
      metadataPath,
      managedInstallation: true,
      bundledRuntime: metadata.bundledRuntime ?? false,
      runtimeExecutablePath: metadata.runtimeExecutablePath ?? (metadata.bundledRuntime ? process.execPath : null),
      uninstallHint: "Remove the installed files under /opt/agentos and the /usr/local/bin/agentos wrapper after stopping AgentOS.",
      buildChannel: metadata.buildChannel ?? "stable",
      licenseEnforced: metadata.licenseEnforced ?? true
    };
  }
  if (source === "windows_msi") {
    return {
      source,
      label: "Windows MSI installation",
      installRoot: metadata.installRoot ?? installRoot,
      wrapperPath: metadata.wrapperPath ?? null,
      metadataPath,
      managedInstallation: true,
      bundledRuntime: metadata.bundledRuntime ?? false,
      runtimeExecutablePath: metadata.runtimeExecutablePath ?? (metadata.bundledRuntime ? process.execPath : null),
      uninstallHint: "Use Installed Apps to remove AgentOS, then optionally delete the data directory.",
      buildChannel: metadata.buildChannel ?? "stable",
      licenseEnforced: metadata.licenseEnforced ?? true
    };
  }
  return {
    source,
    label: "managed installation",
    installRoot: metadata.installRoot ?? installRoot,
    wrapperPath: metadata.wrapperPath ?? null,
    metadataPath,
    managedInstallation: source !== "source",
    bundledRuntime: metadata.bundledRuntime ?? false,
    runtimeExecutablePath: metadata.runtimeExecutablePath ?? (metadata.bundledRuntime ? process.execPath : null),
    uninstallHint: null,
    buildChannel: metadata.buildChannel ?? null,
    licenseEnforced: metadata.licenseEnforced ?? (source === "source" ? false : true)
  };
}

export async function detectInstallSource(options: { distRoot?: string } = {}): Promise<InstallSourceInfo> {
  const distRoot = options.distRoot ? path.resolve(options.distRoot) : currentDistRoot();
  const installRoot = path.resolve(distRoot, "..");
  const metadataPath = path.join(installRoot, "install-metadata.json");

  try {
    const raw = await fsp.readFile(metadataPath, "utf8");
    const metadata = JSON.parse(raw) as InstallMetadataFile;
    return installInfoFromMetadata({ installRoot, metadataPath, metadata });
  } catch {
    return sourceInstallInfo(distRoot);
  }
}

export function detectInstallSourceSync(options: { distRoot?: string } = {}): InstallSourceInfo {
  const distRoot = options.distRoot ? path.resolve(options.distRoot) : currentDistRoot();
  const installRoot = path.resolve(distRoot, "..");
  const metadataPath = path.join(installRoot, "install-metadata.json");
  const metadata = parseInstallMetadata(metadataPath);
  if (!metadata) {
    return sourceInstallInfo(distRoot);
  }
  return installInfoFromMetadata({ installRoot, metadataPath, metadata });
}
