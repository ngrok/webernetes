import type { CoreV1Api, DiscoveryV1Api } from "./gen/apis/types";
import type { V1ListMeta, V1ObjectMeta } from "./gen/models";

export interface KubernetesObject {
	apiVersion?: string;
	kind?: string;
	metadata?: V1ObjectMeta;
}

export interface KubeList<T extends KubernetesObject> {
	apiVersion?: string;
	kind?: string;
	metadata?: V1ListMeta;
	items: T[];
}

export interface ApiType {}
// oxlint-disable-next-line typescript/no-explicit-any
export type ApiConstructor<T> = new (...args: any[]) => T;

export interface Watch {
	watch(
		path: string,
		queryParams: Record<string, string | number | boolean | undefined>,
		callback: (phase: string, apiObj: unknown, watchObj?: unknown) => void,
		done: (err: unknown) => void,
	): Promise<AbortController>;
}

export interface KubeConfig {
	makeApiClient<T extends ApiType>(api: ApiConstructor<T>): T;
}

export interface ObjectCache<T extends KubernetesObject> {
	get(name: string, namespace?: string): T | undefined;
	list(namespace?: string): ReadonlyArray<T>;
}

export interface Informer<T extends KubernetesObject> extends ObjectCache<T> {
	on(verb: "add" | "update" | "delete" | "change", cb: (obj: T) => void): void;
	on(verb: "error" | "connect", cb: (err?: unknown) => void): void;
	off(verb: "add" | "update" | "delete" | "change", cb: (obj: T) => void): void;
	off(verb: "error" | "connect", cb: (err?: unknown) => void): void;
	start(): Promise<void>;
	stop(): Promise<void>;
}

export interface K8s {
	CoreV1Api: ApiConstructor<CoreV1Api>;
	DiscoveryV1Api: ApiConstructor<DiscoveryV1Api>;
	Watch: ApiConstructor<Watch>;
	makeInformer<T extends KubernetesObject>(
		kubeconfig: KubeConfig,
		path: string,
		listPromiseFn: () => Promise<KubeList<T>>,
		labelSelector?: string,
	): Informer<T>;
}
