import type { CoreV1Api } from "../../client/gen/apis/types";
import type { K8s, KubeConfig, KubernetesObject } from "../../client/types";
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
	let suiteNamespace: string | undefined;
	let testNamespace: string | undefined;

	const context: KubernetesRuntimeContext = {
		k8s,
		kubeConfig,
		target,
		fetchNodePort,
		apply,
		core,
		discovery,
		async getSuiteNamespace() {
			suiteNamespace ??= await createNamespace(core, "test-");
			return suiteNamespace;
		},
		async getTestNamespace() {
			testNamespace ??= await createNamespace(core, "test-");
			return testNamespace;
		},
		async createNamespace(generateName: string) {
			return await createNamespace(core, generateName);
		},
		async initialize() {},
		async disposeTest() {
			if (testNamespace) {
				await core.deleteNamespace({ name: testNamespace });
			}
			testNamespace = undefined;
		},
		async dispose() {
			await context.disposeTest();
			if (suiteNamespace) {
				await core.deleteNamespace({ name: suiteNamespace });
			}
			suiteNamespace = undefined;
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

async function createNamespace(api: CoreV1Api, generateName: string): Promise<string> {
	const resp = await api.createNamespace({
		body: {
			metadata: {
				generateName,
			},
		},
	});

	if (!resp.metadata?.name) {
		throw new Error("Failed to create namespace");
	}

	return resp.metadata.name;
}
