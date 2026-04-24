import { KubeConfig } from "./config";
import { NodeStore, PodStore, Storable, Store } from "../cluster/storage";
import { Etcd } from "../cluster/etcd";

type WatchCallback = (phase: string, apiObj: unknown, watchObj?: unknown) => void;
type DoneCallback = (err: unknown) => void;

class AbortError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AbortError";
	}
}

function getNamespaceFromPath(path: string): string | undefined {
	const match = /^\/api\/v1\/namespaces\/([^/]+)/.exec(path);
	if (!match) {
		return undefined;
	}
	return decodeURIComponent(match[1] ?? "");
}

function parsePath(path: string): { kind: string; namespace?: string } | undefined {
	const namespace = getNamespaceFromPath(path);
	path = path.replace("/api/v1", "");
	if (namespace) {
		path = path.replace(`/namespaces/${namespace}`, "");
	}
	const match = /^\/([^/]+)$/.exec(path);
	if (!match) {
		return undefined;
	}
	return { kind: decodeURIComponent(match[1] ?? ""), namespace };
}

function storeFromKind(kind: string, etcd: Etcd): Store<Storable> {
	switch (kind) {
		case "pods":
			return new PodStore(etcd);
		case "nodes":
			return new NodeStore(etcd);
		default:
			throw new Error(`Unsupported kind: ${kind}`);
	}
}

function parseLabels(labels?: string): Record<string, string> {
	if (!labels) {
		return {};
	}
	const result: Record<string, string> = {};
	for (const pair of labels.split(",")) {
		const [key, value] = pair.split("=");
		if (key && value) {
			result[key.trim()] = value.trim();
		}
	}
	return result;
}

function labelsMatch(labels: Record<string, string>, selector: Record<string, string>): boolean {
	for (const [key, value] of Object.entries(selector)) {
		if (labels[key] !== value) {
			return false;
		}
	}
	return true;
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
		const store = storeFromKind(kind, this.config.cluster.etcd);

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

		const labels = parseLabels(selector);

		const watcher = await store.watch(namespace);
		watcher.on("event", (phase, obj) => {
			if (!labelsMatch(obj.metadata?.labels || {}, labels)) {
				return;
			}

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
