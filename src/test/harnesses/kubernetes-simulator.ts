import { afterAll, afterEach, beforeAll } from "vitest";

import { browser } from "../describe";
import type { SuiteOptions } from "../describe";
import { Cluster } from "../../cluster";
import * as fakeK8s from "../../client";
import { createKubernetesRuntimeContext } from "./kubernetes-context";
import type { KubernetesSuiteFactory, NodePortRequest, NodePortResponse } from "./kubernetes";
import type { K8s } from "../../client/types";

const cluster = new Cluster();
let setupPromise: Promise<void> | undefined;

const k8s = fakeK8s as unknown as K8s;

afterAll(() => {
	cluster.close();
});

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
		throw new Error(`Missing simulator suite callback for ${name}`);
	}

	const suite = () => {
		const context = createKubernetesRuntimeContext({
			k8s,
			kubeConfig: cluster.kubeConfig,
			target: "simulator",
			fetchNodePort,
		});

		beforeAll(async () => {
			await setupSimulator();
			await context.initialize();
		});
		afterAll(async () => {
			await context.dispose();
		});
		afterEach(async () => {
			await context.disposeTest();
		});
		factory(context);
	};

	if (typeof maybeOptions === "function") {
		browser.describe(name, suite);
		return;
	}
	browser.describe(name, maybeOptions, suite);
}

async function setupSimulator(): Promise<void> {
	setupPromise ??= (async () => {
		await cluster.init();
		cluster.imageRegistry.register("crccheck/hello-world:latest", {
			async start(context) {
				context.listenHttp(8000, async () => ({
					status: 200,
					body: "<xmp>\nHello World\n</xmp>\n",
				}));
				return await context.waitUntilKilled();
			},
			async exec() {
				return 0;
			},
		});
	})();
	await setupPromise;
}

async function fetchNodePort(
	nodePort: number,
	request?: NodePortRequest,
): Promise<NodePortResponse> {
	return await cluster.fetchNodePort(nodePort, request);
}
