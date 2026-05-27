import type { ReadOnlyChannel } from "../../../go/channel";
import type { KubernetesObject } from "../../../client/types";

// Models staging/src/k8s.io/apimachinery/pkg/watch/watch.go EventType.
export type EventType = "ADDED" | "MODIFIED" | "DELETED" | "BOOKMARK" | "ERROR";

// Models staging/src/k8s.io/apimachinery/pkg/watch/watch.go Event.
export interface Event<T extends KubernetesObject> {
	type: EventType;
	object: T;
}

// Models staging/src/k8s.io/apimachinery/pkg/watch/watch.go Interface.
export interface Interface<T extends KubernetesObject> {
	stop(): void;
	resultChan(): ReadOnlyChannel<Event<T>>;
}
