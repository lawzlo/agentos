import { apiRequest, formatPack, print } from "../cli-utils.js";

export async function commandPacks(subcommand: string | undefined, positionals: string[], options: Record<string, any>) {
  if (subcommand === "ls") {
    const payload = await apiRequest("GET", "/packs");
    if (options.json) {
      print(payload.packs, options);
      return;
    }
    console.log(payload.packs.map(formatPack).join("\n") || "No packs found.");
    return;
  }

  if (subcommand === "inspect") {
    const [name] = positionals;
    const payload = await apiRequest("GET", "/packs");
    const found = payload.packs.find((pack: Record<string, any>) => pack.name === name);
    if (!found) {
      throw new Error(`Pack not found: ${name}`);
    }
    print(found, options);
    return;
  }

  throw new Error(`Unsupported packs command: ${subcommand}`);
}
