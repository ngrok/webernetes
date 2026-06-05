import type { ListOptions } from "../../../apimachinery/pkg/apis/meta/v1/types";
import {
	fromAPIVersionAndKind,
	GroupVersionKind,
} from "../../../apimachinery/pkg/runtime/schema/group_version";
import { Backoff } from "../../../apimachinery/pkg/util/wait/backoff";
import type { DelayFunc } from "../../../apimachinery/pkg/util/wait/delay";
import type { Interface } from "../../../apimachinery/pkg/watch/watch";
import { Clock } from "../../../clock";
import type { KubernetesObject } from "../../../client/types";
import { Channel, type ReadOnlyChannel, select } from "../../../go/channel";
import * as context from "../../../go/context";
import * as time from "../../../go/time";
import type { MaybePromise } from "../../../promise";
import {
	type ListerWatcher,
	type ListerWatcherWithContext,
	toListerWatcherWithContext,
} from "./listwatch";

const defaultExpectedTypeName = "<unspecified>";
const defaultBackoffInitMs = 800;
const defaultBackoffMaxMs = 30 * 1000;
const defaultBackoffResetMs = 2 * 60 * 1000;
const defaultBackoffFactor = 2;
const defaultBackoffJitter = 1;
const defaultWatchListPageSize = 500;

// Models staging/src/k8s.io/client-go/tools/cache/reflector.go ReflectorStore.
export interface ReflectorStore<T extends KubernetesObject> {
	add(obj: T): MaybePromise<Error | undefined>;
	update(obj: T): MaybePromise<Error | undefined>;
	delete(obj: T): MaybePromise<Error | undefined>;
	replace(list: T[], resourceVersion: string): MaybePromise<Error | undefined>;
	resync(): MaybePromise<Error | undefined>;
}

// Models staging/src/k8s.io/client-go/tools/cache/reflector.go ReflectorBookmarkStore.
export interface ReflectorBookmarkStore {
	bookmark(resourceVersion: string): MaybePromise<Error | undefined>;
}

// Models staging/src/k8s.io/client-go/tools/cache/reflector.go ResourceVersionUpdater.
export interface ResourceVersionUpdater {
	updateResourceVersion(resourceVersion: string): void;
}

export interface ReflectorOptions {
	name?: string;
	typeDescription?: string;
	resyncPeriodMs?: number;
	minWatchTimeoutMs?: number;
	clock?: Clock;
	backoff?: Backoff;
	// Models staging/src/k8s.io/client-go/tools/cache/reflector.go Reflector.useWatchList.
	// This simulator keeps the upstream field shape, but does not implement
	// watch-list yet because the local in-memory API surface does not model
	// apiserver pagination or resource pressure. Enable it only after porting
	// the upstream watch-list path.
	useWatchList?: boolean;
}

type WatchErrorHandlerWithContext<T extends KubernetesObject> = (
	ctx: context.Context,
	reflector: Reflector<T>,
	err: Error,
) => void;

// Models staging/src/k8s.io/client-go/tools/cache/reflector.go NewReflector.
export function newReflector<T extends KubernetesObject>(
	lw: ListerWatcher<T>,
	expectedType: T | undefined,
	store: ReflectorStore<T>,
	resyncPeriodMs: number,
): Reflector<T> {
	return newReflectorWithOptions(lw, expectedType, store, { resyncPeriodMs });
}

// Models staging/src/k8s.io/client-go/tools/cache/reflector.go NewNamedReflector.
export function newNamedReflector<T extends KubernetesObject>(
	name: string,
	lw: ListerWatcher<T>,
	expectedType: T | undefined,
	store: ReflectorStore<T>,
	resyncPeriodMs: number,
): Reflector<T> {
	return newReflectorWithOptions(lw, expectedType, store, { name, resyncPeriodMs });
}

// Models staging/src/k8s.io/client-go/tools/cache/reflector.go NewReflectorWithOptions.
export function newReflectorWithOptions<T extends KubernetesObject>(
	lw: ListerWatcher<T>,
	expectedType: T | undefined,
	store: ReflectorStore<T>,
	options: ReflectorOptions,
): Reflector<T> {
	const reflectorClock = options.clock ?? new Clock();
	const backoff = options.backoff ?? defaultBackoff();
	return new Reflector({
		name: options.name ?? "",
		typeDescription: options.typeDescription ?? getTypeDescriptionFromObject(expectedType),
		expectedType,
		expectedGVK: getExpectedGVKFromObject(expectedType),
		listerWatcher: toListerWatcherWithContext(lw),
		store,
		resyncPeriodMs: options.resyncPeriodMs ?? 0,
		minWatchTimeoutMs: options.minWatchTimeoutMs ?? 5 * 60 * 1000,
		clock: reflectorClock,
		delayHandler: backoff.delayWithReset(reflectorClock, defaultBackoffResetMs),
		useWatchList: options.useWatchList ?? false,
	});
}

