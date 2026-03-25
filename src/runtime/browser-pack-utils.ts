import crypto from "node:crypto";
import {
  browserPackLabel,
  defaultBrowserStartUrlForPack,
  inferBrowserManualInterventionFromUrl
} from "./browser-pack-defaults.js";
import { visibleLines } from "./surface-signal-utils.js";
import type { WatchDetection, WatchDetectionMetadata, WatchRule, WorldState } from "../types/runtime-schema.js";

const GOOGLE_DRIVE_UI_CHROME_PATTERN =
  /^(google drive|my drive|priority|recent|shared with me|shared drives|starred|trash|upload to drive|drive uploaded|search)$/iu;
const GOOGLE_DOCS_UI_CHROME_PATTERN =
  /^(google docs|google docs editor|save google doc|saved in google docs|share|comment|format|insert|tools|extensions)$/iu;
const FEISHU_DOCS_UI_CHROME_PATTERN =
  /^(feishu docs|飞书文档编辑区|保存到飞书|已保存到飞书|分享|评论|工具栏|更多)$/iu;
const LOGIN_REQUIRED_PATTERN =
  /(sign in|log in|login|sign into|continue with|重新登录|重新登入|请登录|请先登录|登录继续|登录后继续|登入|登陆|登录|扫码登录)/iu;
const SESSION_EXPIRED_PATTERN =
  /(session expired|sign in again|log in again|reauthenticate|重新登录|会话已过期|登录已过期|登录失效|当前登录状态已失效|登录状态已失效|身份已过期)/iu;
const VERIFICATION_REQUIRED_PATTERN =
  /(captcha|recaptcha|hcaptcha|verify you are human|verify you're human|security check|bot check|are you human|人机验证|验证码|安全验证|验证你是人类|请完成验证)/iu;
const ACCESS_DENIED_PATTERN =
  /(access denied|forbidden|permission denied|unauthorized|not authorized|拒绝访问|无权限|没有权限|访问受限)/iu;

function fingerprint(value: unknown): string {
  return crypto.createHash("sha1").update(String(value ?? "")).digest("hex");
}

export function normalizeDocsSummary(value: string, prefixes: string[] = []): string {
  let summary = String(value ?? "")
    .replace(/^[●•]\s*/u, "")
    .replace(/^\(\d+\)\s*/u, "")
    .replace(/\s+\(\d+\)$/u, "")
    .trim();

  for (const prefix of prefixes) {
    const pattern = new RegExp(`^${prefix}\\s*[:：-]?\\s*`, "iu");
    summary = summary.replace(pattern, "").trim();
  }

  return summary;
}

export function isDriveUiChrome(text: string): boolean {
  return GOOGLE_DRIVE_UI_CHROME_PATTERN.test(String(text ?? "").trim());
}

export function isGoogleDocsUiChrome(text: string): boolean {
  return GOOGLE_DOCS_UI_CHROME_PATTERN.test(String(text ?? "").trim());
}

export function isFeishuDocsUiChrome(text: string): boolean {
  return FEISHU_DOCS_UI_CHROME_PATTERN.test(String(text ?? "").trim());
}

export function inferBrowserPageUrl(worldState: WorldState | null): string | null {
  const url = String(((worldState?.appContext ?? {}) as { url?: unknown }).url ?? "").trim();
  return /^https?:\/\//u.test(url) ? url : null;
}

export function detectBrowserManualIntervention({
  packName,
  worldState,
  rule,
  dedupeState = {}
}: {
  packName: string;
  worldState: WorldState | null;
  rule: WatchRule;
  dedupeState?: Record<string, unknown>;
}): WatchDetection | null {
  const lines = visibleLines(worldState).slice(0, 40);
  const pageText = lines.join("\n");
  const url = inferBrowserPageUrl(worldState);
  const packLabel = browserPackLabel(packName);
  const baseInputs = {
    startUrl: String(rule.taskInputs?.startUrl ?? rule.taskInputs?.url ?? url ?? defaultBrowserStartUrlForPack(packName) ?? "").trim()
  };

  let kind: WatchDetectionMetadata["manualInterventionKind"] = null;
  let detail = "";
  let action = "";
  let summary = "";

  const manualInterventionFromUrl = inferBrowserManualInterventionFromUrl({ packName, url });
  if (manualInterventionFromUrl) {
    kind = manualInterventionFromUrl.kind;
    summary = manualInterventionFromUrl.summary;
    detail = manualInterventionFromUrl.detail;
    action = manualInterventionFromUrl.action;
  }

  if (!kind && !pageText.trim()) {
    return null;
  }

  if (!kind && VERIFICATION_REQUIRED_PATTERN.test(pageText)) {
    kind = "verification";
    summary = `${packLabel} needs a human verification step`;
    detail = `${packLabel} is showing a verification or CAPTCHA page. AgentOS should pause this watch until you clear it manually.`;
    action = `Open ${packLabel} in the AgentOS browser workspace, complete the verification once, then let the watch continue.`;
  } else if (!kind && SESSION_EXPIRED_PATTERN.test(pageText)) {
    kind = "session_expired";
    summary = `${packLabel} session expired`;
    detail = `${packLabel} looks signed out or the browser session expired. AgentOS cannot continue this watch until the session is restored.`;
    action = `Open ${packLabel} in the AgentOS browser workspace and sign in again, then retry the watch.`;
  } else if (!kind && LOGIN_REQUIRED_PATTERN.test(pageText)) {
    kind = "login";
    summary = `${packLabel} needs sign-in`;
    detail = `${packLabel} is asking for sign-in before AgentOS can continue watching it.`;
    action = `Open ${packLabel} in the AgentOS browser workspace and sign in once, then retry the watch.`;
  } else if (!kind && ACCESS_DENIED_PATTERN.test(pageText)) {
    kind = "access_denied";
    summary = `${packLabel} access is blocked`;
    detail = `${packLabel} is showing an access or permission error. AgentOS cannot continue until the account or page access is fixed.`;
    action = `Check the current ${packLabel} account and permissions in the AgentOS browser workspace, then retry the watch.`;
  }

  if (!kind) {
    return null;
  }

  const fingerprintValue = fingerprint(`${packName}:manual:${kind}:${url ?? ""}:${pageText.slice(0, 500)}`);
  if (dedupeState.lastFingerprint === fingerprintValue) {
    return null;
  }

  return {
    fingerprint: fingerprintValue,
    summary,
    goal: `${summary}. ${action}`,
    text: summary,
    context: lines.slice(0, 6),
    inputs: {
      watchSummary: summary,
      watchContext: lines.slice(0, 6).join("\n"),
      ...baseInputs
    },
    metadata: {
      surface: "browser",
      requiresAttention: true,
      requiresManualIntervention: true,
      manualInterventionKind: kind,
      manualInterventionDetail: detail,
      manualInterventionAction: action
    }
  };
}
