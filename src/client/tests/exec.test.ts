import { expect, it, vi } from "vitest";
import { kubernetes } from "../../test/harnesses/kubernetes";

kubernetes.describe("Exec", ({ helpers }) => {
	const { createPod, createService, exec, getTestNamespace, waitForPodReady } = helpers;
	it("should execute commands in a pod with service DNS", async () => {
		const namespace = await getTestNamespace();

		let helloWorld = await createPod({
			metadata: {
				name: "hello-world",
				namespace,
				labels: { app: "exec-hello-world" },
			},
			spec: {
				containers: [
					{
						name: "hello-world",
						image: "crccheck/hello-world:latest",
						ports: [{ name: "http", containerPort: 8000 }],
					},
				],
			},
		});

		await createService({
			metadata: {
				name: "exec-target",
				namespace,
			},
			spec: {
				type: "ClusterIP",
				selector: { app: "exec-hello-world" },
				ports: [{ name: "http", port: 80, targetPort: "http" }],
			},
		});

		let busybox = await createPod({
			metadata: {
				name: "busybox",
				namespace,
			},
			spec: {
				containers: [
					{
						name: "busybox",
						image: "busybox:1.36",
						command: ["sleep", "3600"],
					},
				],
			},
		});

		helloWorld = await waitForPodReady(helloWorld);
		busybox = await waitForPodReady(busybox);
		const podIp = helloWorld.status?.podIP;
		if (!podIp) {
			throw new Error("Expected hello-world pod to have an IP address");
		}

		for (const target of [
			`http://${podIp}:8000`,
			`http://exec-target.${namespace}.svc.cluster.local`,
			`http://exec-target.${namespace}.svc`,
			`http://exec-target.${namespace}`,
			"http://exec-target",
		]) {
			await vi.waitFor(
				async () => {
					const result = await exec(busybox, "busybox", ["wget", "-qO-", target]);
					if (result.exitCode !== 0) {
						throw new Error(`${target}: ${result.stderr || result.stdout}`);
					}
					expect(result.exitCode).toBe(0);
					expect(result.stderr).toBe("");
					expect(result.stdout).toContain("Hello World");
				},
				{ timeout: 30_000, interval: 500 },
			);
		}
	});
});
