import { EventEmitter } from "events";
import { Watcher as EtcdWatcher } from "../etcd";

export type EventType = "ADDED" | "MODIFIED" | "DELETED";

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

export class Watcher<T> extends EventEmitter {
	public constructor(private readonly watcher: EtcdWatcher) {
		super();

		this.watcher.on("put", (event, prev) => {
			const value = JSON.parse(event.value.toString()) as T;
			this.withResourceVersion(value, event.mod_revision);
			if (prev) {
				this.emit("event", "MODIFIED", value);
			} else {
				this.emit("event", "ADDED", value);
			}
		});

		this.watcher.on("delete", (event) => {
			const value = JSON.parse(event.value.toString()) as T;
			this.withResourceVersion(value, event.mod_revision);
			this.emit("event", "DELETED", value);
		});

		this.watcher.on("error", (error) => {
			this.emit("error", toError(error));
		});

		this.watcher.on("end", () => {
			this.emit("end");
		});
	}

	public override on(event: "event", handler: (event: EventType, value: T) => void): this;
	public override on(event: "error", handler: (error: Error) => void): this;
	public override on(event: "end", handler: () => void): this;
	public override on(
		event: string,
		handler: ((event: EventType, value: T) => void) | ((error: Error) => void) | (() => void),
	): this {
		return super.on(event, handler);
	}

	public async cancel(): Promise<void> {
		await this.watcher.cancel();
	}

	private withResourceVersion(value: T, resourceVersion: string): void {
		const object = value as { metadata?: { resourceVersion?: string } };
		object.metadata ??= {};
		object.metadata.resourceVersion = resourceVersion;
	}
}
