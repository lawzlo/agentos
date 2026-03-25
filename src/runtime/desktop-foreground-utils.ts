import type { WorldState } from "../types/runtime-schema.js";

export function isExpectedDesktopForeground(worldState: WorldState | null, targetAppName: string): boolean {
  if (!worldState || worldState.surface !== "desktop") {
    return true;
  }

  const appContext = (worldState.appContext ?? {}) as Record<string, unknown>;
  const currentAppName = String(appContext.appName ?? "").trim().toLowerCase();
  const normalizedTarget = String(targetAppName ?? "").trim().toLowerCase();
  if (!normalizedTarget) {
    return true;
  }

  const aliases =
    normalizedTarget.includes("outlook")
      ? ["outlook"]
      : normalizedTarget.includes("wechat") || normalizedTarget.includes("微信")
        ? ["wechat", "微信"]
        : normalizedTarget.includes("slack")
          ? ["slack"]
          : [normalizedTarget];
  return aliases.some((alias) => currentAppName.includes(alias));
}

export function isSlackDesktopForeground(worldState: WorldState | null): boolean {
  return isExpectedDesktopForeground(worldState, "Slack");
}

export function isWeChatDesktopForeground(worldState: WorldState | null): boolean {
  return isExpectedDesktopForeground(worldState, "WeChat");
}

export function isOutlookDesktopForeground(worldState: WorldState | null): boolean {
  return isExpectedDesktopForeground(worldState, "Microsoft Outlook");
}
