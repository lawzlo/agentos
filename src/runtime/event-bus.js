import { EventEmitter } from "node:events";
export class EventBus extends EventEmitter {
    broadcast(type, payload) {
        this.emit(type, payload);
        this.emit("broadcast", { type, payload });
    }
}
