import { expect, it } from "vitest";
import type { V1Container, V1Pod } from "../gen/models";
import { kubernetes } from "../../test/harnesses/kubernetes";
import { waitFor } from "../../test/wait";

const agnhostImage = "registry.k8s.io/e2e-test-images/agnhost:2.40";
const busyboxImage = "busybox:1.36";

kubernetes.describe("Probes", ({ core, getSuiteNamespace }) => {
	async function createPod(name: string, container: V1Container): Promise<V1Pod> {
		const namespace = await getSuiteNamespace();
		return await core.createNamespacedPod({
			namespace,
			body: {
				metadata: { name },
				spec: {
					containers: [container],
				},
			},
		});
	}

	async function readPod(name: string): Promise<V1Pod> {
		return await core.readNamespacedPod({
			namespace: await getSuiteNamespace(),
			name,
		});
	}

	it("readiness probe starts false, then becomes true after HTTP endpoint succeeds", async () => {
		await createPod(
			"http-readiness-success",
			agnhostContainer({
				readinessProbe: {
					httpGet: { path: "/readyz", port: "http" },
					initialDelaySeconds: 2,
					periodSeconds: 1,
					failureThreshold: 1,
				},
			}),
		);

		await waitFor(async () => {
			const pod = await readPod("http-readiness-success");
			expect(containerStatus(pod).ready).toBe(false);
			expect(conditionStatus(pod, "Ready")).toBe("False");
		});

		await waitFor(async () => {
			const pod = await readPod("http-readiness-success");
			expect(containerStatus(pod).ready).toBe(true);
			expect(conditionStatus(pod, "Ready")).toBe("True");
		});
	});

	it("pod with no readiness probe becomes ready when running", async () => {
		await createPod("no-readiness", agnhostContainer());

		await waitFor(async () => {
			const pod = await readPod("no-readiness");
			expect(containerStatus(pod)).toMatchObject({ ready: true, started: true });
			expect(conditionStatus(pod, "ContainersReady")).toBe("True");
		});
	});

	it("startup probe gates readiness until it succeeds", async () => {
		await createPod(
			"startup-gates-readiness",
			agnhostContainer({
				startupProbe: {
					httpGet: { path: "/healthz", port: "http" },
					initialDelaySeconds: 2,
					periodSeconds: 1,
					failureThreshold: 1,
				},
				readinessProbe: {
					httpGet: { path: "/readyz", port: "http" },
					periodSeconds: 1,
					failureThreshold: 1,
				},
			}),
		);

		await waitFor(async () => {
			const pod = await readPod("startup-gates-readiness");
			expect(containerStatus(pod).started).toBe(false);
			expect(containerStatus(pod).ready).toBe(false);
		});

		await waitFor(async () => {
			const pod = await readPod("startup-gates-readiness");
			expect(containerStatus(pod).started).toBe(true);
			expect(containerStatus(pod).ready).toBe(true);
		});
	});

	it("failing readiness probe marks container and pod not ready", async () => {
		await createPod(
			"http-readiness-failure",
			agnhostContainer({
				readinessProbe: {
					httpGet: { path: "/echo?code=500", port: "http" },
					periodSeconds: 1,
					failureThreshold: 1,
				},
			}),
		);

		await waitFor(async () => {
			const pod = await readPod("http-readiness-failure");
			expect(pod.status?.phase).toBe("Running");
			expect(containerStatus(pod).ready).toBe(false);
			expect(conditionStatus(pod, "Ready")).toBe("False");
		});
	});

	it("exec readiness probe succeeds based on command exit code", async () => {
		await createPod(
			"exec-readiness-success",
			busyboxContainer({
				readinessProbe: {
					exec: { command: ["true"] },
					periodSeconds: 1,
					failureThreshold: 1,
				},
			}),
		);

		await waitFor(async () => {
			expect(containerStatus(await readPod("exec-readiness-success")).ready).toBe(true);
		});
	});

	it("exec readiness probe fails based on command exit code", async () => {
		await createPod(
			"exec-readiness-failure",
			busyboxContainer({
				readinessProbe: {
					exec: { command: ["false"] },
					periodSeconds: 1,
					failureThreshold: 1,
				},
			}),
		);

		await waitFor(async () => {
			expect(containerStatus(await readPod("exec-readiness-failure")).ready).toBe(false);
		});
	});

	it("liveness failure restarts the container and increments restart count", async () => {
		await createPod(
			"liveness-restart",
			agnhostContainer({
				livenessProbe: {
					httpGet: { path: "/echo?code=500", port: "http" },
					periodSeconds: 1,
					failureThreshold: 1,
				},
			}),
		);

		await waitFor(async () => {
			const status = containerStatus(await readPod("liveness-restart"));
			expect(status.restartCount).toBeGreaterThan(0);
		});
	});

	it("tcpSocket readiness succeeds when the container listens on the target port", async () => {
		await createPod(
			"tcp-readiness-success",
			agnhostContainer({
				readinessProbe: {
					tcpSocket: { port: "http" },
					periodSeconds: 1,
					failureThreshold: 1,
				},
			}),
		);

		await waitFor(async () => {
			const pod = await readPod("tcp-readiness-success");
			expect(containerStatus(pod).ready).toBe(true);
			expect(conditionStatus(pod, "Ready")).toBe("True");
		});
	});
});

function agnhostContainer(overrides: Partial<V1Container> = {}): V1Container {
	return {
		name: "test",
		image: agnhostImage,
		command: ["/agnhost", "netexec", "--http-port=8080"],
		ports: [{ name: "http", containerPort: 8080 }],
		...overrides,
	};
}

function busyboxContainer(overrides: Partial<V1Container> = {}): V1Container {
	return {
		name: "test",
		image: busyboxImage,
		command: ["sleep", "3600"],
		...overrides,
	};
}

function containerStatus(pod: V1Pod) {
	const status = pod.status?.containerStatuses?.find((container) => container.name === "test");
	if (!status) {
		throw new Error(`pod ${pod.metadata?.name ?? ""} has no test container status`);
	}
	return status;
}

function conditionStatus(pod: V1Pod, type: string): string | undefined {
	return pod.status?.conditions?.find((condition) => condition.type === type)?.status;
}
