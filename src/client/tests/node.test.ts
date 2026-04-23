import { afterAll, beforeAll } from "vitest";
import { K3sContainer, type StartedK3sContainer } from "@testcontainers/k3s";
import * as k8s from "@kubernetes/client-node";

import * as pod from "./pod";

let containerPromise: Promise<StartedK3sContainer> | undefined;

async function getK3sContainer() {
	containerPromise ??= new K3sContainer("rancher/k3s:v1.35.4-rc3-k3s1").start();
	return containerPromise;
}

const kc = new k8s.KubeConfig();

beforeAll(async () => {
	const container = await getK3sContainer();
	kc.loadFromString(container.getKubeConfig());
});

afterAll(async () => {
	const container = await containerPromise;
	await container?.stop();
});

pod.tests(k8s, kc);
