import type { ControlPlaneStore } from "./store.js";

export class MemoryStore {
  store: Pick<ControlPlaneStore, "putMemory" | "getMemory">;
  constructor(store: MemoryStore["store"]) {
    this.store = store;
  }

  remember(namespace: string, key: string, value: unknown) {
    return this.store.putMemory(namespace, key, value);
  }

  recall(namespace: string, key: string) {
    return this.store.getMemory(namespace, key);
  }
}
