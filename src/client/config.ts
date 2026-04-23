import { Cluster } from "../cluster";

// oxlint-disable typescript/no-explicit-any
export interface ApiType {}
export type ApiConstructor<T extends ApiType> = new (...args: any[]) => T;

export class KubeConfig {
	readonly cluster: Cluster;

	constructor(cluster: Cluster) {
		this.cluster = cluster;
	}

	public makeApiClient<T extends ApiType>(apiClientType: ApiConstructor<T>): T {
		return new apiClientType(this.cluster);
	}
}
