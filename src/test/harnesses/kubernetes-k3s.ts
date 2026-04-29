import { beforeAll } from "vitest";
import { K3sContainer, type StartedK3sContainer } from "@testcontainers/k3s";
import * as realK8s from "@kubernetes/client-node";

import { node } from "../describe";
import type { SuiteOptions } from "../describe";
import type {
	KubernetesSuiteFactory,
	KubernetesTestContext,
	NodePortRequest,
	NodePortResponse,
} from "./kubernetes";
import type { K8s, KubeConfig } from "../../client/types";

let containerPromise: Promise<StartedK3sContainer> | undefined;
let setupPromise: Promise<void> | undefined;

const k8s = realK8s as unknown as K8s;
const realKubeConfig = new realK8s.KubeConfig();
const kubeConfig = realKubeConfig as unknown as KubeConfig;

const context: KubernetesTestContext = {
	k8s,
	kubeConfig,
	target: "k3s",
	sendNodePortRequest,
};

export function defineSuite(name: string, factory: KubernetesSuiteFactory): void;
export function defineSuite(
	name: string,
	options: SuiteOptions,
	factory: KubernetesSuiteFactory,
): void;
export function defineSuite(
	name: string,
	maybeOptions: SuiteOptions | KubernetesSuiteFactory,
	maybeFactory?: KubernetesSuiteFactory,
): void {
	const factory = typeof maybeOptions === "function" ? maybeOptions : maybeFactory;
	if (!factory) {
		throw new Error(`Missing k3s suite callback for ${name}`);
	}

	const suite = () => {
		beforeAll(async () => {
			await setupK3s();
		});
		factory(context);
	};

	if (typeof maybeOptions === "function") {
		node.describe(name, suite);
		return;
	}
	node.describe(name, maybeOptions, suite);
}

async function setupK3s(): Promise<void> {
	setupPromise ??= (async () => {
		const container = await getK3sContainer();
		realKubeConfig.loadFromString(container.getKubeConfig());
	})();
	await setupPromise;
}

async function getK3sContainer(): Promise<StartedK3sContainer> {
	containerPromise ??= new K3sContainer("rancher/k3s:v1.35.4-rc3-k3s1")
		.withName("k8s-web-simulator-k3s")
		.withCommand(["server", "--disable=traefik", "--disable=metrics-server"])
		.withReuse()
		.start();
	return await containerPromise;
}

async function sendNodePortRequest(
	nodePort: number,
	request?: NodePortRequest,
): Promise<NodePortResponse> {
	const container = await getK3sContainer();
	const path = request?.path ?? "/";
	const target = `http://127.0.0.1:${nodePort}${path}`;
	const result = await container.exec([
		"sh",
		"-c",
		`if command -v wget >/dev/null 2>&1; then wget -q -O - ${shellQuote(
			target,
		)}; else curl -fsSL ${shellQuote(target)}; fi`,
	]);
	if (result.exitCode !== 0) {
		throw new Error(result.stderr || result.output || `NodePort request failed: ${target}`);
	}
	return {
		status: 200,
		body: result.stdout,
	};
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
