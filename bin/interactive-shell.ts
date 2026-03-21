import process from "node:process";
import { createInterface } from "node:readline/promises";

import { commandDoctor, commandInspect, commandLogs, commandPs } from "./commands/task-command.js";
import { commandWatch } from "./commands/watch-command.js";
import { commandDrafts } from "./commands/drafts-command.js";
import { commandMemory } from "./commands/memory-command.js";
import { commandProposals } from "./commands/proposals-command.js";
import { commandJobs } from "./commands/jobs-command.js";
import { commandModel } from "./commands/model-command.js";
import { commandState } from "./commands/state-command.js";
import { buildSetupReport, commandSetup, renderOnboardingNotice } from "./commands/setup-command.js";
import {
  apiRequest,
  boolOption,
  daemonStatus,
  parseArgs,
  type CliOptions,
  waitForTask
} from "./cli-utils.js";
import type { TaskSnapshot } from "../src/types/runtime-schema.js";

interface InteractiveSessionState {
  surface?: string;
  workspace?: string;
  wait: boolean;
  timeout?: string | boolean;
}

function banner() {
  return [
    "AgentOS interactive shell",
    "Type a task in plain language and press Enter.",
    "Start with /setup and /model setup, then a plain-language goal, then a watch or job when you want always-on behavior.",
    "Slash commands: /help /setup [--fix] [--dry-run] /model [status|setup|clear] /state [--surface browser|desktop] [--app WeChat] [--pack ...] /status /doctor /ps /watch <goal> /watches /jobs /drafts /approve <draft-id> /reject <draft-id> [reason] /surface browser|desktop /workspace <name|clear> /wait on|off /exit"
  ].join("\n");
}

function promptLabel(state: InteractiveSessionState) {
  const parts = ["agentos"];
  if (state.surface) {
    parts.push(state.surface);
  }
  if (state.workspace) {
    parts.push(state.workspace);
  }
  return `${parts.join(":")}> `;
}

function printShellTask(task: TaskSnapshot) {
  const title = `${String(task.status).toUpperCase()} ${task.id}`;
  if (task.error) {
    console.log(`${title}\n${task.error}`);
    return;
  }

  if (task.result && Object.keys(task.result).length) {
    console.log(`${title}\n${JSON.stringify(task.result, null, 2)}`);
    return;
  }

  console.log(title);
}

function splitSlashCommand(input: string) {
  const trimmed = input.trim().replace(/^\/+/u, "");
  const firstWhitespace = trimmed.search(/\s/u);
  if (firstWhitespace === -1) {
    return {
      name: trimmed.toLowerCase(),
      rest: ""
    };
  }

  return {
    name: trimmed.slice(0, firstWhitespace).toLowerCase(),
    rest: trimmed.slice(firstWhitespace + 1).trim()
  };
}

function firstWord(input: string) {
  return input.trim().split(/\s+/u).filter(Boolean)[0] ?? "";
}

function afterFirstWord(input: string) {
  const trimmed = input.trim();
  const match = trimmed.match(/^\S+\s+(.+)$/u);
  return match?.[1]?.trim() ?? "";
}

function parseToggle(value: string) {
  const normalized = value.trim().toLowerCase();
  if (["on", "true", "1", "yes"].includes(normalized)) {
    return true;
  }
  if (["off", "false", "0", "no"].includes(normalized)) {
    return false;
  }
  return boolOption(value);
}

async function runInteractiveTask(goal: string, state: InteractiveSessionState) {
  const response = await apiRequest<{ task: TaskSnapshot }>("POST", "/tasks", {
    goal,
    preferredSurface: state.surface,
    workspaceName: state.workspace
  });

  if (!state.wait) {
    console.log(`Queued ${response.task.id}`);
    return;
  }

  const task = await waitForTask(response.task.id, Number(state.timeout ?? 30000));
  printShellTask(task);
}

