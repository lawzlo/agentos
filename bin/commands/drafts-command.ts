import { apiRequest, type CliOptions, formatDraft, print } from "../cli-utils.js";
import type { DraftRecord } from "../../src/types/runtime-schema.js";

export async function commandDrafts(subcommand: string | undefined, positionals: string[], options: CliOptions) {
  if (subcommand === "ls") {
    const payload = await apiRequest<{ drafts: DraftRecord[] }>(
      "GET",
      `/drafts?limit=${Number(options.limit ?? 20)}`
    );
    if (options.json) {
      print(payload.drafts, options);
      return;
    }
    console.log(payload.drafts.map(formatDraft).join("\n") || "No drafts found.");
    return;
  }

  if (subcommand === "inspect") {
    const [draftId] = positionals;
    const payload = await apiRequest<{ draft: DraftRecord }>("GET", `/drafts/${draftId}`);
    print(payload.draft, options);
    return;
  }

  if (subcommand === "approve") {
    const [draftId] = positionals;
    const payload = await apiRequest<{ draft: DraftRecord }>("POST", `/drafts/${draftId}/approve`);
    print(payload.draft, options);
    return;
  }

  if (subcommand === "reject") {
    const [draftId] = positionals;
    const payload = await apiRequest<{ draft: DraftRecord }>("POST", `/drafts/${draftId}/reject`, {
      reason: options.reason ?? null
    });
    print(payload.draft, options);
    return;
  }

  throw new Error(`Unsupported drafts command: ${subcommand}`);
}
