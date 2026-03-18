import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { InstallSource, InstallSourceInfo } from "./types/system.js";

interface InstallMetadataFile {
  source?: InstallSource;
  installRoot?: string | null;
  wrapperPath?: string | null;
  bundledRuntime?: boolean;
  runtimeExecutablePath?: string | null;
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
    uninstallHint: "Run `agentos uninstall` or `npm run cli:unlink` from the source checkout."
  };
}

export async function detectInstallSource(options: { distRoot?: string } = {}): Promise<InstallSourceInfo> {
  const distRoot = options.distRoot ? path.resolve(options.distRoot) : currentDistRoot();
  const installRoot = path.resolve(distRoot, "..");
  const metadataPath = path.join(installRoot, "install-metadata.json");

  try {
    const raw = await fs.readFile(metadataPath, "utf8");
    const metadata = JSON.parse(raw) as InstallMetadataFile;
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
        uninstallHint: "Remove the installed files under /opt/agentos and the /usr/local/bin/agentos wrapper after stopping AgentOS."
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
        uninstallHint: "Use Installed Apps to remove AgentOS, then optionally delete the data directory."
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
      uninstallHint: null
    };
  } catch {
    return sourceInstallInfo(distRoot);
  }
}
