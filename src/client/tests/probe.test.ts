import { expect, it } from "vitest";
import type { CoreV1Event, V1Container, V1Pod } from "../gen/models";
import { kubernetes } from "../../test/harnesses/kubernetes";

const busyboxImage = "busybox:1.36";
const pauseImage = "registry.k8s.io/pause:3.10";
const probeObservationMs = 1_200;

kubernetes.describe("Probes", ({ helpers }) => {
	const { createAgnhostPod, createService, eventsFor, readPod, containerStatus, waitFor } = helpers;

	async function createPod(
		name: string,
		container: V1Container,
		labels?: Record<string, string>,
	): Promise<V1Pod> {
		return await helpers.createPod({
			metadata: { name, labels },
			spec: {
				containers: [container],
			},
		});
	}

	it("readiness probe starts false, then becomes true after HTTP endpoint succeeds", async () => {
		await createAgnhostPod({
			metadata: { name: "http-readiness-success" },
			spec: {
				containers: [
					{
						readinessProbe: {
							httpGet: { path: "/readyz", port: "http" },
							initialDelaySeconds: 1,
							periodSeconds: 1,
							failureThreshold: 1,
						},
					},
				],
			},
		});

		await waitFor(async () => {
			const pod = await readPod("http-readiness-success");
			expect(containerStatus(pod, "server").ready).toBe(false);
			expect(conditionStatus(pod, "Ready")).toBe("False");
		});

		await waitFor(async () => {
			const pod = await readPod("http-readiness-success");
			expect(containerStatus(pod, "server").ready).toBe(true);
			expect(conditionStatus(pod, "Ready")).toBe("True");
		});
	});

	it("pod with no readiness probe becomes ready when running", async () => {
		const created = await createAgnhostPod({ metadata: { name: "no-readiness" } });

		await waitFor(async () => {
			const pod = await readPod(created);
			expect(containerStatus(pod, "server")).toMatchObject({ ready: true, started: true });
			expect(conditionStatus(pod, "ContainersReady")).toBe("True");
		});
	});

	it("startup probe gates readiness until it succeeds", async () => {
		await createAgnhostPod({
			metadata: { name: "startup-gates-readiness" },
			spec: {
				containers: [
					{
						startupProbe: {
							httpGet: { path: "/healthz", port: "http" },
							initialDelaySeconds: 1,
							periodSeconds: 1,
							failureThreshold: 1,
						},
						readinessProbe: {
							httpGet: { path: "/readyz", port: "http" },
							periodSeconds: 1,
							failureThreshold: 1,
						},
					},
				],
			},
		});

		await waitFor(async () => {
			const pod = await readPod("startup-gates-readiness");
			expect(containerStatus(pod, "server").started).toBe(false);
			expect(containerStatus(pod, "server").ready).toBe(false);
		});

		await waitFor(async () => {
			const pod = await readPod("startup-gates-readiness");
			expect(containerStatus(pod, "server").started).toBe(true);
			expect(containerStatus(pod, "server").ready).toBe(true);
		});
	});

	it("failing readiness probe marks container and pod not ready", async () => {
		await createAgnhostPod({
			metadata: { name: "http-readiness-failure" },
			spec: {
				containers: [
					{
						readinessProbe: {
							httpGet: { path: "/echo?code=500", port: "http" },
							periodSeconds: 1,
							failureThreshold: 1,
						},
					},
				],
			},
		});

		await waitFor(async () => {
			const pod = await readPod("http-readiness-failure");
			expect(pod.status?.phase).toBe("Running");
			expect(containerStatus(pod, "server").ready).toBe(false);
			expect(conditionStatus(pod, "Ready")).toBe("False");
		});
		expect(containerStatus(await readPod("http-readiness-failure"), "server").restartCount).toBe(0);
	});

	it("HTTP readiness probe records connection refused events when no process listens on the port", async () => {
		const pod = await createPod(
			"http-readiness-connection-refused",
			{
				name: "pause",
				image: pauseImage,
				ports: [{ name: "http", containerPort: 8080 }],
				readinessProbe: {
					httpGet: { path: "/", port: "http" },
					periodSeconds: 1,
					failureThreshold: 1,
				},
			},
			{ app: "http-readiness-connection-refused" },
		);
		await createService({
			metadata: { name: "http-readiness-connection-refused" },
			spec: {
				selector: { app: "http-readiness-connection-refused" },
				ports: [{ name: "http", port: 80, targetPort: "http" }],
			},
		});

		await waitFor(async () => {
			const current = await readPod(pod);
			expect(current.status?.phase).toBe("Running");
			expect(containerStatus(current, "pause").ready).toBe(false);
			expect(conditionStatus(current, "Ready")).toBe("False");
		});

		await waitFor(async () => {
			const event = newestEventWithReason(await eventsFor(pod), "Unhealthy");
			expect(event?.message).toContain("Readiness probe failed:");
			expect(event?.message).toContain("connection refused");
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
		await createAgnhostPod({
			metadata: { name: "liveness-restart" },
			spec: {
				containers: [
					{
						livenessProbe: {
							httpGet: { path: "/echo?code=500", port: "http" },
							periodSeconds: 1,
							failureThreshold: 1,
						},
					},
				],
			},
		});

		await waitFor(async () => {
			const status = containerStatus(await readPod("liveness-restart"), "server");
			expect(status.restartCount).toBeGreaterThan(0);
		});
	});

	it("exec liveness probe success does not restart the container", async () => {
		await createPod(
			"exec-liveness-success",
			busyboxContainer({
				livenessProbe: {
					exec: { command: ["true"] },
					periodSeconds: 1,
					failureThreshold: 1,
				},
			}),
		);

		await waitFor(async () => {
			expect(containerStatus(await readPod("exec-liveness-success")).started).toBe(true);
		});
		await observeFor(probeObservationMs);
		expect(containerStatus(await readPod("exec-liveness-success")).restartCount).toBe(0);
	});

	it("tcpSocket liveness probe success does not restart the container", async () => {
		await createAgnhostPod({
			metadata: { name: "tcp-liveness-success" },
			spec: {
				containers: [
					{
						livenessProbe: {
							tcpSocket: { port: "http" },
							periodSeconds: 1,
							failureThreshold: 1,
						},
					},
				],
			},
		});

		await waitFor(async () => {
			expect(containerStatus(await readPod("tcp-liveness-success"), "server").started).toBe(true);
		});
		await observeFor(probeObservationMs);
		expect(containerStatus(await readPod("tcp-liveness-success"), "server").restartCount).toBe(0);
	});

	it("tcpSocket readiness succeeds when the container listens on the target port", async () => {
		await createAgnhostPod({
			metadata: { name: "tcp-readiness-success" },
			spec: {
				containers: [
					{
						readinessProbe: {
							tcpSocket: { port: "http" },
							periodSeconds: 1,
							failureThreshold: 1,
						},
					},
				],
			},
		});

		await waitFor(async () => {
			const pod = await readPod("tcp-readiness-success");
			expect(containerStatus(pod, "server").ready).toBe(true);
			expect(conditionStatus(pod, "Ready")).toBe("True");
		});
	});
});

function busyboxContainer(overrides: Partial<V1Container> = {}): V1Container {
	return {
		name: "test",
		image: busyboxImage,
		command: ["sleep", "3600"],
		...overrides,
	};
}

function conditionStatus(pod: V1Pod, type: string): string | undefined {
	return pod.status?.conditions?.find((condition) => condition.type === type)?.status;
}

function newestEventWithReason(
	events: readonly CoreV1Event[],
	reason: string,
): CoreV1Event | undefined {
	return events
		.filter((event) => event.reason === reason)
		.sort((left, right) => eventTime(right).localeCompare(eventTime(left)))[0];
}

function eventTime(event: CoreV1Event): string {
	const value = event.lastTimestamp ?? event.eventTime ?? event.firstTimestamp;
	if (value instanceof Date) {
		return value.toISOString();
	}
	return value ?? "";
}

async function observeFor(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
