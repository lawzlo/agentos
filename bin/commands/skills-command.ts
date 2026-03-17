import {
  apiRequest,
  boolOption,
  type CliOptions,
  parseInputs,
  print,
  waitForTask
} from "../cli-utils.js";
import type { SkillDefinition, TaskSnapshot } from "../../src/types/runtime-schema.js";

export async function commandSkills(subcommand: string | undefined, positionals: string[], options: CliOptions) {
  if (subcommand === "ls") {
    const payload = await apiRequest<{ skills: SkillDefinition[] }>("GET", "/skills");
    if (options.json) {
      print(payload.skills, options);
      return;
    }
    console.log(payload.skills.map((skill) => `${skill.name}  ${skill.surfaceScope}`).join("\n") || "No skills found.");
    return;
  }

  if (subcommand === "inspect") {
    const [name] = positionals;
    const payload = await apiRequest<{ skill: SkillDefinition }>(
      "GET",
      `/skills/${encodeURIComponent(name)}`
    );
    print(payload.skill, options);
    return;
  }

  if (subcommand === "run") {
    const [name, ...goalParts] = positionals;
    const response = await apiRequest<{ task: TaskSnapshot }>("POST", "/tasks", {
      goal: goalParts.join(" ").trim() || `Run ${name}`,
      skillName: name,
      preferredSurface: options.surface,
      workspaceName: options.workspace,
      inputs: parseInputs(options.input)
    });
    if (boolOption(options.wait)) {
      const task = await waitForTask(response.task.id, Number(options.timeout ?? 30000));
      print(task, options);
      return;
    }
    print(response.task, options);
    return;
  }

  throw new Error(`Unsupported skills command: ${subcommand}`);
}
