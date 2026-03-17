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
import { initializeStoreSchema } from "./store-schema.js";

export class ControlPlaneStore {
  db: any;
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

  createTask(taskSpec: Record<string, any>) {
    return this.tasks.create(taskSpec);
  }

  updateTask(id: string, patch: Record<string, any>) {
    return this.tasks.update(id, patch);
  }

  listTasks(limit = 50) {
    return this.tasks.list(limit);
  }

  getTask(id: string) {
    return this.tasks.get(id);
  }

  listTasksByStatuses(statuses: string[] = []) {
    return this.tasks.listByStatuses(statuses);
  }

  createEvent(event: Record<string, any>) {
    return this.events.create(event);
  }

  attachEventTask(eventId: string, taskId: string) {
    return this.events.attachTask(eventId, taskId);
  }

  listEvents(limit = 50) {
    return this.events.list(limit);
  }

  createTrace(input: Record<string, any>) {
    return this.traces.create(input);
  }

  updateTrace(id: string, patch: Record<string, any>) {
    return this.traces.update(id, patch);
  }

  getTrace(id: string) {
    return this.traces.get(id);
  }

  appendTraceEvent(event: Record<string, any>) {
    return this.traces.appendEvent(event);
  }

  listTraceEvents(traceId: string) {
    return this.traces.listEvents(traceId);
  }

  createWorkspace(workspace: Record<string, any>) {
    return this.workspaces.create(workspace);
  }

  getWorkspace(id: string) {
    return this.workspaces.get(id);
  }

  getWorkspaceByTask(taskId: string) {
    return this.workspaces.getByTask(taskId);
  }

  putWorkspaceProfile(profile: Record<string, any>) {
    return this.workspaces.putProfile(profile);
  }

  getWorkspaceProfileByName(name: string) {
    return this.workspaces.getProfileByName(name);
  }

  listWorkspaceProfiles() {
    return this.workspaces.listProfiles();
  }

  createArtifact(artifact: Record<string, any>) {
    return this.artifacts.create(artifact);
  }

  listArtifactsForTask(taskId: string) {
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

  putSkill(skill: Record<string, any>) {
    return this.skills.put(skill);
  }

  getSkill(name: string) {
    return this.skills.get(name);
  }

  listSkills() {
    return this.skills.list();
  }

  putWatchRule(watchRule: Record<string, any>) {
    return this.watches.put(watchRule);
  }

  getWatchRule(id: string) {
    return this.watches.get(id);
  }

  listWatchRules() {
    return this.watches.list();
  }

  deleteWatchRule(id: string) {
    return this.watches.delete(id);
  }

  createDraft(draft: Record<string, any>) {
    return this.drafts.create(draft);
  }

  updateDraft(id: string, patch: Record<string, any>) {
    return this.drafts.update(id, patch);
  }

  getDraft(id: string) {
    return this.drafts.get(id);
  }

  listDrafts(limit = 50) {
    return this.drafts.list(limit);
  }

  putVaultEntry(entry: Record<string, any>) {
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
