import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_PROTOCOL_VERSION = 1;
export const NATIVE_PROTOCOL_VERSION = 1;
export const STORE_SCHEMA_VERSION = 1;
export const INSTALL_LAYOUT_VERSION = 1;

function packageJsonPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
}

function readPackageVersion(): string {
  try {
    const raw = fs.readFileSync(packageJsonPath(), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return String(parsed.version ?? process.env.AGENTOS_BUILD_VERSION ?? "0.0.0");
  } catch {
    return String(process.env.AGENTOS_BUILD_VERSION ?? "0.0.0");
  }
}

export function getRuntimeVersionInfo() {
  return {
    appVersion: readPackageVersion(),
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    nativeProtocolVersion: NATIVE_PROTOCOL_VERSION,
    storeSchemaVersion: STORE_SCHEMA_VERSION,
    installLayoutVersion: INSTALL_LAYOUT_VERSION
  };
}
