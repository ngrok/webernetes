import type { Clock } from "../clock";
import type { Etcd } from "../cluster/etcd";
import type { NodePortRange } from "../cluster/storage";

// oxlint-disable typescript/no-explicit-any
export interface ApiType {}
export type ApiConstructor<T extends ApiType> = new (...args: any[]) => T;

export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface KubeConfigOptions {
	clock: Clock;
	etcd: Etcd;
	serviceCIDR?: string;
	nodePortRange: NodePortRange;
	exec?: (
		namespace: string,
		podName: string,
		containerName: string | undefined,
		argv: string[],
	) => Promise<ExecResult>;
}

export class KubeConfig {
	constructor(readonly options: KubeConfigOptions) {}

	get clock(): Clock {
		return this.options.clock;
	}

	get etcd(): Etcd {
		return this.options.etcd;
	}

	get serviceCIDR(): string | undefined {
		return this.options.serviceCIDR;
	}

	get nodePortRange(): NodePortRange {
		return this.options.nodePortRange;
	}

	public makeApiClient<T extends ApiType>(apiClientType: ApiConstructor<T>): T {
		return new apiClientType(this.options);
	}

	async exec(
		namespace: string,
		podName: string,
		containerName: string | undefined,
		argv: string[],
	): Promise<ExecResult> {
		if (!this.options.exec) {
			throw new Error("exec is not configured for this kube config");
		}
		return await this.options.exec(namespace, podName, containerName, argv);
	}
}
