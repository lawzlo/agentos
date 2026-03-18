import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import type { AgentOsConfig } from "../config.js";
import type { EventRecord, TaskSnapshot, TaskSpec, WatchDetection, WatchRule } from "../types/runtime-schema.js";
import type {
  DigestRecord,
  KnowledgeChunk,
  LearningSource,
  LearningSourceKind,
  LearningStatus,
  MemoryEntity,
  MemoryEntitySnapshot,
  ObservationRecord,
  ProposalRecord,
  ProposalStatus,
  ProposalType
} from "../types/learning.js";
import type { EventBus } from "./event-bus.js";
import type { ControlPlaneStore } from "./store.js";

const NOISY_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "target",
  ".agentos",
  ".Trash",
  "__pycache__",
  ".cache",
  "Caches",
  "tmp",
  "temp"
]);

interface LearningServiceOptions {
  store: Pick<
    ControlPlaneStore,
    | "putLearningSource"
    | "getLearningSourceByKind"
    | "listLearningSources"
    | "createObservation"
    | "getObservationByFingerprint"
    | "updateObservation"
    | "listObservations"
    | "listObservationsSince"
    | "countObservations"
    | "latestObservationAt"
    | "upsertMemoryEntity"
    | "getMemoryEntitySnapshot"
    | "listMemoryEntities"
    | "countMemoryEntities"
    | "createMemoryFact"
    | "createKnowledgeChunk"
    | "searchKnowledge"
    | "countKnowledgeChunks"
    | "putDigest"
    | "listDigests"
    | "latestDigest"
    | "putProposal"
    | "getProposal"
    | "getProposalByFingerprint"
    | "updateProposal"
    | "listProposals"
    | "countPendingProposals"
  >;
  eventBus: EventBus;
  config: AgentOsConfig;
  createTask(taskSpec: TaskSpec): Promise<{ id: string }>;
}

type WatchSignalPayload = {
  rule?: WatchRule;
  detection?: WatchDetection;
  task?: { id: string } | null;
  draft?: { id: string } | null;
  automation?: Record<string, unknown>;
};

