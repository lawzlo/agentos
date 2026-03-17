import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ArtifactRepository } from "./repositories/artifact-repository.js";
import { DraftRepository } from "./repositories/draft-repository.js";
import { EventRepository } from "./repositories/event-repository.js";
import { MemoryRepository } from "./repositories/memory-repository.js";
import { SkillRepository } from "./repositories/skill-repository.js";
import { TaskRepository } from "./repositories/task-repository.js";
import { TraceRepository } from "./repositories/trace-repository.js";
import { VaultRepository } from "./repositories/vault-repository.js";
import { WatchRepository } from "./repositories/watch-repository.js";
import { WorkspaceRepository } from "./repositories/workspace-repository.js";
import { getStoreSchemaVersion, initializeStoreSchema } from "./store-schema.js";
import type {
  ArtifactReference,
  DraftRecord,
  EventRecord,
  SkillDefinition,
  TaskRecord,
  TaskSpec,
  TaskStatus,
  TraceEventRecord,
  TraceRecord,
  WatchRule,
  WorkspaceProfile,
  WorkspaceRecord
} from "../types/runtime-schema.js";

export class ControlPlaneStore {
  db: DatabaseSync;
  tasks: TaskRepository;
  events: EventRepository;
  traces: TraceRepository;
  workspaces: WorkspaceRepository;
  artifacts: ArtifactRepository;
  memory: MemoryRepository;
  skills: SkillRepository;
  watches: WatchRepository;
  drafts: DraftRepository;
  vault: VaultRepository;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    initializeStoreSchema(this.db);
    this.tasks = new TaskRepository(this.db);
    this.events = new EventRepository(this.db);
    this.traces = new TraceRepository(this.db);
    this.workspaces = new WorkspaceRepository(this.db);
    this.artifacts = new ArtifactRepository(this.db);
    this.memory = new MemoryRepository(this.db);
    this.skills = new SkillRepository(this.db);
    this.watches = new WatchRepository(this.db);
    this.drafts = new DraftRepository(this.db);
    this.vault = new VaultRepository(this.db);
  }

  getSchemaVersion() {
    return getStoreSchemaVersion(this.db);
  }

  createTask(taskSpec: TaskSpec): TaskRecord {
    return this.tasks.create(taskSpec) as TaskRecord;
  }

  updateTask(id: string, patch: Partial<TaskRecord>): TaskRecord | null {
    return this.tasks.update(id, patch) as TaskRecord | null;
  }

  listTasks(limit = 50): TaskRecord[] {
    return this.tasks.list(limit) as TaskRecord[];
  }

  getTask(id: string): TaskRecord | null {
    return this.tasks.get(id) as TaskRecord | null;
  }

  listTasksByStatuses(statuses: TaskStatus[] = []): TaskRecord[] {
    return this.tasks.listByStatuses(statuses) as TaskRecord[];
  }

  createEvent(event: Record<string, unknown>): EventRecord {
    return this.events.create(event);
  }

  attachEventTask(eventId: string, taskId: string): Record<string, unknown> {
    return this.events.attachTask(eventId, taskId);
  }

  listEvents(limit = 50): EventRecord[] {
    return this.events.list(limit);
  }

  createTrace(input: Record<string, unknown>): TraceRecord {
    return this.traces.create(input);
  }

  updateTrace(id: string, patch: Record<string, unknown>): TraceRecord | null {
    return this.traces.update(id, patch);
  }

  getTrace(id: string): TraceRecord | null {
    return this.traces.get(id);
  }

  appendTraceEvent(event: Record<string, unknown>): TraceEventRecord {
    return this.traces.appendEvent(event);
  }

  listTraceEvents(traceId: string): TraceEventRecord[] {
    return this.traces.listEvents(traceId);
  }

  createWorkspace(workspace: WorkspaceRecord): WorkspaceRecord {
    return this.workspaces.create(workspace);
  }

  getWorkspace(id: string): WorkspaceRecord | null {
    return this.workspaces.get(id);
  }

  getWorkspaceByTask(taskId: string): WorkspaceRecord | null {
    return this.workspaces.getByTask(taskId);
  }

  putWorkspaceProfile(profile: WorkspaceProfile): WorkspaceProfile {
    return this.workspaces.putProfile(profile);
  }

  getWorkspaceProfileByName(name: string): WorkspaceProfile | null {
    return this.workspaces.getProfileByName(name);
  }

  listWorkspaceProfiles(): WorkspaceProfile[] {
    return this.workspaces.listProfiles();
  }

  createArtifact(artifact: Record<string, unknown>): ArtifactReference {
    return this.artifacts.create(artifact);
  }

  listArtifactsForTask(taskId: string): ArtifactReference[] {
    return this.artifacts.listForTask(taskId);
  }

  putMemory(namespace: string, key: string, value: unknown) {
    return this.memory.put(namespace, key, value);
  }

  getMemory(namespace: string, key: string) {
    return this.memory.get(namespace, key);
  }

  listPolicies() {
    return this.memory.listPolicies();
  }

  putSkill(skill: SkillDefinition): SkillDefinition {
    return this.skills.put(skill);
  }

  getSkill(name: string): SkillDefinition | null {
    return this.skills.get(name);
  }

  listSkills(): SkillDefinition[] {
    return this.skills.list();
  }

  putWatchRule(watchRule: WatchRule | Record<string, unknown>): WatchRule {
    return this.watches.put(watchRule);
  }

  getWatchRule(id: string): WatchRule | null {
    return this.watches.get(id);
  }

  listWatchRules(): WatchRule[] {
    return this.watches.list();
  }

  deleteWatchRule(id: string) {
    return this.watches.delete(id);
  }

  createDraft(draft: DraftRecord | Record<string, unknown>): DraftRecord {
    return this.drafts.create(draft) as DraftRecord;
  }

  updateDraft(id: string, patch: Partial<DraftRecord>): DraftRecord | null {
    return this.drafts.update(id, patch) as DraftRecord | null;
  }

  getDraft(id: string): DraftRecord | null {
    return this.drafts.get(id) as DraftRecord | null;
  }

  listDrafts(limit = 50): DraftRecord[] {
    return this.drafts.list(limit) as DraftRecord[];
  }

  putVaultEntry(entry: Record<string, unknown>) {
    return this.vault.put(entry);
  }

  getVaultEntry(scope: string, secretKey: string) {
    return this.vault.get(scope, secretKey);
  }

  listVaultEntries(scope = "default") {
    return this.vault.list(scope);
  }

  close() {
    this.db.close();
  }
}
