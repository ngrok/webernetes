import { Channel, type ReadOnlyChannel } from "../../../go/channel";
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

export interface FakeOptions {
	channelSize?: number;
}

// Models staging/src/k8s.io/apimachinery/pkg/watch/watch.go NewFake.
export function newFake<T extends KubernetesObject>(): FakeWatcher<T> {
	return newFakeWithOptions<T>({});
}

// Models staging/src/k8s.io/apimachinery/pkg/watch/watch.go NewFakeWithChanSize.
export function newFakeWithChanSize<T extends KubernetesObject>(
	size: number,
	// This unused arg exists upstream too, no idea why.
	_blocking: boolean,
): FakeWatcher<T> {
	return newFakeWithOptions<T>({ channelSize: size });
}

// Models staging/src/k8s.io/apimachinery/pkg/watch/watch.go NewFakeWithOptions.
export function newFakeWithOptions<T extends KubernetesObject>(
	options: FakeOptions,
): FakeWatcher<T> {
	return new FakeWatcher<T>(options.channelSize ?? 0);
}

// Models staging/src/k8s.io/apimachinery/pkg/watch/watch.go FakeWatcher.
export class FakeWatcher<T extends KubernetesObject> implements Interface<T> {
	private result: Channel<Event<T>>;
	private stopped = false;

	constructor(private readonly channelSize = 0) {
		this.result = new Channel<Event<T>>(this.channelSize);
	}

	// Models staging/src/k8s.io/apimachinery/pkg/watch/watch.go FakeWatcher.Stop.
	stop(): void {
		if (!this.stopped) {
			this.result.close();
			this.stopped = true;
		}
	}

	// Models staging/src/k8s.io/apimachinery/pkg/watch/watch.go FakeWatcher.IsStopped.
	isStopped(): boolean {
		return this.stopped;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/watch/watch.go FakeWatcher.Reset.
	reset(): void {
		this.stopped = false;
		this.result = new Channel<Event<T>>(this.channelSize);
	}

	// Models staging/src/k8s.io/apimachinery/pkg/watch/watch.go FakeWatcher.ResultChan.
	resultChan(): ReadOnlyChannel<Event<T>> {
		return this.result.readOnly();
	}

	// Models staging/src/k8s.io/apimachinery/pkg/watch/watch.go FakeWatcher.Add.
	async add(obj: T): Promise<void> {
		await this.result.send({ type: "ADDED", object: obj });
	}

	// Models staging/src/k8s.io/apimachinery/pkg/watch/watch.go FakeWatcher.Modify.
	async modify(obj: T): Promise<void> {
		await this.result.send({ type: "MODIFIED", object: obj });
	}

	// Models staging/src/k8s.io/apimachinery/pkg/watch/watch.go FakeWatcher.Delete.
	async delete(lastValue: T): Promise<void> {
		await this.result.send({ type: "DELETED", object: lastValue });
	}

	// Models staging/src/k8s.io/apimachinery/pkg/watch/watch.go FakeWatcher.Error.
	async error(errValue: T): Promise<void> {
		await this.result.send({ type: "ERROR", object: errValue });
	}

	// Models staging/src/k8s.io/apimachinery/pkg/watch/watch.go FakeWatcher.Action.
	async action(action: EventType, obj: T): Promise<void> {
		await this.result.send({ type: action, object: obj });
	}
}
