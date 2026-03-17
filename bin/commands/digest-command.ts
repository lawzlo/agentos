import { apiRequest, type CliOptions, print } from "../cli-utils.js";
import type { DigestRecord } from "../../src/types/learning.js";

export async function commandDigest(subcommand: string | undefined, options: CliOptions) {
  if (subcommand === "run") {
    const payload = await apiRequest<{ digest: DigestRecord }>("POST", "/digests/run");
    print(payload.digest, options);
    return;
  }

  throw new Error(`Unsupported digest command: ${subcommand ?? "(none)"}`);
}

