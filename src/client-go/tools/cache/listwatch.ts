import type { ListOptions } from "../../../apimachinery/pkg/apis/meta/v1/types";
import type { Selector } from "../../../apimachinery/pkg/fields/selector";
import type { Interface } from "../../../apimachinery/pkg/watch/watch";
import * as context from "../../../go/context";
import type { KubernetesObject, KubeList } from "../../../client/types";
import {
	doesClientNotSupportWatchListSemantics,
	type UnsupportedWatchListSemantics,
} from "../../util/watchlist/watch_list";

export type ListResult<T extends KubernetesObject> = [
	object: KubeList<T> | undefined,
	err: Error | undefined,
];

export type WatchResult<T extends KubernetesObject> = [
	watch: Interface<T> | undefined,
	err: Error | undefined,
];

// Simulator-specific adapter for NewListWatchFromClient. Upstream receives a REST
// Getter here, but this simulator has not copied the apiserver HTTP request
// surface; the Node.js Kubernetes SDK-shaped client is our fake apiserver boundary.
export interface ListWatchClient<T extends KubernetesObject> {
	list(
		resource: string,
		namespace: string,
		options: ListOptions,
	): Promise<ListResult<T>> | ListResult<T>;
	watch(
		resource: string,
		namespace: string,
		options: ListOptions,
	): Promise<WatchResult<T>> | WatchResult<T>;
}

// Models staging/src/k8s.io/client-go/tools/cache/listwatch.go ListFunc.
export type ListFunc<T extends KubernetesObject> = (
	options: ListOptions,
) => Promise<ListResult<T>> | ListResult<T>;

// Models staging/src/k8s.io/client-go/tools/cache/listwatch.go ListWithContextFunc.
export type ListWithContextFunc<T extends KubernetesObject> = (
	ctx: context.Context,
	options: ListOptions,
) => Promise<ListResult<T>> | ListResult<T>;

// Models staging/src/k8s.io/client-go/tools/cache/listwatch.go WatchFunc.
export type WatchFunc<T extends KubernetesObject> = (
	options: ListOptions,
) => Promise<WatchResult<T>> | WatchResult<T>;

// Models staging/src/k8s.io/client-go/tools/cache/listwatch.go WatchFuncWithContext.
export type WatchFuncWithContext<T extends KubernetesObject> = (
	ctx: context.Context,
	options: ListOptions,
) => Promise<WatchResult<T>> | WatchResult<T>;

export interface ListWatchOptions<T extends KubernetesObject> {
	listFunc?: ListFunc<T>;
	watchFunc?: WatchFunc<T>;
	listWithContextFunc?: ListWithContextFunc<T>;
	watchFuncWithContext?: WatchFuncWithContext<T>;
	disableChunking?: boolean;
}

// Models staging/src/k8s.io/client-go/tools/cache/listwatch.go ListerWatcher.
export interface ListerWatcher<T extends KubernetesObject> {
	list(options: ListOptions): Promise<ListResult<T>>;
	watch(options: ListOptions): Promise<WatchResult<T>>;
}

// Models staging/src/k8s.io/client-go/tools/cache/listwatch.go ListerWatcherWithContext.
export interface ListerWatcherWithContext<T extends KubernetesObject> extends ListerWatcher<T> {
	listWithContext(ctx: context.Context, options: ListOptions): Promise<ListResult<T>>;
	watchWithContext(ctx: context.Context, options: ListOptions): Promise<WatchResult<T>>;
}

// Models staging/src/k8s.io/client-go/tools/cache/listwatch.go NewListWatchFromClient.
export function newListWatchFromClient<T extends KubernetesObject>(
	client: ListWatchClient<T>,
	resource: string,
	namespace: string,
	fieldSelector: Selector,
): ListWatch<T> {
	const optionsModifier = (options: ListOptions) => {
		options.fieldSelector = fieldSelector.string();
	};
	return newFilteredListWatchFromClient(client, resource, namespace, optionsModifier);
}

// Models staging/src/k8s.io/client-go/tools/cache/listwatch.go NewFilteredListWatchFromClient.
export function newFilteredListWatchFromClient<T extends KubernetesObject>(
	client: ListWatchClient<T>,
	resource: string,
	namespace: string,
	optionsModifier: (options: ListOptions) => void,
): ListWatch<T> {
	const listFunc: ListFunc<T> = (options) => {
		const modifiedOptions = { ...options };
		optionsModifier(modifiedOptions);
		return client.list(resource, namespace, modifiedOptions);
	};
	const watchFunc: WatchFunc<T> = (options) => {
		const modifiedOptions = { ...options, watch: true };
		optionsModifier(modifiedOptions);
		return client.watch(resource, namespace, modifiedOptions);
	};
	const listFuncWithContext: ListWithContextFunc<T> = (_ctx, options) => {
		const modifiedOptions = { ...options };
		optionsModifier(modifiedOptions);
		return client.list(resource, namespace, modifiedOptions);
	};
	const watchFuncWithContext: WatchFuncWithContext<T> = (_ctx, options) => {
		const modifiedOptions = { ...options, watch: true };
		optionsModifier(modifiedOptions);
		return client.watch(resource, namespace, modifiedOptions);
	};
	return new ListWatch({
		listFunc,
		watchFunc,
		listWithContextFunc: listFuncWithContext,
		watchFuncWithContext,
	});
}

