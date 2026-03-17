export class SurfaceAdapter {
    name;
    constructor(name) {
        this.name = name;
    }
    async discover(_args) {
        throw new Error(`${this.name} discover() is not implemented`);
    }
    async capture(_args) {
        throw new Error(`${this.name} capture() is not implemented`);
    }
    async focus(_args) {
        throw new Error(`${this.name} focus() is not implemented`);
    }
    async act(_args) {
        throw new Error(`${this.name} act() is not implemented`);
    }
    async verify(_args) {
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
    async shutdown() { }
}
