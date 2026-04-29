import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { V1Pod, V1Status } from "../gen/models";
import type { K8s, KubeConfig } from "../types";
import { kubernetes } from "../../test/harnesses/kubernetes";

kubernetes.describe("Exec", ({ k8s, kubeConfig }) => {
	let api: InstanceType<typeof k8s.CoreV1Api>;
	let namespace: string;

	async function createNamespace(generateName: string): Promise<string> {
		const resp = await api.createNamespace({
			body: {
				metadata: {
					generateName,
				},
			},
		});

		if (!resp.metadata?.name) {
			throw new Error("Failed to create namespace");
		}

		return resp.metadata.name;
	}

	beforeAll(async () => {
		api = kubeConfig.makeApiClient(k8s.CoreV1Api);
		namespace = await createNamespace("exec-test-");
	});

	afterAll(async () => {
		await api.deleteNamespace({
			name: namespace,
		});
	});

	it("should execute commands in a pod with service DNS", async () => {
		await api.createNamespacedPod({
			namespace,
			body: {
				metadata: {
					name: "hello-world",
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
			},
		});

		await api.createNamespacedService({
			namespace,
			body: {
				metadata: {
					name: "exec-target",
				},
				spec: {
					type: "ClusterIP",
					selector: { app: "exec-hello-world" },
					ports: [{ name: "http", port: 80, targetPort: "http" }],
				},
			},
		});

		await api.createNamespacedPod({
			namespace,
			body: {
				metadata: {
					name: "busybox",
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
			},
		});

		await vi.waitFor(
			async () => {
				expectPodReady(await api.readNamespacedPod({ name: "hello-world", namespace }));
				expectPodReady(await api.readNamespacedPod({ name: "busybox", namespace }));
			},
			{ timeout: 120_000, interval: 500 },
		);

		const targetPod = await api.readNamespacedPod({ name: "hello-world", namespace });
		const podIp = targetPod.status?.podIP;
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
			const result = await execCommand(k8s, kubeConfig, namespace, "busybox", "busybox", [
				"wget",
				"-qO-",
				target,
			]);
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toContain("Hello World");
		}
	}, 180_000);
});

interface ExecCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function execCommand(
	k8s: K8s,
	config: KubeConfig,
	namespace: string,
	podName: string,
	containerName: string,
	command: string[],
): Promise<ExecCommandResult> {
	const stdout = new TextWritable();
	const stderr = new TextWritable();
	const status = await new Promise<V1Status>((resolve, reject) => {
		new k8s.Exec(config)
			.exec(namespace, podName, containerName, command, stdout, stderr, null, false, resolve)
			.catch(reject);
	});
	return {
		stdout: stdout.text,
		stderr: stderr.text,
		exitCode: status.status === "Success" ? 0 : Number(status.details?.causes?.[0]?.message ?? 1),
	};
}

class TextWritable {
	text = "";

	write(chunk: unknown): void {
		if (typeof chunk === "string") {
			this.text += chunk;
			return;
		}
		if (chunk instanceof Uint8Array) {
			this.text += new TextDecoder().decode(chunk);
			return;
		}
		this.text += String(chunk);
	}

	end(): void {}
}

function expectPodReady(pod: V1Pod): void {
	expect(pod.spec?.nodeName).toBeTruthy();
	expect(pod.status?.phase).toBe("Running");
	expect(pod.status?.podIP).toBeTruthy();
	expect(pod.status?.containerStatuses?.[0]).toMatchObject({
		ready: true,
		started: true,
	});
}
