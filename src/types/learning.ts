import type { TaskSpec } from "./runtime-schema.js";

export type LearningSourceKind =
  | "filesystem-metadata"
  | "filesystem-content"
  | "watch-events"
  | "task-results"
  | "user-corrections";

export type ProposalType = "reply" | "follow_up" | "review" | "organize" | "update_watch";
export type ProposalStatus = "pending" | "accepted" | "rejected" | "dismissed";
export type MemoryEntityType =
  | "contact"
  | "conversation"
  | "document"
  | "project"
  | "commitment"
  | "preference";

export interface LearningSource {
  id: string;
  kind: LearningSourceKind;
  enabled: boolean;
  status: "idle" | "scanning" | "healthy" | "degraded";
  config: Record<string, unknown>;
  state: Record<string, unknown>;
  lastObservedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ObservationRecord {
  id: string;
  sourceId: string;
  category: string;
  fingerprint: string;
  summary: string | null;
  metadata: Record<string, unknown>;
  extractedText: string | null;
  artifactRefs: string[];
  entityRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MemoryFact {
  id: string;
  entityId: string;
  kind: string;
  value: Record<string, unknown>;
  sourceObservationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryEntity {
  id: string;
  type: MemoryEntityType;
  key: string;
  title: string;
  summary: string | null;
  metadata: Record<string, unknown>;
  lastObservedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryEntitySnapshot extends MemoryEntity {
  facts: MemoryFact[];
}

export interface KnowledgeChunk {
  id: string;
  sourceId: string;
  observationId: string | null;
  entityId: string | null;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface DigestRecord {
  id: string;
  digestDate: string;
  status: "completed";
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProposalRecord {
  id: string;
  type: ProposalType;
  status: ProposalStatus;
  fingerprint: string;
  sourceEntityIds: string[];
  rationale: string;
  confidence: number;
  taskSpec: TaskSpec;
  metadata: Record<string, unknown>;
  taskId: string | null;
  actedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LearningStatus {
  running: boolean;
  sourceCount: number;
  enabledSourceCount: number;
  observationCount: number;
  entityCount: number;
  chunkCount: number;
  pendingProposalCount: number;
  lastDigestAt: string | null;
  lastObservationAt: string | null;
  scanIntervalMs: number;
}

