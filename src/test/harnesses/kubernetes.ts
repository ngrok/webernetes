import { browser, currentTestEnvironment, node } from "../describe";
import type { SuiteOptions } from "../describe";
import type { CoreV1Api, DiscoveryV1Api } from "../../client/gen/apis/types";
import type { K8s, KubeConfig } from "../../client/types";
import type { KubernetesHelpers } from "./helpers";

export interface KubernetesTestContext {
	k8s: K8s;
	kubeConfig: KubeConfig;
	core: CoreV1Api;
	discovery: DiscoveryV1Api;
	helpers: KubernetesHelpers;
	target: KubernetesTestTarget;
}

export interface NodePortRequest {
	method?: string;
	path?: string;
	headers?: Record<string, string>;
	body?: string;
	expectedCode?: number;
	retries?: number;
}

export interface NodePortResponse {
	status: number;
	body?: string;
	headers?: Record<string, string>;
}

export type KubernetesTestTarget = "k3s" | "simulator";

export type FetchNodePort = (
	nodePort: number,
	request?: NodePortRequest,
) => Promise<NodePortResponse>;

export type KubernetesSuiteFactory = (context: KubernetesTestContext) => void;

interface KubernetesDescribe {
	describe: KubernetesDescribeFn;
}

interface KubernetesDescribeFn {
	(name: string, factory: KubernetesSuiteFactory): void;
	(name: string, options: SuiteOptions, factory: KubernetesSuiteFactory): void;
}

interface KubernetesRuntime {
	defineSuite(name: string, factory: KubernetesSuiteFactory): void;
	defineSuite(name: string, options: SuiteOptions, factory: KubernetesSuiteFactory): void;
}

const k3sRuntime =
	currentTestEnvironment === "node"
		? await import(/* @vite-ignore */ "./kubernetes-k3s")
		: undefined;

const simulatorRuntime =
	currentTestEnvironment === "browser"
		? await import(/* @vite-ignore */ "./kubernetes-simulator")
		: undefined;

export const k3s: KubernetesDescribe = {
	describe: createTargetDescribe("k3s", k3sRuntime),
};

export const simulator: KubernetesDescribe = {
	describe: createTargetDescribe("simulator", simulatorRuntime),
};

export const kubernetes: KubernetesDescribe = {
	describe(
		name: string,
		...args: [KubernetesSuiteFactory] | [SuiteOptions, KubernetesSuiteFactory]
	) {
		defineTargetSuite(k3s, name, args);
		defineTargetSuite(simulator, name, args);
	},
};

function createTargetDescribe(
	target: KubernetesTestTarget,
	runtime: KubernetesRuntime | undefined,
): KubernetesDescribeFn {
	return (
		name: string,
		...args: [KubernetesSuiteFactory] | [SuiteOptions, KubernetesSuiteFactory]
	) => {
		const [maybeOptions, maybeFactory] = args;
		const factory = typeof maybeOptions === "function" ? maybeOptions : maybeFactory;
		if (!factory) {
			throw new Error(`Missing Kubernetes suite callback for ${name}`);
		}

		if (runtime) {
			if (typeof maybeOptions === "function") {
				runtime.defineSuite(name, factory);
				return;
			}
			runtime.defineSuite(name, maybeOptions, factory);
			return;
		}

		const environmentDescribe = target === "k3s" ? node.describe : browser.describe;
		if (typeof maybeOptions === "function") {
			environmentDescribe(name, () => undefined);
			return;
		}
		environmentDescribe(name, maybeOptions, () => undefined);
	};
}

function defineTargetSuite(
	target: KubernetesDescribe,
	name: string,
	args: [KubernetesSuiteFactory] | [SuiteOptions, KubernetesSuiteFactory],
): void {
	const [maybeOptions, maybeFactory] = args;
	if (typeof maybeOptions === "function") {
		target.describe(name, maybeOptions);
		return;
	}
	if (!maybeFactory) {
		throw new Error(`Missing Kubernetes suite callback for ${name}`);
	}
	target.describe(name, maybeOptions, maybeFactory);
}
