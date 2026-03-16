export class MemoryStore {
  constructor(store) {
    this.store = store;
  }

  remember(namespace, key, value) {
    return this.store.putMemory(namespace, key, value);
  }

  recall(namespace, key) {
    return this.store.getMemory(namespace, key);
  }
}
