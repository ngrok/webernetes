import { beforeAll } from "vitest";
import { K3sContainer, type StartedK3sContainer } from "@testcontainers/k3s";
import * as k8s from "@kubernetes/client-node";

import * as pod from "./pod";

let containerPromise: Promise<StartedK3sContainer> | undefined;

async function getK3sContainer() {
	containerPromise ??= new K3sContainer("rancher/k3s:v1.35.4-rc3-k3s1")
		.withName("k8s-web-simulator-k3s")
		.withReuse()
		.start();
	return containerPromise;
}

const kc = new k8s.KubeConfig();

beforeAll(async () => {
	const container = await getK3sContainer();
	kc.loadFromString(container.getKubeConfig());

	const coreApi = kc.makeApiClient(k8s.CoreV1Api);
	const resp = await coreApi.listNamespace();
	for (const ns of resp.items) {
		// oxlint-disable-next-line typescript/no-non-null-assertion
		const name = ns.metadata!.name!;

		if (name === "default" || name === "kube-system" || name === "kube-public") {
			continue;
		}

		await coreApi.deleteNamespace({ name });
	}
});

pod.tests(k8s, kc);
