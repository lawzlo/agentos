import crypto from "node:crypto";
export function createId(prefix) {
    return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
export function nowIso() {
    return new Date().toISOString();
}
