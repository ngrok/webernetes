import type { K8s, KubeConfig, KubernetesObject } from "../../client/types";
import { createKubernetesHelpers } from "./helpers";
import type { KubernetesTestContext, KubernetesTestTarget, FetchNodePort } from "./kubernetes";

export interface KubernetesRuntimeContext extends KubernetesTestContext {
	initialize(): Promise<void>;
	disposeTest(): Promise<void>;
	dispose(): Promise<void>;
}

export function createKubernetesRuntimeContext({
	k8s,
	kubeConfig,
	target,
	fetchNodePort,
	apply,
}: {
	k8s: K8s;
	kubeConfig: KubeConfig;
	target: KubernetesTestTarget;
	fetchNodePort: FetchNodePort;
	apply<T extends KubernetesObject>(resources: T[]): Promise<T[]>;
}): KubernetesRuntimeContext {
	const core = lazyApiClient(() => kubeConfig.makeApiClient(k8s.CoreV1Api));
	const discovery = lazyApiClient(() => kubeConfig.makeApiClient(k8s.DiscoveryV1Api));
	const helpers = createKubernetesHelpers({
		k8s,
		kubeConfig,
		core,
		fetchNodePort,
		apply,
	});

	const context: KubernetesRuntimeContext = {
		k8s,
		kubeConfig,
		target,
		core,
		discovery,
		helpers,
		async initialize() {},
		async disposeTest() {
			await helpers.disposeTest();
		},
		async dispose() {
			await helpers.dispose();
		},
	};

	return context;
}

function lazyApiClient<T extends object>(factory: () => T): T {
	let target: T | undefined;
	return new Proxy({} as T, {
		get(_object, property, receiver) {
			target ??= factory();
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