interface FileCandidate {
  fullPath: string;
  relativePath: string;
  stats: {
    size: number;
    mtimeMs: number;
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function localDateString(date = new Date()): string {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
}

function stableHash(value: unknown): string {
  return crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex");
}

function toLowerSet(values: string[] = []): Set<string> {
  return new Set(values.map((entry) => entry.toLowerCase()));
}

function isTextLikeFile(filePath: string, allowed: Set<string>): boolean {
  const extension = path.extname(filePath).replace(/^\./, "").toLowerCase();
  return allowed.has(extension);
}

function normalizePath(value: string): string {
  return path.resolve(value);
}

function isWithin(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function shouldExcludePath(filePath: string, excludedPaths: string[]): boolean {
  const normalized = normalizePath(filePath);
  for (const excluded of excludedPaths) {
    if (isWithin(normalizePath(excluded), normalized)) {
      return true;
    }
  }

  return normalized.split(path.sep).some((segment) => NOISY_NAMES.has(segment));
}

function firstMeaningfulLine(text: string): string | null {
  const line = String(text ?? "")
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line ? line.slice(0, 200) : null;
}

function buildQuestionProposal(summary: string, contextText: string): ProposalType | null {
  const combined = `${summary}\n${contextText}`;
  if (/[?？]/u.test(combined) || /(reply|respond|response|回复|答复|回信)/iu.test(combined)) {
    return "reply";
  }
  if (/(follow up|follow-up|跟进|催办)/iu.test(combined)) {
    return "follow_up";
  }
  if (/(todo|to do|review|审阅|检查|整理|organize)/iu.test(combined)) {
    return /(organize|整理)/iu.test(combined) ? "organize" : "review";
  }
  return null;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

export class LearningService {
  store: LearningServiceOptions["store"];
  eventBus: EventBus;
  config: AgentOsConfig;
  createTask: LearningServiceOptions["createTask"];
  running: boolean;
  scanTimer: NodeJS.Timeout | null;
  digestTimer: NodeJS.Timeout | null;
  subscriptions: Array<[string, (...args: unknown[]) => void]>;
  textExtensions: Set<string>;
  scanInProgress: Promise<void> | null;
  digestInProgress: Promise<DigestRecord | null> | null;

  constructor({ store, eventBus, config, createTask }: LearningServiceOptions) {
    this.store = store;
    this.eventBus = eventBus;
    this.config = config;
    this.createTask = createTask;
    this.running = false;
    this.scanTimer = null;
    this.digestTimer = null;
    this.subscriptions = [];
    this.textExtensions = toLowerSet(config.learning.textExtensions);
    this.scanInProgress = null;
    this.digestInProgress = null;
  }

  async start(): Promise<void> {
    if (!this.config.learning.enabled || this.running) {
      return;
    }

    this.running = true;
    this.ensureSources();
    this.#subscribe();
    await this.#runScanOnce();
    await this.#runDigestOnce();
    this.scanTimer = setInterval(() => {
      void this.#runScanOnce();
    }, this.config.learning.scanIntervalMs);
    this.digestTimer = setInterval(() => {
      void this.#runDigestOnce();
    }, Math.max(this.config.learning.scanIntervalMs, 60 * 60 * 1000));
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.allSettled(
      [this.scanInProgress, this.digestInProgress].map((task) => task ?? Promise.resolve(null))
    );
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.digestTimer) {
      clearInterval(this.digestTimer);
      this.digestTimer = null;
    }
    for (const [event, handler] of this.subscriptions) {
      this.eventBus.off(event, handler);
    }
    this.subscriptions = [];
  }

  async #runScanOnce(): Promise<void> {
    if (!this.running || this.scanInProgress) {
      return;
    }

    const run = this.scanFileSystem().finally(() => {
      if (this.scanInProgress === run) {
        this.scanInProgress = null;
      }
    });
    this.scanInProgress = run;
    await run;
  }

  async #runDigestOnce(): Promise<void> {
    if (!this.running || this.digestInProgress) {
      return;
    }

    const run = this.runDigestIfDue().finally(() => {
      if (this.digestInProgress === run) {
        this.digestInProgress = null;
      }
    });
    this.digestInProgress = run;
    await run;
  }

  ensureSources(): LearningSource[] {
    const definitions: Array<Partial<LearningSource> & Pick<LearningSource, "kind">> = [
      {
        kind: "filesystem-metadata",
        enabled: true,
        status: "idle",
        config: {
          roots: this.config.learning.metadataRoots,
          excludedPaths: this.config.learning.excludedPaths,
          maxFilesPerScan: this.config.learning.maxFilesPerScan,
          maxDepth: this.config.learning.maxDepth
        }
      },
      {
        kind: "filesystem-content",
        enabled: true,
        status: "idle",
        config: {
          roots: this.config.learning.contentRoots,
          textExtensions: this.config.learning.textExtensions,
          maxContentBytes: this.config.learning.maxContentBytes
        }
      },
      {
        kind: "watch-events",
        enabled: true,
        status: "idle",
        config: {}
      },
      {
        kind: "task-results",
        enabled: true,
        status: "idle",
        config: {}
      },
      {
        kind: "user-corrections",
        enabled: true,
        status: "idle",
        config: {}
      }
    ];

    return definitions.map((definition) => this.store.putLearningSource(definition));
  }

  status(): LearningStatus {
    const sources = this.store.listLearningSources();
    return {
      running: this.running,
      sourceCount: sources.length,
      enabledSourceCount: sources.filter((source) => source.enabled).length,
      observationCount: this.store.countObservations(),
      entityCount: this.store.countMemoryEntities(),
      chunkCount: this.store.countKnowledgeChunks(),
      pendingProposalCount: this.store.countPendingProposals(),
      lastDigestAt: this.store.latestDigest()?.updatedAt ?? null,
      lastObservationAt: this.store.latestObservationAt(),
      scanIntervalMs: this.config.learning.scanIntervalMs
    };
  }

  listSources(): LearningSource[] {
    return this.store.listLearningSources();
  }

  searchMemory(query: string, limit = 20): KnowledgeChunk[] {
    return this.store.searchKnowledge(query, limit);
  }

  inspectEntity(entityId: string): MemoryEntitySnapshot | null {
    return this.store.getMemoryEntitySnapshot(entityId);
  }

  listDigests(limit = 30): DigestRecord[] {
    return this.store.listDigests(limit);
  }

  listProposals(limit = 50): ProposalRecord[] {
    return this.store.listProposals(limit);
  }

  async acceptProposal(proposalId: string): Promise<{ proposal: ProposalRecord; taskId: string }> {
    const proposal = this.store.getProposal(proposalId);
    if (!proposal) {
      throw new Error(`Proposal not found: ${proposalId}`);
    }
    const task = await this.createTask(proposal.taskSpec);
    const updated = this.store.updateProposal(proposalId, {
      status: "accepted",
      taskId: task.id,
      actedAt: nowIso()
    });
    const finalProposal = updated ?? proposal;
    this.eventBus.broadcast("proposal.updated", finalProposal);
    return { proposal: finalProposal, taskId: task.id };
  }

  rejectProposal(proposalId: string, status: ProposalStatus = "rejected"): ProposalRecord {
    const proposal = this.store.getProposal(proposalId);
    if (!proposal) {
      throw new Error(`Proposal not found: ${proposalId}`);
    }
    const updated = this.store.updateProposal(proposalId, {
      status,
      actedAt: nowIso()
    });
    const finalProposal = updated ?? proposal;
    this.eventBus.broadcast("proposal.updated", finalProposal);
    return finalProposal;
  }

  async runDigest(digestDate = localDateString()): Promise<DigestRecord> {
    const existing = this.store.listDigests(1).find((entry) => entry.digestDate === digestDate);
    if (existing) {
      return existing;
    }

    const observations = this.store.listObservationsSince(
      new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    );
    const entities = this.store.listMemoryEntities(10);
    const pendingProposals = this.store.listProposals(50).filter((entry) => entry.status === "pending").length;
    const highlights = uniqueStrings(entities.slice(0, 5).map((entity) => entity.title));
    const summary = [
      `Captured ${observations.length} observations in the last 24 hours.`,
      `Tracked ${entities.length} recent entities.`,
      `${pendingProposals} proposals are pending review.`,
      highlights.length ? `Highlights: ${highlights.join(", ")}.` : null
    ]
      .filter(Boolean)
      .join(" ");

    const digest = this.store.putDigest({
      digestDate,
      summary,
      metadata: {
        observationCount: observations.length,
        entityTitles: highlights,
        pendingProposalCount: pendingProposals
      }
    });
    this.eventBus.broadcast("digest.created", digest);
    return digest;
  }

  async runDigestIfDue(): Promise<DigestRecord> {
    return this.runDigest(localDateString());
  }

  async scanFileSystem(): Promise<void> {
    const metadataSource = this.store.putLearningSource({
      kind: "filesystem-metadata",
      status: "scanning",
      enabled: true,
      config: this.store.getLearningSourceByKind("filesystem-metadata")?.config ?? {}
    });
    const contentSource = this.store.putLearningSource({
      kind: "filesystem-content",
      status: "scanning",
      enabled: true,
      config: this.store.getLearningSourceByKind("filesystem-content")?.config ?? {}
    });

    try {
      const scanned = await this.#collectFiles();
      for (const candidate of scanned) {
        await this.#observeFileCandidate(metadataSource, contentSource, candidate);
      }
      this.store.putLearningSource({
        kind: "filesystem-metadata",
        status: "healthy",
        enabled: true,
        config: metadataSource.config,
        state: {
          scannedCount: scanned.length,
          lastScanAt: nowIso()
        },
        lastObservedAt: nowIso(),
        lastError: null
      });
      this.store.putLearningSource({
        kind: "filesystem-content",
        status: "healthy",
        enabled: true,
        config: contentSource.config,
        state: {
          scannedCount: scanned.length,
          lastScanAt: nowIso()
        },
        lastObservedAt: nowIso(),
        lastError: null
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.putLearningSource({
        kind: "filesystem-metadata",
        status: "degraded",
        enabled: true,
        config: metadataSource.config,
        state: metadataSource.state,
        lastObservedAt: metadataSource.lastObservedAt,
        lastError: message
      });
      this.store.putLearningSource({
        kind: "filesystem-content",
        status: "degraded",
        enabled: true,
        config: contentSource.config,
        state: contentSource.state,
        lastObservedAt: contentSource.lastObservedAt,
        lastError: message
      });
    }
  }

  async observeEvent(event: EventRecord): Promise<void> {
    if (!this.running) {
      return;
    }
    const source = this.store.putLearningSource({
      kind: "watch-events",
      enabled: true,
      status: "healthy",
      config: {},
      lastObservedAt: nowIso(),
      lastError: null
    });
    const text = JSON.stringify(event.payload ?? {});
    const observation = this.#createObservationIfNew({
      source,
      category: "event",
      fingerprint: `event:${event.id}`,
      summary: `${event.source}: ${event.type}`,
      metadata: {
        eventId: event.id,
        eventType: event.type,
        eventSource: event.source,
        taskId: event.taskId,
        payload: event.payload
      },
      extractedText: text
    });
    if (observation) {
      await this.#extractFromObservation(observation);
    }
  }

  async observeWatchSignal(kind: string, payload: WatchSignalPayload): Promise<void> {
    if (!this.running) {
      return;
    }
    const detection = payload.detection ?? {};
    const source = this.store.putLearningSource({
      kind: "watch-events",
      enabled: true,
      status: "healthy",
      config: {},
      lastObservedAt: nowIso(),
      lastError: null
    });
    const fingerprint =
      detection.fingerprint ??
      `${kind}:${payload.rule?.id ?? "unknown"}:${stableHash({
        summary: detection.summary ?? null,
        context: detection.context ?? [],
        inputs: detection.inputs ?? {}
      })}`;
    const observation = this.#createObservationIfNew({
      source,
      category: kind,
      fingerprint,
      summary: detection.summary ?? payload.rule?.goal ?? null,
      metadata: {
        watchRuleId: payload.rule?.id ?? null,
        livePack: payload.rule?.livePack ?? null,
        statusKind: kind,
        detection,
        taskId: payload.task?.id ?? null,
        draftId: payload.draft?.id ?? null,
        automation: payload.automation ?? null
      },
      extractedText: [detection.summary ?? "", ...(detection.context ?? [])].filter(Boolean).join("\n")
    });
    if (observation) {
      await this.#extractFromObservation(observation);
    }
  }

  async observeTaskCompletion(task: TaskSnapshot): Promise<void> {
    if (!this.running) {
      return;
    }
    const source = this.store.putLearningSource({
      kind: "task-results",
      enabled: true,
      status: "healthy",
      config: {},
      lastObservedAt: nowIso(),
      lastError: null
    });
    const resultText = JSON.stringify(task.result ?? {});
    const observation = this.#createObservationIfNew({
      source,
      category: "task-result",
      fingerprint: `task:${task.id}:completed`,
      summary: task.goal,
      metadata: {
        taskId: task.id,
        status: task.status,
        preferredSurface: task.preferredSurface,
        triggerSource: task.triggerSource,
        result: task.result ?? {}
      },
      extractedText: resultText
    });
    if (observation) {
      await this.#extractFromObservation(observation);
    }

    const manualCorrections = Array.isArray(task.result?.manualCorrections) ? task.result.manualCorrections : [];
    if (!manualCorrections.length) {
      return;
    }

    const correctionSource = this.store.putLearningSource({
      kind: "user-corrections",
      enabled: true,
      status: "healthy",
      config: {},
      lastObservedAt: nowIso(),
      lastError: null
    });
    const correctionObservation = this.#createObservationIfNew({
      source: correctionSource,
      category: "user-correction",
      fingerprint: `task:${task.id}:user-corrections`,
      summary: `Manual corrections for ${task.goal}`,
      metadata: {
        taskId: task.id,
        preferredSurface: task.preferredSurface,
        triggerSource: task.triggerSource,
        manualCorrections
      },
      extractedText: manualCorrections
        .map((entry) => String((entry as { note?: string }).note ?? "").trim())
        .filter(Boolean)
        .join("\n")
    });
    if (correctionObservation) {
      await this.#extractFromObservation(correctionObservation);
    }
  }

  #subscribe(): void {
    const subscriptions: Array<[string, (...args: unknown[]) => void]> = [
      [
        "event.created",
        (payload) => {
          void this.observeEvent(payload as EventRecord);
        }
      ],
      [
        "watch.triggered",
        (payload) => {
          void this.observeWatchSignal("watch-triggered", payload as WatchSignalPayload);
        }
      ],
      [
        "watch.drafted",
        (payload) => {
          void this.observeWatchSignal("watch-drafted", payload as WatchSignalPayload);
        }
      ],
      [
        "watch.blocked",
        (payload) => {
          void this.observeWatchSignal("watch-blocked", payload as WatchSignalPayload);
        }
      ],
      [
        "task.updated",
        (payload) => {
          const task = payload as TaskSnapshot | null;
          if (task?.status === "completed") {
            void this.observeTaskCompletion(task);
          }
        }
      ]
    ];

    for (const [event, handler] of subscriptions) {
      this.eventBus.on(event, handler);
    }
    this.subscriptions = subscriptions;
  }

  async #collectFiles(): Promise<FileCandidate[]> {
    const results: FileCandidate[] = [];
    for (const root of this.config.learning.metadataRoots) {
      const normalizedRoot = normalizePath(root);
      await this.#walkDirectory(normalizedRoot, normalizedRoot, 0, results);
      if (results.length >= this.config.learning.maxFilesPerScan) {
        break;
      }
    }
    return results;
  }

  async #walkDirectory(
    rootPath: string,
    currentPath: string,
    depth: number,
    results: FileCandidate[]
  ): Promise<void> {
    if (results.length >= this.config.learning.maxFilesPerScan || depth > this.config.learning.maxDepth) {
      return;
    }
    if (shouldExcludePath(currentPath, this.config.learning.excludedPaths)) {
      return;
    }

    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= this.config.learning.maxFilesPerScan) {
        return;
      }
      const fullPath = path.join(currentPath, entry.name);
      if (shouldExcludePath(fullPath, this.config.learning.excludedPaths)) {
        continue;
      }
      if (entry.isDirectory()) {
        await this.#walkDirectory(rootPath, fullPath, depth + 1, results);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      try {
        const stats = await fs.stat(fullPath);
        results.push({
          fullPath,
          relativePath: path.relative(rootPath, fullPath),
          stats: {
            size: stats.size,
            mtimeMs: stats.mtimeMs
          }
        });
      } catch {
      }
    }
  }

  async #observeFileCandidate(
    metadataSource: LearningSource,
    contentSource: LearningSource,
    candidate: FileCandidate
  ): Promise<void> {
    const metadataFingerprint = stableHash({
      path: candidate.fullPath,
      mtimeMs: candidate.stats.mtimeMs,
      size: candidate.stats.size
    });
    const metadataObservation = this.#createObservationIfNew({
      source: metadataSource,
      category: "file-metadata",
      fingerprint: metadataFingerprint,
      summary: path.basename(candidate.fullPath),
      metadata: {
        path: candidate.fullPath,
        relativePath: candidate.relativePath,
        size: candidate.stats.size,
        mtimeMs: candidate.stats.mtimeMs,
        extension: path.extname(candidate.fullPath).toLowerCase()
      },
      extractedText: null
    });
    if (metadataObservation) {
      await this.#extractFromObservation(metadataObservation);
    }

    const shouldParseContent =
      isTextLikeFile(candidate.fullPath, this.textExtensions) &&
      candidate.stats.size <= this.config.learning.maxContentBytes &&
      (this.config.learning.contentRoots.some((root) => isWithin(normalizePath(root), normalizePath(candidate.fullPath))) ||
        Date.now() - candidate.stats.mtimeMs <= 7 * 24 * 60 * 60 * 1000);
    if (!shouldParseContent) {
      return;
    }

    let text: string;
    try {
      text = await fs.readFile(candidate.fullPath, "utf8");
    } catch {
      return;
    }

    const contentFingerprint = stableHash({
      path: candidate.fullPath,
      kind: "content",
      mtimeMs: candidate.stats.mtimeMs,
      size: candidate.stats.size
    });
    const contentObservation = this.#createObservationIfNew({
      source: contentSource,
      category: "file-content",
      fingerprint: contentFingerprint,
      summary: firstMeaningfulLine(text) ?? path.basename(candidate.fullPath),
      metadata: {
        path: candidate.fullPath,
        extension: path.extname(candidate.fullPath).toLowerCase(),
        size: candidate.stats.size
      },
      extractedText: text.slice(0, this.config.learning.maxContentBytes)
    });
    if (contentObservation) {
      await this.#extractFromObservation(contentObservation);
    }
  }

  #createObservationIfNew({
    source,
    category,
    fingerprint,
    summary,
    metadata,
    extractedText
  }: {
    source: LearningSource;
    category: string;
    fingerprint: string;
    summary: string | null;
    metadata: Record<string, unknown>;
    extractedText: string | null;
  }): ObservationRecord | null {
    if (this.store.getObservationByFingerprint(source.id, fingerprint)) {
      return null;
    }

    const observation = this.store.createObservation({
      sourceId: source.id,
      category,
      fingerprint,
      summary,
      metadata,
      extractedText,
      artifactRefs: [],
      entityRefs: []
    });
    if (observation) {
      this.eventBus.broadcast("learning.observation", observation);
    }
    return observation;
  }

  async #extractFromObservation(observation: ObservationRecord): Promise<void> {
    const entityIds: string[] = [];
    const metadata = observation.metadata ?? {};

    if (observation.category.startsWith("file-")) {
      const filePath = String(metadata.path ?? "");
      const entity = this.store.upsertMemoryEntity({
        type: "document",
        key: filePath,
        title: path.basename(filePath) || observation.summary || "Document",
        summary: observation.summary ?? null,
        metadata: {
          path: filePath,
          extension: metadata.extension ?? null,
          size: metadata.size ?? null
        },
        lastObservedAt: observation.createdAt
      });
      entityIds.push(entity.id);
      this.store.createMemoryFact({
        entityId: entity.id,
        kind: observation.category,
        value: {
          path: filePath,
          size: metadata.size ?? null,
          mtimeMs: metadata.mtimeMs ?? null
        },
        sourceObservationId: observation.id
      });

      if (observation.extractedText) {
        this.store.createKnowledgeChunk({
          sourceId: observation.sourceId,
          observationId: observation.id,
          entityId: entity.id,
          title: entity.title,
          content: observation.extractedText,
          metadata: {
            path: filePath
          }
        });
      }

      await this.#createProposalFromObservation({
        observation,
        entity,
        contextText: observation.extractedText ?? observation.summary ?? ""
      });
    } else if (observation.category.startsWith("watch-") || observation.category === "event") {
      const livePack = String(metadata.livePack ?? metadata.eventSource ?? observation.category);
      const summary = observation.summary ?? "Conversation";
      const entity = this.store.upsertMemoryEntity({
        type: "conversation",
        key: `${livePack}:${observation.fingerprint}`,
        title: summary,
        summary,
        metadata: {
          livePack,
          watchRuleId: metadata.watchRuleId ?? null,
          eventType: metadata.eventType ?? null
        },
        lastObservedAt: observation.createdAt
      });
      entityIds.push(entity.id);
      this.store.createMemoryFact({
        entityId: entity.id,
        kind: observation.category,
        value: {
          summary,
          detection: metadata.detection ?? null
        },
        sourceObservationId: observation.id
      });

      const knowledgeText = uniqueStrings([
        observation.summary,
        observation.extractedText,
        ...(Array.isArray((metadata.detection as WatchDetection | undefined)?.context)
          ? ((metadata.detection as WatchDetection).context as string[])
          : [])
      ]).join("\n");
      if (knowledgeText) {
        this.store.createKnowledgeChunk({
          sourceId: observation.sourceId,
          observationId: observation.id,
          entityId: entity.id,
          title: entity.title,
          content: knowledgeText,
          metadata: {
            livePack
          }
        });
      }

      await this.#createProposalFromObservation({
        observation,
        entity,
        contextText: knowledgeText
      });
    } else if (observation.category === "task-result") {
      const entity = this.store.upsertMemoryEntity({
        type: "commitment",
        key: String(metadata.taskId ?? observation.fingerprint),
        title: observation.summary ?? "Task result",
        summary: firstMeaningfulLine(observation.extractedText ?? "") ?? observation.summary ?? null,
        metadata: {
          taskId: metadata.taskId ?? null,
          triggerSource: metadata.triggerSource ?? null,
          preferredSurface: metadata.preferredSurface ?? null
        },
        lastObservedAt: observation.createdAt
      });
      entityIds.push(entity.id);
      if (observation.extractedText) {
        this.store.createKnowledgeChunk({
          sourceId: observation.sourceId,
          observationId: observation.id,
          entityId: entity.id,
          title: entity.title,
          content: observation.extractedText,
          metadata: {
            taskId: metadata.taskId ?? null
          }
        });
      }
    } else if (observation.category === "user-correction") {
      const preferredSurface = String(metadata.preferredSurface ?? "desktop");
      const entity = this.store.upsertMemoryEntity({
        type: "preference",
        key: `surface:${preferredSurface}`,
        title: `Preferences for ${preferredSurface}`,
        summary: observation.summary ?? null,
        metadata: {
          preferredSurface,
          triggerSource: metadata.triggerSource ?? null
        },
        lastObservedAt: observation.createdAt
      });
      entityIds.push(entity.id);
      this.store.createMemoryFact({
        entityId: entity.id,
        kind: "manual-correction",
        value: {
          notes: Array.isArray(metadata.manualCorrections) ? metadata.manualCorrections : []
        },
        sourceObservationId: observation.id
      });
    }

    if (entityIds.length) {
      this.store.updateObservation(observation.id, {
        entityRefs: entityIds
      });
    }
  }

  async #createProposalFromObservation({
    observation,
    entity,
    contextText
  }: {
    observation: ObservationRecord;
    entity: MemoryEntity;
    contextText: string;
  }): Promise<void> {
    const proposalType = buildQuestionProposal(observation.summary ?? entity.title, contextText);
    if (!proposalType) {
      return;
    }

    const proposalFingerprint = `proposal:${proposalType}:${entity.id}:${stableHash(contextText.slice(0, 500))}`;
    const existing = this.store.getProposalByFingerprint(proposalFingerprint);
    if (existing && ["pending", "accepted", "rejected", "dismissed"].includes(existing.status)) {
      return;
    }

    const taskSpec = this.#buildSuggestedTaskSpec(proposalType, entity, observation);
    const proposal = this.store.putProposal({
      type: proposalType,
      status: "pending",
      fingerprint: proposalFingerprint,
      sourceEntityIds: [entity.id],
      rationale: `New information suggests a ${proposalType.replace("_", " ")} action for ${entity.title}.`,
      confidence: 0.72,
      taskSpec,
      metadata: {
        observationId: observation.id,
        entityTitle: entity.title,
        sourceCategory: observation.category
      }
    });
    this.eventBus.broadcast("proposal.created", proposal);
  }

  #buildSuggestedTaskSpec(
    proposalType: ProposalType,
    entity: MemoryEntity,
    observation: ObservationRecord
  ): TaskSpec {
    const pathHint = String(observation.metadata.path ?? "").trim();
    const summary = observation.summary ?? entity.title;
    if (proposalType === "review" && pathHint) {
      return {
        goal: `Review ${path.basename(pathHint)} and decide what to do next`,
        preferredSurface: "desktop",
        inputs: {
          filePath: pathHint,
          learnedFromEntityId: entity.id
        }
      };
    }

    if (proposalType === "organize" && pathHint) {
      return {
        goal: `Organize the file ${path.basename(pathHint)} into the right place`,
        preferredSurface: "desktop",
        inputs: {
          filePath: pathHint,
          learnedFromEntityId: entity.id
        }
      };
    }

    return {
      goal:
        proposalType === "reply"
          ? `Review and reply to ${summary}`
          : proposalType === "follow_up"
            ? `Follow up on ${summary}`
            : `Review ${summary}`,
      preferredSurface: "desktop",
      inputs: {
        learnedFromEntityId: entity.id,
        observationSummary: summary
      }
    };
  }
}
