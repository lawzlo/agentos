import fs from "node:fs/promises";
import path from "node:path";

import type { EventBus } from "../event-bus.js";
import type { ControlPlane } from "../control-plane.js";
import type { TaskSpec } from "../../types/runtime-schema.js";

interface FileInboxEventPayload {
  kind?: string;
  type?: string;
  source?: string;
  payload?: Record<string, unknown>;
  taskSpec?: Record<string, unknown>;
  goal?: string;
  steps?: unknown[];
}

function isTaskSpec(value: unknown): value is TaskSpec {
  return Boolean(value && typeof value === "object" && "goal" in value && typeof (value as { goal?: unknown }).goal === "string");
}

export class FileInboxConnector {
  inboxDir: string;
  controlPlane: Pick<ControlPlane, "ingestEvent" | "createTask" | "eventBus"> & { eventBus: EventBus };
  pollMs: number;
  timer: NodeJS.Timeout | null;
  inFlight: Set<string>;
  processedCount: number;
  failedCount: number;
  lastScanAt: string | null;

  constructor({
    inboxDir,
    controlPlane,
    pollMs = 750
  }: {
    inboxDir: string;
    controlPlane: FileInboxConnector["controlPlane"];
    pollMs?: number;
  }) {
    this.inboxDir = inboxDir;
    this.controlPlane = controlPlane;
    this.pollMs = pollMs;
    this.timer = null;
    this.inFlight = new Set();
    this.processedCount = 0;
    this.failedCount = 0;
    this.lastScanAt = null;
  }

  get pendingDir() {
    return this.inboxDir;
  }

  get processedDir() {
    return path.join(this.inboxDir, "processed");
  }

  get failedDir() {
    return path.join(this.inboxDir, "failed");
  }

  async start(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.pendingDir, { recursive: true }),
      fs.mkdir(this.processedDir, { recursive: true }),
      fs.mkdir(this.failedDir, { recursive: true })
    ]);

    await this.scan();
    this.timer = setInterval(() => {
      void this.scan();
    }, this.pollMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  status() {
    return {
      name: "file-inbox",
      running: Boolean(this.timer),
      inboxDir: this.inboxDir,
      pollMs: this.pollMs,
      processedCount: this.processedCount,
      failedCount: this.failedCount,
      lastScanAt: this.lastScanAt
    };
  }

  async scan(): Promise<void> {
    this.lastScanAt = new Date().toISOString();
    const entries = await fs.readdir(this.pendingDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const filePath = path.join(this.pendingDir, entry.name);
      if (this.inFlight.has(filePath)) {
        continue;
      }

      this.inFlight.add(filePath);
      void this.#processFile(filePath, entry.name).finally(() => {
        this.inFlight.delete(filePath);
      });
    }
  }

  async #processFile(filePath: string, fileName: string) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const payload = JSON.parse(raw) as FileInboxEventPayload;

      if (payload.kind === "event" || (payload.type && payload.source && Object.hasOwn(payload, "payload"))) {
        await this.controlPlane.ingestEvent(payload);
      } else if (payload.taskSpec && !payload.goal && !payload.steps) {
        if (!isTaskSpec(payload.taskSpec)) {
          throw new Error("file inbox taskSpec payload is missing a valid goal");
        }
        await this.controlPlane.createTask(payload.taskSpec);
      } else {
        if (!isTaskSpec(payload)) {
          throw new Error("file inbox task payload is missing a valid goal");
        }
        await this.controlPlane.createTask(payload);
      }

      this.processedCount += 1;
      await fs.rename(filePath, path.join(this.processedDir, `${Date.now()}-${fileName}`));
    } catch (error: unknown) {
      this.failedCount += 1;
      await fs.rename(filePath, path.join(this.failedDir, `${Date.now()}-${fileName}`)).catch(() => {});
      this.controlPlane.eventBus.broadcast("connector.error", {
        connector: "file-inbox",
        fileName,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
