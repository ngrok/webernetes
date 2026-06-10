import { expect, it, vi } from "vitest";
import type { V1Pod, V1PodSpec } from "../gen/models";
import { kubernetes } from "../../test/harnesses/kubernetes";

kubernetes.describe("Exec", ({ core, helpers }) => {
	const { createNamespace, createPod, createService, exec, getTestNamespace, waitForPodReady } =
		helpers;
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

	it("should resolve bare service names in the caller's namespace", async () => {
		const firstNamespace = await createNamespace("bare-dns-a-");
		const secondNamespace = await createNamespace("bare-dns-b-");
		const serviceName = "same-name";
		try {
			await createEchoPod(firstNamespace, serviceName, "first-namespace");
			await createEchoPod(secondNamespace, serviceName, "second-namespace");

			let firstBusybox = await createBusyboxPod(firstNamespace, "busybox");
			let secondBusybox = await createBusyboxPod(secondNamespace, "busybox");

			await waitForPodReady({ metadata: { name: serviceName, namespace: firstNamespace } });
			await waitForPodReady({ metadata: { name: serviceName, namespace: secondNamespace } });
			firstBusybox = await waitForPodReady(firstBusybox);
			secondBusybox = await waitForPodReady(secondBusybox);

			await expectBareServiceName(firstBusybox, serviceName, "first-namespace");
			await expectBareServiceName(secondBusybox, serviceName, "second-namespace");
		} finally {
			await core.deleteNamespace({ name: firstNamespace });
			await core.deleteNamespace({ name: secondNamespace });
		}
	});

	it("should resolve localhost to the calling pod", async () => {
		let pod = await createPod({
			metadata: {
				name: "localhost-fetch",
			},
			spec: {
				containers: [
					{
						name: "echo",
						image: "hashicorp/http-echo:1.0",
						args: ["-listen=:5678", "-text=localhost-pod"],
						ports: [{ name: "http", containerPort: 5678 }],
					},
					{
						name: "busybox",
						image: "busybox:1.36",
						command: ["sleep", "3600"],
					},
				],
			},
		});
		pod = await waitForPodReady(pod);

		await vi.waitFor(
			async () => {
				const result = await exec(pod, "busybox", ["wget", "-qO-", "http://localhost:5678"]);
				if (result.exitCode !== 0) {
					throw new Error(result.stderr || result.stdout);
				}
				expect(result.stdout.trim()).toBe("localhost-pod");
			},
			{ timeout: 30_000, interval: 500 },
		);
	});

	it("should apply pod DNS policies", async () => {
		const namespace = await getTestNamespace();
		const serviceName = "dns-policy-target";
		await createEchoPod(namespace, serviceName, "dns-policy");
		await waitForPodReady({ metadata: { name: serviceName, namespace } });

		let clusterFirstWithHostNet = await createBusyboxPod(namespace, "cluster-first-with-host-net", {
			dnsPolicy: "ClusterFirstWithHostNet",
			hostNetwork: true,
		});
		clusterFirstWithHostNet = await waitForPodReady(clusterFirstWithHostNet);
		await expectWget(clusterFirstWithHostNet, `http://${serviceName}`, "dns-policy");

		const kubeDNS = await core.readNamespacedService({
			name: "kube-dns",
			namespace: "kube-system",
		});
		const clusterDNS = kubeDNS.spec?.clusterIP;
		if (!clusterDNS || clusterDNS === "None") {
			throw new Error("Expected kube-dns to have a ClusterIP");
		}

		let defaultPolicy = await createBusyboxPod(namespace, "default-dns-policy", {
			dnsPolicy: "Default",
		});
		defaultPolicy = await waitForPodReady(defaultPolicy);
		await expectWgetFailure(defaultPolicy, `http://${serviceName}`);

		let noneWithoutSearch = await createBusyboxPod(namespace, "none-without-search", {
			dnsPolicy: "None",
			dnsConfig: {
				nameservers: [clusterDNS],
			},
		});
		noneWithoutSearch = await waitForPodReady(noneWithoutSearch);
		await expectWget(
			noneWithoutSearch,
			`http://${serviceName}.${namespace}.svc.cluster.local`,
			"dns-policy",
		);
		await expectWgetFailure(noneWithoutSearch, `http://${serviceName}`);

		let noneWithConfig = await createBusyboxPod(namespace, "none-with-config", {
			dnsPolicy: "None",
			dnsConfig: {
				nameservers: [clusterDNS],
				searches: [`${namespace}.svc.cluster.local`, "svc.cluster.local", "cluster.local"],
				options: [{ name: "ndots", value: "5" }],
			},
		});
		noneWithConfig = await waitForPodReady(noneWithConfig);
		await expectWget(noneWithConfig, `http://${serviceName}`, "dns-policy");
	});

	async function createBusyboxPod(
		namespace: string,
		name: string,
		spec: Partial<V1PodSpec> = {},
	): Promise<V1Pod> {
		return await createPod({
			metadata: {
				name,
				namespace,
			},
			spec: {
				...spec,
				containers: [
					{
						name: "busybox",
						image: "busybox:1.36",
						command: ["sleep", "3600"],
					},
				],
			},
		});
	}

	async function expectBareServiceName(
		pod: Awaited<ReturnType<typeof createBusyboxPod>>,
		serviceName: string,
		expectedBody: string,
	): Promise<void> {
		await expectWget(pod, `http://${serviceName}`, expectedBody);
	}

	async function expectWget(pod: V1Pod, target: string, expectedBody: string): Promise<void> {
		await vi.waitFor(
			async () => {
				const result = await exec(pod, "busybox", ["wget", "-qO-", target]);
				if (result.exitCode !== 0) {
					throw new Error(result.stderr || result.stdout);
				}
				expect(result.stdout.trim()).toBe(expectedBody);
			},
			{ timeout: 30_000, interval: 500 },
		);
	}

	async function expectWgetFailure(pod: V1Pod, target: string): Promise<void> {
		await vi.waitFor(
			async () => {
				const result = await exec(pod, "busybox", ["wget", "-qO-", target]);
				expect(result.exitCode).not.toBe(0);
			},
			{ timeout: 30_000, interval: 500 },
		);
	}

	async function createEchoPod(namespace: string, name: string, text: string): Promise<void> {
		await createPod({
			metadata: {
				name,
				namespace,
				labels: { app: `${name}-${text}` },
			},
			spec: {
				containers: [
					{
						name: "echo",
						image: "hashicorp/http-echo:1.0",
						args: ["-listen=:5678", `-text=${text}`],
						ports: [{ name: "http", containerPort: 5678 }],
					},
				],
			},
		});

		await createService({
			metadata: {
				name,
				namespace,
			},
			spec: {
				type: "ClusterIP",
				selector: { app: `${name}-${text}` },
				ports: [{ name: "http", port: 80, targetPort: "http" }],
			},
		});
	}
});
