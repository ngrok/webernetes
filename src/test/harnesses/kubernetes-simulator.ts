import { afterAll, afterEach, beforeAll } from "vitest";

import { browser } from "../describe";
import type { SuiteOptions } from "../describe";
import { Cluster } from "../../cluster";
import * as http from "../../cluster/cni/http";
import * as fakeK8s from "../../client";
import { createKubernetesRuntimeContext } from "./kubernetes-context";
import type { KubernetesSuiteFactory, NodePortRequest, NodePortResponse } from "./kubernetes";
import type { K8s } from "../../client/types";

const cluster = new Cluster();
let setupPromise: Promise<void> | undefined;

const k8s = fakeK8s as unknown as K8s;

afterAll(async () => {
	await cluster.close();
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
			apply: async (resources) => await cluster.apply(resources),
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
	})();
	await setupPromise;
}

async function fetchNodePort(
	nodePort: number,
	request?: NodePortRequest,
): Promise<NodePortResponse> {
	const path = request?.path ?? "/";
	const pathname = path.startsWith("/") ? path : `/${path}`;
	const url = new URL(`http://node-1:${nodePort}${pathname}`);
	const response = await cluster.fetch(url.toString(), toHTTPRequest(request));
	return {
		status: response.status,
		body: response.body,
		headers: toNodePortHeaders(response.header),
	};
}

function toHTTPRequest(request?: NodePortRequest): http.FetchInit {
	return {
		method: request?.method ?? "GET",
		headers: request?.headers,
		body: request?.body,
	};
}

function toNodePortHeaders(header: http.Header | undefined): Record<string, string> | undefined {
	if (!header) {
		return undefined;
	}
	return Object.fromEntries(
		Object.entries(header).map(([name, values]) => [name, values.join(", ")]),
	);
}