// Models staging/src/k8s.io/client-go/tools/cache/listwatch.go ListWatch.
export class ListWatch<
	T extends KubernetesObject = KubernetesObject,
> implements ListerWatcherWithContext<T> {
	listFunc: ListFunc<T> | undefined;
	watchFunc: WatchFunc<T> | undefined;
	listWithContextFunc: ListWithContextFunc<T> | undefined;
	watchFuncWithContext: WatchFuncWithContext<T> | undefined;
	disableChunking: boolean;

	constructor(options: ListWatchOptions<T> = {}) {
		this.listFunc = options.listFunc;
		this.watchFunc = options.watchFunc;
		this.listWithContextFunc = options.listWithContextFunc;
		this.watchFuncWithContext = options.watchFuncWithContext;
		this.disableChunking = options.disableChunking ?? false;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/listwatch.go ListWatch.List.
	async list(options: ListOptions): Promise<ListResult<T>> {
		if (this.listFunc) {
			return this.listFunc(options);
		}
		if (this.listWithContextFunc) {
			return this.listWithContextFunc(context.background(), options);
		}
		return [undefined, new Error("ListWatch list function is not set")];
	}

	// Models staging/src/k8s.io/client-go/tools/cache/listwatch.go ListWatch.ListWithContext.
	async listWithContext(ctx: context.Context, options: ListOptions): Promise<ListResult<T>> {
		if (this.listWithContextFunc) {
			return this.listWithContextFunc(ctx, options);
		}
		if (this.listFunc) {
			return this.listFunc(options);
		}
		return [undefined, new Error("ListWatch list function is not set")];
	}

	// Models staging/src/k8s.io/client-go/tools/cache/listwatch.go ListWatch.Watch.
	async watch(options: ListOptions): Promise<WatchResult<T>> {
		if (this.watchFunc) {
			return this.watchFunc(options);
		}
		if (this.watchFuncWithContext) {
			return this.watchFuncWithContext(context.background(), options);
		}
		return [undefined, new Error("ListWatch watch function is not set")];
	}

	// Models staging/src/k8s.io/client-go/tools/cache/listwatch.go ListWatch.WatchWithContext.
	async watchWithContext(ctx: context.Context, options: ListOptions): Promise<WatchResult<T>> {
		if (this.watchFuncWithContext) {
			return this.watchFuncWithContext(ctx, options);
		}
		if (this.watchFunc) {
			return this.watchFunc(options);
		}
		return [undefined, new Error("ListWatch watch function is not set")];
	}
}

// Models staging/src/k8s.io/client-go/tools/cache/listwatch.go listWatcherWithWatchListSemanticsWrapper.
class ListWatcherWithWatchListSemanticsWrapper<T extends KubernetesObject>
	implements ListerWatcherWithContext<T>, UnsupportedWatchListSemantics
{
	constructor(
		private readonly listWatch: ListWatch<T>,
		private readonly unsupportedWatchListSemantics: boolean,
	) {}

	isWatchListSemanticsUnsupported(): boolean {
		return this.unsupportedWatchListSemantics;
	}

	list(options: ListOptions): Promise<ListResult<T>> {
		return this.listWatch.list(options);
	}

	watch(options: ListOptions): Promise<WatchResult<T>> {
		return this.listWatch.watch(options);
	}

	listWithContext(ctx: context.Context, options: ListOptions): Promise<ListResult<T>> {
		return this.listWatch.listWithContext(ctx, options);
	}

	watchWithContext(ctx: context.Context, options: ListOptions): Promise<WatchResult<T>> {
		return this.listWatch.watchWithContext(ctx, options);
	}
}

// Models staging/src/k8s.io/client-go/tools/cache/listwatch.go ToListWatcherWithWatchListSemantics.
export function toListWatcherWithWatchListSemantics<T extends KubernetesObject>(
	listWatch: ListWatch<T>,
	client: unknown,
): ListerWatcherWithContext<T> {
	return new ListWatcherWithWatchListSemanticsWrapper(
		listWatch,
		doesClientNotSupportWatchListSemantics(client),
	);
}

// Models staging/src/k8s.io/client-go/tools/cache/listwatch.go ToListerWatcherWithContext.
export function toListerWatcherWithContext<T extends KubernetesObject>(
	lw: ListerWatcher<T>,
): ListerWatcherWithContext<T> {
	if ("listWithContext" in lw && "watchWithContext" in lw) {
		return lw as ListerWatcherWithContext<T>;
	}
	return {
		list: (options) => lw.list(options),
		watch: (options) => lw.watch(options),
		listWithContext: (_ctx, options) => lw.list(options),
		watchWithContext: (_ctx, options) => lw.watch(options),
	};
}
