#!/usr/bin/env node
import process from "node:process";

import { handleDaemonCommand } from "./commands/daemon-command.js";
import {
  commandControl,
  commandDoctor,
  commandInspect,
  commandLogs,
  commandPs,
  commandRun,
  commandTeachStep,
  commandVersion
} from "./commands/task-command.js";
import { commandWatch } from "./commands/watch-command.js";
import { commandDrafts } from "./commands/drafts-command.js";
import { commandPacks } from "./commands/packs-command.js";
import { commandSkills } from "./commands/skills-command.js";
import { commandLearn } from "./commands/learn-command.js";
import { commandMemory } from "./commands/memory-command.js";
import { commandDigest } from "./commands/digest-command.js";
import { commandProposals } from "./commands/proposals-command.js";
import { boolOption, parseArgs, print, type CliOptions } from "./cli-utils.js";

function helpText() {
  return `agentos daemon start|stop|status|logs|restart|install|uninstall
agentos run "<goal>" [--surface browser|desktop] [--workspace name] [--skill name] [--input key=value] [--wait]
agentos doctor [--bundle]
agentos version
agentos ps [--limit 20]
agentos inspect <task-id>
agentos logs <task-id>
agentos control <task-id> pause|resume|takeover|request_takeover|return|return_to_agent|stop [--note "..."]
agentos teach-step <task-id> --action clickTarget [--target "..."] [--text "..."] [--surface browser|desktop]
agentos watch add "<goal>" [--pack live-pack] [--skill name] [--workspace name] [--input key=value]
agentos watch teach <task-id> "<goal>" [--watch id] [--pack live-pack] [--workspace name]
agentos watch ls|inspect|health|enable|disable|retry|rm
agentos drafts ls|inspect|approve|reject
agentos packs ls|inspect
agentos skills ls|inspect|run
agentos learn status
agentos learn sources ls
agentos memory search <query>
agentos memory inspect <entity-id>
agentos digest run
agentos proposals ls|accept|reject`;
}

async function main() {
  const [command, rawSubcommand, ...restArgs] = process.argv.slice(2);
  const subcommand = rawSubcommand?.startsWith("--") ? undefined : rawSubcommand;
  const rest = rawSubcommand?.startsWith("--") ? [rawSubcommand, ...restArgs] : restArgs;
  const { positionals, options } = parseArgs(rest);
  const sharedOptions: CliOptions = {
    ...options,
    json: boolOption(options.json)
  };

  if (!command || command === "help" || command === "--help") {
    print(helpText(), sharedOptions);
    return;
  }

  if (command === "daemon") {
    const handled = await handleDaemonCommand(subcommand, sharedOptions);
    if (!handled) {
      throw new Error(`Unsupported daemon command: ${subcommand ?? "(none)"}`);
    }
    return;
  }

  if (command === "run") {
    await commandRun([subcommand, ...positionals].filter(Boolean), sharedOptions);
    return;
  }

  if (command === "doctor") {
    await commandDoctor(sharedOptions);
    return;
  }

  if (command === "version") {
    await commandVersion(sharedOptions);
    return;
  }

  if (command === "ps") {
    await commandPs(sharedOptions);
    return;
  }

  if (command === "inspect") {
    await commandInspect(subcommand, sharedOptions);
    return;
  }

  if (command === "logs") {
    await commandLogs(subcommand, sharedOptions);
    return;
  }

  if (command === "control") {
    await commandControl([subcommand, ...positionals], sharedOptions);
    return;
  }

  if (command === "teach-step") {
    await commandTeachStep([subcommand, ...positionals], sharedOptions);
    return;
  }

  if (command === "watch") {
    await commandWatch(subcommand, positionals, sharedOptions);
    return;
  }

  if (command === "drafts") {
    await commandDrafts(subcommand, positionals, sharedOptions);
    return;
  }

  if (command === "packs") {
    await commandPacks(subcommand, positionals, sharedOptions);
    return;
  }

  if (command === "skills") {
    await commandSkills(subcommand, positionals, sharedOptions);
    return;
  }

  if (command === "learn") {
    await commandLearn(subcommand, positionals, sharedOptions);
    return;
  }

  if (command === "memory") {
    await commandMemory(subcommand, positionals, sharedOptions);
    return;
  }

  if (command === "digest") {
    await commandDigest(subcommand, sharedOptions);
    return;
  }

  if (command === "proposals") {
    await commandProposals(subcommand, positionals, sharedOptions);
    return;
  }

  throw new Error(`Unsupported command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
