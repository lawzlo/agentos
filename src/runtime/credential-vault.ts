import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ControlPlaneStore } from "./store.js";

interface VaultSecretRecord {
  scope: string;
  secretKey: string;
  ciphertext?: string;
  iv?: string;
  tag?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface CredentialVaultOptions {
  store: Pick<ControlPlaneStore, "putVaultEntry" | "getVaultEntry" | "listVaultEntries">;
  masterKeyPath: string;
  envKey?: string;
}

export class CredentialVault {
  store: CredentialVaultOptions["store"];
  masterKeyPath: string;
  envKey?: string;
  masterKeyPromise: Promise<Buffer> | null;
  constructor({ store, masterKeyPath, envKey }: CredentialVaultOptions) {
    this.store = store;
    this.masterKeyPath = masterKeyPath;
    this.envKey = envKey;
    this.masterKeyPromise = null;
  }

  async #loadMasterKey() {
    if (this.masterKeyPromise) {
      return this.masterKeyPromise;
    }

    this.masterKeyPromise = (async () => {
      if (this.envKey) {
        return this.#deriveEnvKey(this.envKey);
      }

      try {
        const data = await fs.readFile(this.masterKeyPath, "utf8");
        return Buffer.from(data.trim(), "base64");
      } catch {
        const key = crypto.randomBytes(32);
        await fs.mkdir(path.dirname(this.masterKeyPath), { recursive: true });
        await fs.writeFile(this.masterKeyPath, key.toString("base64"), { mode: 0o600 });
        return key;
      }
    })();

    return this.masterKeyPromise;
  }

  #deriveEnvKey(secret: string): Buffer {
    const looksBase64 = /^[A-Za-z0-9+/=]+$/.test(secret) && secret.length >= 43;
    if (looksBase64) {
      const decoded = Buffer.from(secret, "base64");
      if (decoded.length === 32) {
        return decoded;
      }
    }

    return crypto.createHash("sha256").update(secret).digest();
  }

  async putSecret(
    scope: string,
    secretKey: string,
    value: string,
    metadata: Record<string, unknown> = {}
  ) {
    const masterKey = await this.#loadMasterKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    const stored = this.store.putVaultEntry({
      scope,
      secretKey,
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      metadata
    });

    return {
      scope: stored.scope,
      secretKey: stored.secretKey,
      metadata: stored.metadata,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt
    };
  }

  async getSecret(scope: string, secretKey: string) {
    const entry = this.store.getVaultEntry(scope, secretKey) as VaultSecretRecord | null;
    if (!entry) {
      return null;
    }

    const masterKey = await this.#loadMasterKey();
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      masterKey,
      Buffer.from(entry.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(entry.ciphertext, "base64")),
      decipher.final()
    ]).toString("utf8");

    return {
      scope: entry.scope,
      secretKey: entry.secretKey,
      value: decrypted,
      metadata: entry.metadata,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt
    };
  }

  listSecrets(scope = "default") {
    return this.store.listVaultEntries(scope);
  }
}
