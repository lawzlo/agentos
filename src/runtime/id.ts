import crypto from "node:crypto";

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
