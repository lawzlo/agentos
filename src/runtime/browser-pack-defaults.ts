import type { WatchDetectionMetadata } from "../types/runtime-schema.js";

export function browserPackLabel(packName: string): string {
  if (packName === "slack-browser") {
    return "Slack";
  }
  if (packName === "generic-mail-browser") {
    return "mail";
  }
  if (packName === "boss-browser") {
    return "BOSS";
  }
  if (packName === "google-drive-browser") {
    return "Google Drive";
  }
  if (packName === "google-docs-browser") {
    return "Google Docs";
  }
  if (packName === "feishu-docs-browser") {
    return "Feishu Docs";
  }
  return String(packName ?? "").replace(/-browser$/u, "") || "browser";
}

export function defaultBrowserStartUrlForPack(packName: string | null | undefined): string | null {
  switch (String(packName ?? "").trim()) {
    case "slack-browser":
      return "https://app.slack.com/client";
    case "generic-mail-browser":
      return "https://outlook.office.com/mail/";
    case "boss-browser":
      return "https://www.zhipin.com/web/geek/chat";
    case "google-drive-browser":
      return "https://drive.google.com";
    case "google-docs-browser":
      return "https://docs.google.com";
    case "feishu-docs-browser":
      return "https://feishu.cn/docx";
    default:
      return null;
  }
}

export function inferBrowserManualInterventionFromUrl({
  packName,
  url
}: {
  packName: string;
  url: string | null | undefined;
}): {
  kind: WatchDetectionMetadata["manualInterventionKind"];
  summary: string;
  detail: string;
  action: string;
} | null {
  const normalizedUrl = String(url ?? "").trim().toLowerCase();
  if (!normalizedUrl) {
    return null;
  }

  const packLabel = browserPackLabel(packName);

  if (/(captcha|challenge|verification|verify)/iu.test(normalizedUrl)) {
    return {
      kind: "verification",
      summary: `${packLabel} needs a human verification step`,
      detail: `${packLabel} is showing a verification or CAPTCHA flow. AgentOS should pause this watch until you clear it manually.`,
      action: `Open ${packLabel} in the AgentOS browser workspace, complete the verification once, then let the watch continue.`
    };
  }

  if (
    /(workspace-signin|signin|login\.live\.com|login\.microsoftonline\.com|\/login\b|oauth|sso|auth)/iu.test(
      normalizedUrl
    )
  ) {
    return {
      kind: "login",
      summary: `${packLabel} needs sign-in`,
      detail: `${packLabel} is asking for sign-in before AgentOS can continue watching it.`,
      action: `Open ${packLabel} in the AgentOS browser workspace and sign in once, then retry the watch.`
    };
  }

  if (/(accessdenied|denied|forbidden|unauthorized)/iu.test(normalizedUrl)) {
    return {
      kind: "access_denied",
      summary: `${packLabel} access is blocked`,
      detail: `${packLabel} is showing an access or permission error. AgentOS cannot continue until the account or page access is fixed.`,
      action: `Check the current ${packLabel} account and permissions in the AgentOS browser workspace, then retry the watch.`
    };
  }

  return null;
}
