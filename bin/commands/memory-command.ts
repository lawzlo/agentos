import { apiRequest, type CliOptions, print } from "../cli-utils.js";
import type { KnowledgeChunk, MemoryEntitySnapshot } from "../../src/types/learning.js";

export async function commandMemory(subcommand: string | undefined, positionals: string[], options: CliOptions) {
  if (subcommand === "search") {
    const query = positionals.join(" ").trim();
    if (!query) {
      throw new Error("memory search requires a query");
    }
    const payload = await apiRequest<{ chunks: KnowledgeChunk[] }>(
      "GET",
      `/memory/search?q=${encodeURIComponent(query)}&limit=${Number(options.limit ?? 20)}`
    );
    print(payload.chunks, options);
    return;
  }

  if (subcommand === "inspect") {
    const [entityId] = positionals;
    if (!entityId) {
      throw new Error("memory inspect requires an entity id");
    }
    const payload = await apiRequest<{ entity: MemoryEntitySnapshot }>("GET", `/memory/entities/${entityId}`);
    print(payload.entity, options);
    return;
  }

  throw new Error(`Unsupported memory command: ${subcommand ?? "(none)"}`);
}

