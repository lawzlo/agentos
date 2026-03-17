export class SurfaceAdapter {
  name: string;
  constructor(name: string) {
    this.name = name;
  }

  async discover(_args?: any): Promise<any> {
    throw new Error(`${this.name} discover() is not implemented`);
  }

  async capture(_args?: any): Promise<any> {
    throw new Error(`${this.name} capture() is not implemented`);
  }

  async focus(_args?: any): Promise<any> {
    throw new Error(`${this.name} focus() is not implemented`);
  }

  async act(_args?: any): Promise<any> {
    throw new Error(`${this.name} act() is not implemented`);
  }

  async verify(_args?: any): Promise<{ ok: boolean; details: Record<string, unknown> }> {
    return { ok: true, details: { skipped: true } };
  }

  async observe(args?: any): Promise<any> {
    return {
      surface: this.name,
      discovery: await this.discover(args),
      capture: await this.capture(args)
    };
  }

  async checkpoint(args?: any): Promise<any> {
    const capture = await this.capture(args);
    return {
      surface: this.name,
      capture,
      discovered: await this.discover(args)
    };
  }

  async shutdown(): Promise<void> {}
}
