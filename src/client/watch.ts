import { KubeConfig } from "./config";
import { labelsMatch, parseLabelSelector } from "./labels";
import {
	EndpointSliceStore,
	NodeStore,
	PodStore,
	ServiceStore,
	Storable,
	Store,
} from "../cluster/storage";

type WatchCallback = (phase: string, apiObj: unknown, watchObj?: unknown) => void;
type DoneCallback = (err: unknown) => void;

class AbortError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AbortError";
	}
}

function getNamespaceFromPath(path: string): string | undefined {
	const match = /^\/(?:api\/v1|apis\/discovery\.k8s\.io\/v1)\/namespaces\/([^/]+)/.exec(path);
	if (!match) {
		return undefined;
	}
	return decodeURIComponent(match[1] ?? "");
}

function parsePath(path: string): { kind: string; namespace?: string } | undefined {
	const namespace = getNamespaceFromPath(path);
	path = path.replace(/^\/api\/v1/, "");
	path = path.replace(/^\/apis\/discovery\.k8s\.io\/v1/, "");
	if (namespace) {
		path = path.replace(`/namespaces/${namespace}`, "");
	}
	const match = /^\/([^/]+)$/.exec(path);
	if (!match) {
		return undefined;
	}
	return { kind: decodeURIComponent(match[1] ?? ""), namespace };
}

function storeFromKind(kind: string, config: KubeConfig): Store<Storable> {
	const etcd = config.cluster.etcd;
	switch (kind) {
		case "pods":
			return new PodStore(etcd);
		case "services":
			return new ServiceStore(etcd, {
				serviceCIDR: config.cluster.serviceCIDR,
				nodePortRange: config.cluster.nodePortRange,
			});
		case "endpointslices":
			return new EndpointSliceStore(etcd);
		case "nodes":
			return new NodeStore(etcd);
		default:
			throw new Error(`Unsupported kind: ${kind}`);
	}
}

function objectKey(obj: { metadata?: { namespace?: string; name?: string } }): string {
	return `${obj.metadata?.namespace ?? ""}/${obj.metadata?.name ?? ""}`;
}

export class Watch {
	constructor(public readonly config: KubeConfig) {}

	public async watch(
		path: string,
		queryParams: Record<string, string | number | boolean | undefined>,
		callback: WatchCallback,
		done: DoneCallback,
	): Promise<AbortController> {
		const parsed = parsePath(path);
		if (!parsed) {
			throw new Error(`Unsupported watch path: ${path}`);
		}

		const { kind, namespace } = parsed;
		const store = storeFromKind(kind, this.config);

		const controller = new AbortController();
		let doneCalled = false;

		const doneOnce = (err: unknown) => {
			if (doneCalled) {
				return;
			}
			doneCalled = true;
			done(err);
		};

		const selector = queryParams.labelSelector;
		if (selector !== undefined && !(typeof selector === "string")) {
			throw new Error(`Invalid label selector: ${selector}`);
		}

		const labels = parseLabelSelector(selector);
		const matchingKeys = new Set<string>();

		const watcher = await store.watch(namespace);
		watcher.on("event", (phase, obj) => {
			const key = objectKey(obj);
			const matches = labelsMatch(obj, labels);
			const matchedPreviously = matchingKeys.has(key);

			if (!matches) {
				// This mirrors the filtered informer/view semantics documented by client-go:
				// an object that stops matching after an update is treated as a delete for
				// selector-scoped consumers. See FilteringResourceEventHandler:
				// https://pkg.go.dev/github.com/kubernetes/client-go/tools/cache#FilteringResourceEventHandler
				if (matchedPreviously) {
					matchingKeys.delete(key);
					callback("DELETED", obj, { type: "DELETED", object: obj });
				}
				return;
			}

			matchingKeys.add(key);
			callback(phase, obj, { type: phase, object: obj });
		});

		watcher.on("error", (error) => doneOnce(error));
		watcher.on("end", () => doneOnce(null));

		controller.signal.addEventListener(
			"abort",
			() => {
				watcher.cancel().finally(() => {
					doneOnce(new AbortError("Watch aborted."));
				});
			},
			{ once: true },
		);

		return controller;
	}
}
