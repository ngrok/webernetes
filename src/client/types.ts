import type { CoreV1Api, DiscoveryV1Api } from "./gen/apis/types";
import type { V1ListMeta, V1ObjectMeta, V1Status } from "./gen/models";

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

export class V1MicroTime extends Date {
	toISOString(): string {
		return super.toISOString();
	}
}

export interface Watch {
	watch(
		path: string,
		queryParams: Record<string, string | number | boolean | undefined>,
		callback: (phase: string, apiObj: unknown, watchObj?: unknown) => void,
		done: (err: unknown) => void,
	): Promise<AbortController>;
}

export interface ExecWritable {
	write(chunk: unknown): unknown;
	end?(): unknown;
}

export interface ExecReadable {}

export interface ExecWebSocket {
	close(): void;
}

export interface Exec {
	exec(
		namespace: string,
		podName: string,
		containerName: string,
		command: string | string[],
		stdout: ExecWritable | null,
		stderr: ExecWritable | null,
		stdin: ExecReadable | null,
		tty: boolean,
		statusCallback?: (status: V1Status) => void,
	): Promise<ExecWebSocket>;
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
	Exec: ApiConstructor<Exec>;
	Watch: ApiConstructor<Watch>;
	makeInformer<T extends KubernetesObject>(
		kubeconfig: KubeConfig,
		path: string,
		listPromiseFn: () => Promise<KubeList<T>>,
		labelSelector?: string,
	): Informer<T>;
}
