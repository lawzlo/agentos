import {
  apiRequest,
  boolOption,
  type CliOptions,
  formatWatch,
  listify,
  parseInputs,
  print
} from "../cli-utils.js";
import type { WatchHealth, WatchRule } from "../../src/types/runtime-schema.js";

function parseQuietHours(value: unknown) {
  if (value == null) {
    return undefined;
  }

  const match = String(value)
    .trim()
    .match(/^(\d{1,2})(?::\d{2})?\s*-\s*(\d{1,2})(?::\d{2})?$/u);
  if (!match) {
    throw new Error("quiet hours must look like 22-8 or 22:00-08:00");
  }

  const startHour = Number(match[1]);
  const endHour = Number(match[2]);
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour) || startHour < 0 || startHour > 23 || endHour < 0 || endHour > 23) {
    throw new Error("quiet hours must use 0-23 hour values");
  }

  return { startHour, endHour };
}

function parseGovernance(options: CliOptions) {
  const governance: Record<string, unknown> = {};
  if (options.approval) {
    governance.approvalMode = String(options.approval);
  }
  if (options.replyPolicy) {
    governance.replyPolicy = String(options.replyPolicy);
  }
  if (options.replyApprovalWindowMs != null) {
    governance.replyApprovalWindowMs = Number(options.replyApprovalWindowMs);
  }
  if (options.cooldownMs != null) {
    governance.cooldownMs = Number(options.cooldownMs);
  }
  if (options.maxAutoActionsPerDay != null) {
    governance.maxAutoActionsPerDay = Number(options.maxAutoActionsPerDay);
  }
  if (options.maxConsecutiveFailures != null) {
    governance.maxConsecutiveFailures = Number(options.maxConsecutiveFailures);
  }
  if (options.quietHours) {
    governance.quietHours = parseQuietHours(options.quietHours);
  }

  return Object.keys(governance).length ? governance : undefined;
}

export async function commandWatch(subcommand: string | undefined, positionals: string[], options: CliOptions) {
  if (subcommand === "add") {
    const goal = positionals.join(" ").trim();
    if (!goal) {
      throw new Error("watch add requires a goal");
    }

    const payload = await apiRequest<{ watch: WatchRule }>("POST", "/watches", {
      goal,
      preferredSurface: options.surface,
      workspaceName: options.workspace,
      skillName: options.skill,
      appTarget: options.app,
      livePack: options.pack,
      pollIntervalMs: options.interval ? Number(options.interval) : undefined,
      governance: parseGovernance(options),
      inputs: parseInputs(options.input)
    });
    print(payload.watch, options);
    return;
  }

  if (subcommand === "teach") {
    const [taskId, ...goalParts] = positionals;
    if (!taskId) {
      throw new Error("watch teach requires a completed task id");
    }

    const payload = await apiRequest<{ watch: WatchRule }>("POST", "/watches/from-task", {
      taskId,
      watchRuleId: options.watch ?? null,
      goal: goalParts.join(" ").trim() || undefined,
      preferredSurface: options.surface,
      workspaceName: options.workspace,
      skillName: options.skill,
      appTarget: options.app,
      livePack: options.pack,
      pollIntervalMs: options.interval ? Number(options.interval) : undefined,
      enabled: options.enabled == null ? true : boolOption(options.enabled),
      triggerTexts: listify(options.trigger),
      governance: parseGovernance(options)
    });
    print(payload.watch, options);
    return;
  }

  if (subcommand === "ls") {
    const payload = await apiRequest<{ watches: WatchRule[] }>("GET", "/watches");
    if (options.json) {
      print(payload.watches, options);
      return;
    }
    console.log(payload.watches.map(formatWatch).join("\n") || "No watch rules found.");
    return;
  }

  if (subcommand === "inspect") {
    const [watchId] = positionals;
    const payload = await apiRequest<{ watch: WatchRule }>("GET", `/watches/${watchId}`);
    print(payload.watch, options);
    return;
  }

  if (subcommand === "health") {
    const [watchId] = positionals;
    const payload = await apiRequest<{ health: WatchHealth }>("GET", `/watches/${watchId}/health`);
    print(payload.health, options);
    return;
  }

  if (subcommand === "enable" || subcommand === "disable") {
    const [watchId] = positionals;
    const payload = await apiRequest<{ watch: WatchRule }>("POST", `/watches/${watchId}/${subcommand}`);
    print(payload.watch, options);
    return;
  }

  if (subcommand === "retry") {
    const [watchId] = positionals;
    const payload = await apiRequest<{ watch: WatchRule }>("POST", `/watches/${watchId}/retry`);
    print(payload.watch, options);
    return;
  }

  if (subcommand === "rm") {
    const [watchId] = positionals;
    const payload = await apiRequest<{ ok: boolean }>("DELETE", `/watches/${watchId}`);
    print(payload, options);
    return;
  }

  throw new Error(`Unsupported watch command: ${subcommand}`);
}
