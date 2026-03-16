export class SurfaceAdapter {
  constructor(name) {
    this.name = name;
  }

  async discover() {
    throw new Error(`${this.name} discover() is not implemented`);
  }

  async capture() {
    throw new Error(`${this.name} capture() is not implemented`);
  }

  async focus() {
    throw new Error(`${this.name} focus() is not implemented`);
  }

  async act() {
    throw new Error(`${this.name} act() is not implemented`);
  }

  async verify() {
    return { ok: true, details: { skipped: true } };
  }

  async observe(args) {
    return {
      surface: this.name,
      discovery: await this.discover(args),
      capture: await this.capture(args)
    };
  }

  async checkpoint(args) {
    const capture = await this.capture(args);
    return {
      surface: this.name,
      capture,
      discovered: await this.discover(args)
    };
  }

  async shutdown() {}
}
