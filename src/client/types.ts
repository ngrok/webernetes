import type { CoreV1Api } from "./gen/apis/types";

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

export interface K8s {
	CoreV1Api: ApiConstructor<CoreV1Api>;
	Watch: ApiConstructor<Watch>;
}