async function handleSlashCommand(input: string, state: InteractiveSessionState) {
  const { name, rest } = splitSlashCommand(input);

  if (!name || name === "help") {
    console.log(banner());
    return false;
  }

  if (name === "exit" || name === "quit") {
    return true;
  }

  if (name === "status") {
    await daemonStatus({});
    return false;
  }

  if (name === "setup") {
    await commandSetup({
      fix: rest.includes("--fix"),
      dryRun: rest.includes("--dry-run")
    });
    return false;
  }

  if (name === "doctor") {
    await commandDoctor({});
    return false;
  }

  if (name === "model") {
    const next = firstWord(rest);
    await commandModel(next || "status", [], {});
    return false;
  }

  if (name === "state") {
    const { positionals, options } = parseArgs(rest ? rest.split(/\s+/u).filter(Boolean) : []);
    await commandState(undefined, positionals, {
      ...options,
      surface: options.surface ?? state.surface,
      workspace: options.workspace ?? state.workspace
    });
    return false;
  }

  if (name === "ps") {
    await commandPs({});
    return false;
  }

  if (name === "drafts") {
    await commandDrafts("ls", [], {});
    return false;
  }

  if (name === "watches") {
    await commandWatch("ls", [], {});
    return false;
  }

  if (name === "watch") {
    if (!rest) {
      throw new Error("/watch requires a goal");
    }
    await commandWatch("add", [rest], {
      surface: state.surface,
      workspace: state.workspace
    });
    return false;
  }

  if (name === "approve") {
    const draftId = firstWord(rest);
    if (!draftId) {
      throw new Error("/approve requires a draft id");
    }
    await commandDrafts("approve", [draftId], {});
    return false;
  }

  if (name === "reject") {
    const draftId = firstWord(rest);
    if (!draftId) {
      throw new Error("/reject requires a draft id");
    }
    await commandDrafts("reject", [draftId], {
      reason: afterFirstWord(rest) || null
    });
    return false;
  }

  if (name === "inspect") {
    const taskId = firstWord(rest);
    if (!taskId) {
      throw new Error("/inspect requires a task id");
    }
    await commandInspect(taskId, {});
    return false;
  }

  if (name === "logs") {
    const taskId = firstWord(rest);
    if (!taskId) {
      throw new Error("/logs requires a task id");
    }
    await commandLogs(taskId, {});
    return false;
  }

  if (name === "surface") {
    const nextSurface = firstWord(rest).toLowerCase();
    if (!["browser", "desktop"].includes(nextSurface)) {
      throw new Error("/surface requires browser or desktop");
    }
    state.surface = nextSurface;
    console.log(`Default surface: ${state.surface}`);
    return false;
  }

  if (name === "workspace") {
    const value = rest.trim();
    if (!value || ["clear", "none", "default"].includes(value.toLowerCase())) {
      state.workspace = undefined;
      console.log("Default workspace cleared.");
      return false;
    }
    state.workspace = value;
    console.log(`Default workspace: ${state.workspace}`);
    return false;
  }

  if (name === "wait") {
    if (!rest) {
      console.log(`Wait mode: ${state.wait ? "on" : "off"}`);
      return false;
    }
    state.wait = parseToggle(rest);
    console.log(`Wait mode: ${state.wait ? "on" : "off"}`);
    return false;
  }

  if (name === "memory") {
    if (!rest) {
      throw new Error("/memory requires a query");
    }
    await commandMemory("search", [rest], {});
    return false;
  }

  if (name === "proposals") {
    await commandProposals("ls", [], {});
    return false;
  }

  if (name === "jobs") {
    await commandJobs("ls", [], {});
    return false;
  }

  if (name === "run") {
    if (!rest) {
      throw new Error("/run requires a goal");
    }
    await runInteractiveTask(rest, state);
    return false;
  }

  throw new Error(`Unknown command: /${name}`);
}

export async function runInteractiveShell(options: CliOptions = {}) {
  const setupReport = await buildSetupReport();

  const state: InteractiveSessionState = {
    surface: typeof options.surface === "string" ? options.surface : undefined,
    workspace: typeof options.workspace === "string" ? options.workspace : undefined,
    wait: options.wait == null ? true : boolOption(options.wait),
    timeout: options.timeout
  };

  if (!setupReport.ok || setupReport.startedDaemon) {
    console.log(renderOnboardingNotice(setupReport));
    console.log("");
  }

  console.log(banner());
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY)
  });

  try {
    if (process.stdin.isTTY) {
      while (true) {
        const line = (await readline.question(promptLabel(state))).trim();
        if (!line) {
          continue;
        }
        try {
          if (line.startsWith("/")) {
            if (await handleSlashCommand(line, state)) {
              break;
            }
          } else {
            await runInteractiveTask(line, state);
          }
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
        }
      }
      return;
    }

    for await (const rawLine of readline) {
      const line = String(rawLine).trim();
      if (!line) {
        continue;
      }
      try {
        if (line.startsWith("/")) {
          if (await handleSlashCommand(line, state)) {
            break;
          }
        } else {
          await runInteractiveTask(line, state);
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    readline.close();
  }
}
