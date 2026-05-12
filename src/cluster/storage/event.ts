import { CoreV1Event } from "../../client";
import { Etcd } from "../etcd";
import { Store } from "./store";

export class EventStore extends Store<CoreV1Event> {
	constructor(etcd: Etcd) {
		super(etcd, {
			apiVersion: "v1",
			defaultQualifiedResource: "events",
			kind: "Event",
			singularQualifiedResource: "event",
			namespaced: true,
		});
	}

	protected async validateCreate(event: CoreV1Event): Promise<void> {
		if (!event.metadata?.name) {
			throw new Error("Event name is required");
		}

		if (!event.involvedObject) {
			throw new Error("Event involvedObject is required");
		}
	}

	protected async validateUpdate(event: CoreV1Event, _existing: CoreV1Event): Promise<void> {
		await this.validateCreate(event);
	}
}
