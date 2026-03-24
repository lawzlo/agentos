import type { AgentOsConfig } from "../config.js";
import type { LivePackHealthCheck, LivePackInfo } from "../types/runtime-schema.js";
import type { LicenseState, NativeDiagnostics } from "../types/system.js";

export function withLivePackHealth(
  pack: LivePackInfo,
  {
    config,
    native,
    license
  }: {
    config: Pick<AgentOsConfig, "browserExecutable">;
    native: NativeDiagnostics;
    license: LicenseState;
  }
): LivePackInfo {
  const healthChecks: LivePackHealthCheck[] = [];

  if ((pack.minimumLicenseTier ?? "free") === "pro" && !license.capabilities.premiumPacksEnabled) {
    healthChecks.push({
      id: "license-tier",
      label: "License tier",
      status: "blocked",
      detail: `${pack.name} requires AgentOS Pro.`
    });
  }

  if (pack.surface === "browser") {
    healthChecks.push(
      config.browserExecutable
        ? {
            id: "browser-runtime",
            label: "Browser runtime",
            status: "ready",
            detail: config.browserExecutable
          }
        : {
            id: "browser-runtime",
            label: "Browser runtime",
            status: "blocked",
            detail: "No browser executable configured. Set AGENTOS_BROWSER_EXECUTABLE."
          }
    );
  }

  if (pack.surface === "desktop") {
    if (process.platform === "linux") {
      healthChecks.push({
        id: "desktop-runtime",
        label: "Desktop runtime",
        status: "ready",
        detail: "Linux desktop automation does not require the native sidecar."
      });
    } else if (!native.available) {
      healthChecks.push({
        id: "desktop-runtime",
        label: "Desktop runtime",
        status: "blocked",
        detail: native.reason ?? "Native desktop bridge is unavailable."
      });
    } else if (!native.compatible) {
      healthChecks.push({
        id: "desktop-runtime",
        label: "Desktop runtime",
        status: "blocked",
        detail: "Native sidecar protocol does not match the runtime."
      });
    } else {
      healthChecks.push({
        id: "desktop-runtime",
        label: "Desktop runtime",
        status: "ready",
        detail: "Native desktop bridge is available."
      });
    }

    if (native.permissions && Object.values(native.permissions).some((value) => value === false)) {
      healthChecks.push({
        id: "desktop-permissions",
        label: "Desktop permissions",
        status: "warning",
        detail: "One or more desktop automation permissions are not granted."
      });
    } else if (pack.surface === "desktop" && process.platform !== "linux" && native.available && native.compatible) {
      healthChecks.push({
        id: "desktop-permissions",
        label: "Desktop permissions",
        status: "ready",
        detail: "Desktop automation permissions look available."
      });
    }
  }

  return {
    ...pack,
    ready: !healthChecks.some((check) => check.status === "blocked"),
    healthChecks
  };
}