interface ReflectorConstructorOptions<T extends KubernetesObject> {
	name: string;
	typeDescription: string;
	expectedType: T | undefined;
	expectedGVK: GroupVersionKind | undefined;
	listerWatcher: ListerWatcherWithContext<T>;
	store: ReflectorStore<T>;
	resyncPeriodMs: number;
	minWatchTimeoutMs: number;
	clock: Clock;
	delayHandler: DelayFunc;
	useWatchList: boolean;
}

// Models staging/src/k8s.io/client-go/tools/cache/reflector.go Reflector.
export class Reflector<T extends KubernetesObject> {
	name: string;
	typeDescription: string;
	shouldResync: (() => boolean) | undefined;
	private readonly listerWatcher: ListerWatcherWithContext<T>;
	private readonly expectedType: T | undefined;
	private readonly expectedGVK: GroupVersionKind | undefined;
	private readonly store: ReflectorStore<T>;
	private readonly resyncPeriodMs: number;
	private readonly minWatchTimeoutMs: number;
	private readonly clock: Clock;
	private readonly delayHandler: DelayFunc;
	private readonly watchErrorHandler: WatchErrorHandlerWithContext<T>;
	// Models staging/src/k8s.io/client-go/tools/cache/reflector.go Reflector.useWatchList.
	// Intentionally unsupported for now. The field is retained so the reflector
	// structure stays aligned with upstream and future watch-list work has an
	// explicit integration point.
	private readonly useWatchList: boolean;
	private lastResourceVersion = "";
	private isLastSyncResourceVersionUnavailable = false;

