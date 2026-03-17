import { apiRequest, type CliOptions, print } from "../cli-utils.js";
import type { LearningSource, LearningStatus } from "../../src/types/learning.js";

export async function commandLearn(subcommand: string | undefined, positionals: string[], options: CliOptions) {
  if (subcommand === "status") {
    const payload = await apiRequest<{ learning: LearningStatus }>("GET", "/learning/status");
    print(payload.learning, options);
    return;
  }

  if (subcommand === "sources" && positionals[0] === "ls") {
    const payload = await apiRequest<{ sources: LearningSource[] }>("GET", "/learning/sources");
    print(payload.sources, options);
    return;
  }

  throw new Error(`Unsupported learn command: ${subcommand ?? "(none)"}`);
}

