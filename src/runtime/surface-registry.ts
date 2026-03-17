import type { SurfaceAdapter } from "./adapters/surface-adapter.js";

export type SurfaceName = "browser" | "desktop";

export class SurfaceRegistry {
  surfaces: Map<string, SurfaceAdapter>;

  constructor(surfaces: Record<string, SurfaceAdapter>) {
    this.surfaces = new Map(Object.entries(surfaces));
  }

  get<TSurface extends SurfaceAdapter = SurfaceAdapter>(name: string): TSurface | undefined {
    return this.surfaces.get(name) as TSurface | undefined;
  }

  async shutdown(): Promise<void> {
    for (const surface of this.surfaces.values()) {
      await surface.shutdown();
    }
  }
}
