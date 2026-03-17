import fs from "node:fs/promises";
import path from "node:path";

export class FileInboxConnector {
  inboxDir: string;
  controlPlane: any;
  pollMs: number;
  timer: any;
  inFlight: any;
  processedCount: number;
  failedCount: number;
  lastScanAt: string | null;

  constructor({ inboxDir, controlPlane, pollMs = 750 }: { inboxDir: string; controlPlane: any; pollMs?: number }) {
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

  async start() {
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

  async stop() {
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

  async scan() {
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
      const payload = JSON.parse(raw);

      if (payload.kind === "event" || (payload.type && payload.source && Object.hasOwn(payload, "payload"))) {
        await this.controlPlane.ingestEvent(payload);
      } else if (payload.taskSpec && !payload.goal && !payload.steps) {
        await this.controlPlane.createTask(payload.taskSpec);
      } else {
        await this.controlPlane.createTask(payload);
      }

      this.processedCount += 1;
      await fs.rename(filePath, path.join(this.processedDir, `${Date.now()}-${fileName}`));
    } catch (error: any) {
      this.failedCount += 1;
      await fs.rename(filePath, path.join(this.failedDir, `${Date.now()}-${fileName}`)).catch(() => {});
      this.controlPlane.eventBus.broadcast("connector.error", {
        connector: "file-inbox",
        fileName,
        error: error?.message ?? String(error)
      });
    }
  }
}
