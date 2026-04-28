import { beforeAll } from "vitest";
import { K3sContainer, type StartedK3sContainer } from "@testcontainers/k3s";
import * as k8s from "@kubernetes/client-node";

import * as pod from "./pod";
import * as service from "./service";
import * as endpointslice from "./endpointslice";
import * as nodeport from "./nodeport";
import * as informer from "./informer";
import * as watch from "./watch";

let containerPromise: Promise<StartedK3sContainer> | undefined;

async function getK3sContainer() {
	containerPromise ??= new K3sContainer("rancher/k3s:v1.35.4-rc3-k3s1")
		.withName("k8s-web-simulator-k3s")
		.withCommand(["server", "--disable=traefik", "--disable=metrics-server"])
		.withReuse()
		.start();
	return containerPromise;
}

const kc = new k8s.KubeConfig();

const dontDeleteNamespaces = ["default", "kube-system", "kube-public", "kube-node-lease"];

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

beforeAll(async () => {
	const container = await getK3sContainer();
	kc.loadFromString(container.getKubeConfig());

	const coreApi = kc.makeApiClient(k8s.CoreV1Api);
	const resp = await coreApi.listNamespace();
	for (const ns of resp.items) {
		// oxlint-disable-next-line typescript/no-non-null-assertion
		const name = ns.metadata!.name!;

		if (dontDeleteNamespaces.includes(name)) {
			continue;
		}

		try {
			await coreApi.deleteNamespace({ name });
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes("HTTP-Code: 404")) {
				throw error;
			}
		}
	}
});

const nodePortOptions = {
	async sendNodePortRequest(nodePort: number, request?: nodeport.NodePortRequest) {
		const container = await getK3sContainer();
		const path = request?.path ?? "/";
		const target = `http://127.0.0.1:${nodePort}${path}`;
		const result = await container.exec([
			"sh",
			"-c",
			`if command -v wget >/dev/null 2>&1; then wget -q -O - ${shellQuote(target)}; else curl -fsSL ${shellQuote(target)}; fi`,
		]);
		if (result.exitCode !== 0) {
			throw new Error(result.stderr || result.output || `NodePort request failed: ${target}`);
		}
		return {
			status: 200,
			body: result.stdout,
		};
	},
};

pod.tests(k8s, kc);
service.tests(k8s, kc, nodePortOptions);
endpointslice.tests(k8s, kc);
nodeport.tests(k8s, kc, nodePortOptions);
informer.tests(k8s, kc);
watch.tests(k8s, kc);
