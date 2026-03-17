import { apiRequest, type CliOptions, print } from "../cli-utils.js";
import type { ProposalRecord } from "../../src/types/learning.js";

export async function commandProposals(subcommand: string | undefined, positionals: string[], options: CliOptions) {
  if (subcommand === "ls") {
    const payload = await apiRequest<{ proposals: ProposalRecord[] }>(
      "GET",
      `/proposals?limit=${Number(options.limit ?? 50)}`
    );
    print(payload.proposals, options);
    return;
  }

  if (subcommand === "accept") {
    const [proposalId] = positionals;
    if (!proposalId) {
      throw new Error("proposals accept requires a proposal id");
    }
    const payload = await apiRequest<{ result: { proposal: ProposalRecord; taskId: string } }>(
      "POST",
      `/proposals/${proposalId}/accept`
    );
    print(payload.result, options);
    return;
  }

  if (subcommand === "reject") {
    const [proposalId] = positionals;
    if (!proposalId) {
      throw new Error("proposals reject requires a proposal id");
    }
    const payload = await apiRequest<{ proposal: ProposalRecord }>("POST", `/proposals/${proposalId}/reject`);
    print(payload.proposal, options);
    return;
  }

  throw new Error(`Unsupported proposals command: ${subcommand ?? "(none)"}`);
}

