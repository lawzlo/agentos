import { EventEmitter } from "node:events";

export class EventBus extends EventEmitter {
  broadcast(type: string, payload: unknown): void {
    this.emit(type, payload);
    this.emit("broadcast", { type, payload });
  }
}
