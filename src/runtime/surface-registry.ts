export class SurfaceRegistry {
  surfaces: any;
  constructor(surfaces) {
    this.surfaces = new Map(Object.entries(surfaces));
  }

  get(name) {
    return this.surfaces.get(name);
  }

  async shutdown() {
    for (const surface of this.surfaces.values()) {
      await surface.shutdown();
    }
  }
}