	constructor(options: ReflectorConstructorOptions<T>) {
		this.name = options.name;
		this.typeDescription = options.typeDescription;
		this.expectedType = options.expectedType;
		this.expectedGVK = options.expectedGVK;
		this.listerWatcher = options.listerWatcher;
		this.store = options.store;
		this.resyncPeriodMs = options.resyncPeriodMs;
		this.minWatchTimeoutMs = options.minWatchTimeoutMs;
		this.clock = options.clock;
		this.delayHandler = options.delayHandler;
		this.watchErrorHandler = defaultWatchErrorHandler;
		this.useWatchList = options.useWatchList;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/reflector.go Reflector.Name.
	getName(): string {
		return this.name;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/reflector.go Reflector.TypeDescription.
	getTypeDescription(): string {
		return this.typeDescription;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/reflector.go Reflector.RunWithContext.
	async runWithContext(ctx: context.Context): Promise<void> {
		await this.delayHandler.until(ctx, true, true, async (ctx) => {
			const err = await this.listAndWatchWithContext(ctx);
			if (err) {
				this.watchErrorHandler(ctx, this, err);
			}
			return [false, undefined];
		});
	}

	// Models staging/src/k8s.io/client-go/tools/cache/reflector.go Reflector.ListAndWatchWithContext.
	async listAndWatchWithContext(ctx: context.Context): Promise<Error | undefined> {
		if (this.useWatchList) {
			// Upstream can stream initial state with watch-list and fall back to a
			// regular list when unsupported. The simulator does not implement that
			// path yet; returning an error keeps the unsupported mode explicit
			// without drifting from this Go function's error-returning shape.
			return new Error("watch-list reflector mode is not implemented");
		}
		const err = await this.list(ctx);
		if (err) {
			return err;
		}
		return await this.watchWithResync(ctx, undefined);
	}

	// Models staging/src/k8s.io/client-go/tools/cache/reflector.go Reflector.watch.
	async watch(
		ctx: context.Context,
		w: Interface<T> | undefined,
		resyncErrCh?: ReadOnlyChannel<Error>,
	): Promise<Error | undefined> {
		try {
			for (;;) {
				const selected = await select()
					.case(ctx.done(), () => "done" as const)
					.default(() => "default" as const);
				if (selected === "done") {
					return undefined;
				}

				const start = this.clock.now();

				let propagateRVFromStart = true;
				if (!w) {
					const timeoutSeconds = Math.floor(this.minWatchTimeoutMs / 1000);
					const options: ListOptions = {
						resourceVersion: this.lastSyncResourceVersion(),
						timeoutSeconds,
						allowWatchBookmarks: true,
					};
					if (options.resourceVersion === "" || options.resourceVersion === "0") {
						propagateRVFromStart = false;
					}

					const [watcher, err] = await this.listerWatcher.watchWithContext(ctx, options);
					if (err) {
						return err;
					}
					w = watcher;
				}
				if (!w) {
					return undefined;
				}

				const err = await handleWatch(
					ctx,
					start,
					w,
					this.store,
					this.expectedType,
					this.expectedGVK,
					this.name,
					this.typeDescription,
					(resourceVersion, eventReceivedBesidesAdded) => {
						if (propagateRVFromStart || eventReceivedBesidesAdded) {
							this.setLastSyncResourceVersion(resourceVersion);
							if (isResourceVersionUpdater(this.store)) {
								this.store.updateResourceVersion(resourceVersion);
							}
						}
					},
					this.clock,
					resyncErrCh,
				);
				w = undefined;
				// Upstream calls retry.After(err) here and may continue the same watch
				// loop for bounded internal API errors. The simulator does not model
				// those API error classes yet, so we intentionally fall back to the
				// outer reflector loop to retry with a fresh list/watch cycle.
				if (err) {
					return undefined;
				}
			}
		} finally {
			await w?.stop();
		}
	}

	// Models staging/src/k8s.io/client-go/tools/cache/reflector.go Reflector.LastSyncResourceVersion.
	lastSyncResourceVersion(): string {
		return this.lastResourceVersion;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/reflector.go Reflector.setLastSyncResourceVersion.
	setLastSyncResourceVersion(value: string): void {
		this.lastResourceVersion = value;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/reflector.go Reflector.relistResourceVersion.
	relistResourceVersion(): string {
		if (this.isLastSyncResourceVersionUnavailable) {
			return "";
		}
		if (this.lastResourceVersion === "") {
			return "0";
		}
		return this.lastResourceVersion;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/reflector.go Reflector.rewatchResourceVersion.
	rewatchResourceVersion(): string {
		if (this.isLastSyncResourceVersionUnavailable) {
			return "";
		}
		return this.lastResourceVersion;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/reflector.go Reflector.setIsLastSyncResourceVersionUnavailable.
	setIsLastSyncResourceVersionUnavailable(isUnavailable: boolean): void {
		this.isLastSyncResourceVersionUnavailable = isUnavailable;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/reflector.go Reflector.list.
	private async list(ctx: context.Context): Promise<Error | undefined> {
		const resourceVersion = this.relistResourceVersion();
		const options: ListOptions = {
			allowWatchBookmarks: false,
			resourceVersion,
		};
		if (resourceVersion === "0") {
			options.limit = defaultWatchListPageSize;
		}
		const [list, err] = await this.listerWatcher.listWithContext(ctx, options);
		if (err) {
			return err;
		}
		if (!list) {
			return new Error(`failed to list ${this.typeDescription}: empty list result`);
		}
		const listedResourceVersion = list.metadata?.resourceVersion ?? "";
		const syncErr = await this.syncWith(list.items ?? [], listedResourceVersion);
		if (syncErr) {
			return syncErr;
		}
		this.setLastSyncResourceVersion(listedResourceVersion);
		this.setIsLastSyncResourceVersionUnavailable(false);
		return undefined;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/reflector.go Reflector.watchWithResync.
	async watchWithResync(
		ctx: context.Context,
		w: Interface<T> | undefined,
	): Promise<Error | undefined> {
		const resyncErrCh = new Channel<Error>(1);
		const [cancelCtx, cancel] = context.withCancel(ctx);
		const resyncPromise = this.startResync(cancelCtx, resyncErrCh);
		try {
			return await this.watch(ctx, w, resyncErrCh.readOnly());
		} finally {
			cancel();
			await resyncPromise;
		}
	}

	// Models staging/src/k8s.io/client-go/tools/cache/reflector.go Reflector.startResync.
	private async startResync(ctx: context.Context, resyncErrCh: Channel<Error>): Promise<void> {
		let [resyncCh, cleanup] = this.resyncChan();
		try {
			for (;;) {
				const selected = await select()
					.case(resyncCh, () => "resync" as const)
					.case(ctx.done(), () => "done" as const);
				if (selected === "done") {
					return;
				}
				if (!this.shouldResync || this.shouldResync()) {
					const err = await this.store.resync();
					if (err) {
						resyncErrCh.trySend(err);
						return;
					}
				}
				cleanup();
				[resyncCh, cleanup] = this.resyncChan();
			}
		} finally {
			cleanup();
		}
	}

	// Models staging/src/k8s.io/client-go/tools/cache/reflector.go Reflector.resyncChan.
	private resyncChan(): [ReadOnlyChannel<Date> | undefined, () => boolean] {
		if (this.resyncPeriodMs === 0) {
			return [undefined, () => false];
		}
		const timer = new time.Timer(this.clock, this.resyncPeriodMs);
		return [timer.C, () => timer.stop()];
	}

	// Models staging/src/k8s.io/client-go/tools/cache/reflector.go Reflector.syncWith.
	private async syncWith(items: T[], resourceVersion: string): Promise<Error | undefined> {
		return await this.store.replace([...items], resourceVersion);
	}
}

// Models staging/src/k8s.io/client-go/tools/cache/reflector.go handleWatch.
export async function handleWatch<T extends KubernetesObject>(
	ctx: context.Context,
	start: Date,
	w: Interface<T>,
	store: ReflectorStore<T>,
	expectedType: KubernetesObject | undefined,
	expectedGVK: GroupVersionKind | undefined,
	name: string,
	expectedTypeName: string,
	setLastSyncResourceVersion: (resourceVersion: string, eventReceivedBesidesAdded: boolean) => void,
	clock: Clock,
	errCh?: ReadOnlyChannel<Error>,
): Promise<Error | undefined> {
	const [, err] = await handleAnyWatch(
		ctx,
		start,
		w,
		store,
		expectedType,
		expectedGVK,
		name,
		expectedTypeName,
		setLastSyncResourceVersion,
		false,
		clock,
		errCh,
	);
	return err;
}

// Models staging/src/k8s.io/client-go/tools/cache/reflector.go handleAnyWatch.
async function handleAnyWatch<T extends KubernetesObject>(
	ctx: context.Context,
	start: Date,
	w: Interface<T>,
	store: ReflectorStore<T>,
	expectedType: KubernetesObject | undefined,
	expectedGVK: GroupVersionKind | undefined,
	name: string,
	_expectedTypeName: string,
	setLastSyncResourceVersion: (resourceVersion: string, eventReceivedBesidesAdded: boolean) => void,
	exitOnWatchListBookmarkReceived: boolean,
	clock: Clock,
	errCh?: ReadOnlyChannel<Error>,
): Promise<[watchListBookmarkReceived: boolean, err: Error | undefined]> {
	let watchListBookmarkReceived = false;
	let eventReceivedBesidesAdded = false;
	let eventCount = 0;
	let stopWatcher = true;
	try {
		loop: for (;;) {
			const selected = await select()
				.case(ctx.done(), () => ({ type: "ctx" }) as const)
				.case(errCh, (result) => ({ type: "err", result }) as const)
				.case(w.resultChan(), (result) => ({ type: "event", result }) as const);

			switch (selected.type) {
				case "ctx":
					return [watchListBookmarkReceived, errorStopRequested];
				case "err":
					if (selected.result.ok) {
						return [watchListBookmarkReceived, selected.result.value];
					}
					continue;
				case "event":
					if (!selected.result.ok) {
						break loop;
					}
					const event = selected.result.value;
					if (event.type === "ERROR") {
						return [watchListBookmarkReceived, new Error("watch error event")];
					}
					// Upstream checks reflect.TypeOf(event.Object) against expectedType here.
					// TypeScript does not have equivalent Kubernetes runtime object types, so
					// this intentionally overlaps with the GVK check below as the closest local
					// stand-in for rejecting objects that are not the expected API shape.
					if (expectedType) {
						const expectedAPIVersion = expectedType.apiVersion;
						const actualAPIVersion = event.object.apiVersion;
						if (expectedAPIVersion && expectedAPIVersion !== actualAPIVersion) {
							continue;
						}
						const expectedKind = expectedType.kind;
						const actualKind = event.object.kind;
						if (expectedKind && expectedKind !== actualKind) {
							continue;
						}
					}
					if (expectedGVK) {
						const actualGVK = groupVersionKindFromObject(event.object);
						if (
							expectedGVK.group !== actualGVK.group ||
							expectedGVK.version !== actualGVK.version ||
							expectedGVK.kind !== actualGVK.kind
						) {
							continue;
						}
					}
					const resourceVersion = event.object.metadata?.resourceVersion ?? "";
					switch (event.type) {
						case "ADDED": {
							await store.add(event.object);
							break;
						}
						case "MODIFIED": {
							eventReceivedBesidesAdded = true;
							await store.update(event.object);
							break;
						}
						case "DELETED": {
							eventReceivedBesidesAdded = true;
							await store.delete(event.object);
							break;
						}
						case "BOOKMARK": {
							eventReceivedBesidesAdded = true;
							watchListBookmarkReceived =
								event.object.metadata?.annotations?.["k8s.io/initial-events-end"] === "true";
							if (isReflectorBookmarkStore(store)) {
								await store.bookmark(resourceVersion);
							}
							break;
						}
					}
					setLastSyncResourceVersion(resourceVersion, eventReceivedBesidesAdded);
					eventCount++;
					if (exitOnWatchListBookmarkReceived && watchListBookmarkReceived) {
						stopWatcher = false;
						return [watchListBookmarkReceived, undefined];
					}
					break;
			}
		}

		if (clock.nowMs() - start.getTime() < 1000 && eventCount === 0) {
			return [watchListBookmarkReceived, new VeryShortWatchError(name)];
		}
		return [watchListBookmarkReceived, undefined];
	} finally {
		if (stopWatcher) {
			await w.stop();
		}
	}
}

function groupVersionKindFromObject(obj: KubernetesObject): GroupVersionKind {
	return fromAPIVersionAndKind(obj.apiVersion ?? "", obj.kind ?? "");
}

// TypeScript type guard for the Go type assertion store.(ReflectorBookmarkStore).
function isReflectorBookmarkStore<T extends KubernetesObject>(
	store: ReflectorStore<T>,
): store is ReflectorStore<T> & ReflectorBookmarkStore {
	return "bookmark" in store && typeof store.bookmark === "function";
}

// TypeScript type guard for the Go type assertion store.(ResourceVersionUpdater).
function isResourceVersionUpdater<T extends KubernetesObject>(
	store: ReflectorStore<T>,
): store is ReflectorStore<T> & ResourceVersionUpdater {
	return "updateResourceVersion" in store && typeof store.updateResourceVersion === "function";
}

// Models staging/src/k8s.io/client-go/tools/cache/reflector.go getTypeDescriptionFromObject.
function getTypeDescriptionFromObject(expectedType: KubernetesObject | undefined): string {
	if (!expectedType) {
		return defaultExpectedTypeName;
	}
	const gvk = getExpectedGVKFromObject(expectedType);
	if (gvk && !gvk.empty()) {
		return gvk.toString();
	}
	return expectedType.kind ?? defaultExpectedTypeName;
}

// Models staging/src/k8s.io/client-go/tools/cache/reflector.go getExpectedGVKFromObject.
function getExpectedGVKFromObject(
	expectedType: KubernetesObject | undefined,
): GroupVersionKind | undefined {
	if (!expectedType) {
		return undefined;
	}
	const gvk = groupVersionKindFromObject(expectedType);
	if (gvk.empty()) {
		return undefined;
	}
	return gvk;
}

function defaultBackoff(): Backoff {
	return new Backoff({
		durationMs: defaultBackoffInitMs,
		capMs: defaultBackoffMaxMs,
		steps: Math.ceil(defaultBackoffMaxMs / defaultBackoffInitMs),
		factor: defaultBackoffFactor,
		jitter: defaultBackoffJitter,
	});
}

// Models staging/src/k8s.io/client-go/tools/cache/reflector.go DefaultWatchErrorHandler.
function defaultWatchErrorHandler<T extends KubernetesObject>(
	_ctx: context.Context,
	_reflector: Reflector<T>,
	_err: Error,
): void {}

// Models staging/src/k8s.io/client-go/tools/cache/reflector.go errorStopRequested.
export const errorStopRequested = new Error("stop requested");

// Models staging/src/k8s.io/client-go/tools/cache/reflector.go VeryShortWatchError.
export class VeryShortWatchError extends Error {
	constructor(readonly name: string) {
		super(
			`very short watch: ${name}: Unexpected watch close - watch lasted less than a second and no items received`,
		);
	}
}
