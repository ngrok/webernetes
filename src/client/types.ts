// oxlint-disable typescript/no-explicit-any
import { CoreV1Api } from "./gen/apis/types";

interface ApiType {}

export interface KubeConfig {
	makeApiClient<T extends ApiType>(api: new (...args: any[]) => T): T;
}

export interface K8s {
	KubeConfig: new (...args: any[]) => KubeConfig;
	CoreV1Api: new (...args: any[]) => CoreV1Api;
}
