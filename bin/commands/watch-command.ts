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
      triggerTexts: listify(options.trigger)
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
