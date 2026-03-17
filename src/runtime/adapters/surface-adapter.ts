import type {
  ArtifactReference,
  RuntimeStep,
  StepVerification,
  TaskRecord,
  WorkspaceRecord,
  WorldState
} from "../../types/runtime-schema.js";

interface SurfaceContext {
  task: TaskRecord;
  workspace: WorkspaceRecord;
  traceId: string | null;
  step?: RuntimeStep;
  label?: string;
  outputs?: Record<string, unknown>;
  expectation?: Record<string, unknown>;
  recentActions?: unknown[];
}

export class SurfaceAdapter {
  name: string;
  constructor(name: string) {
    this.name = name;
  }

  async discover(_args?: SurfaceContext): Promise<Record<string, unknown>> {
    throw new Error(`${this.name} discover() is not implemented`);
  }

  async capture(_args?: SurfaceContext): Promise<ArtifactReference | Record<string, unknown>> {
    throw new Error(`${this.name} capture() is not implemented`);
  }

  async focus(_args?: SurfaceContext): Promise<Record<string, unknown>> {
    throw new Error(`${this.name} focus() is not implemented`);
  }

  async act(_args?: SurfaceContext): Promise<unknown> {
    throw new Error(`${this.name} act() is not implemented`);
  }

  async verify(_args?: SurfaceContext): Promise<StepVerification> {
    return { ok: true, details: { skipped: true } };
  }

  async observe(args?: SurfaceContext): Promise<WorldState | Record<string, unknown>> {
    return {
      surface: this.name,
      discovery: await this.discover(args),
      capture: await this.capture(args)
    };
  }

  async checkpoint(args?: SurfaceContext): Promise<Record<string, unknown>> {
    const capture = await this.capture(args);
    return {
      surface: this.name,
      capture,
      discovered: await this.discover(args)
    };
  }

  async shutdown(): Promise<void> {}
}
