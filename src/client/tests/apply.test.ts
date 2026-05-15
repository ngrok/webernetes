import { expect, it } from "vitest";
import { kubernetes } from "../../test/harnesses/kubernetes";

const LAST_APPLIED_ANNOTATION = "kubectl.kubernetes.io/last-applied-configuration";

kubernetes.describe("Apply", ({ core, k8s, helpers }) => {
	const { apply, getTestNamespace } = helpers;
	const mergePatchOptions = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch);

	it("should apply pod and service resources", async () => {
		const namespace = await getTestNamespace();

		const applied = await apply([
			{
				apiVersion: "v1",
				kind: "Pod",
				metadata: {
					name: "apply-pod",
					namespace,
					labels: {
						app: "apply-pod",
					},
				},
				spec: {
					containers: [{ name: "pause", image: "registry.k8s.io/pause:3.10" }],
				},
			},
			{
				apiVersion: "v1",
				kind: "Service",
				metadata: {
					name: "apply-service",
					namespace,
				},
				spec: {
					selector: {
						app: "apply-pod",
					},
					ports: [{ port: 80 }],
				},
			},
		]);

		expect(applied.map((resource) => resource.kind)).toEqual(["Pod", "Service"]);

		const pod = await core.readNamespacedPod({ name: "apply-pod", namespace });
		expect(pod.metadata?.annotations?.[LAST_APPLIED_ANNOTATION]).toBeTruthy();
		expect(pod.spec?.containers?.[0]?.image).toBe("registry.k8s.io/pause:3.10");

		const service = await core.readNamespacedService({ name: "apply-service", namespace });
		expect(service.metadata?.annotations?.[LAST_APPLIED_ANNOTATION]).toBeTruthy();
		expect(service.spec?.clusterIP).toBeTruthy();
		expect(service.spec?.ports?.[0]?.port).toBe(80);
	});

	it("should prune omitted applied fields and preserve unmanaged fields", async () => {
		const namespace = await getTestNamespace();
		const name = uniqueName("apply-merge-pod");

		await apply([
			{
				apiVersion: "v1",
				kind: "Pod",
				metadata: {
					name,
					namespace,
					labels: {
						owned: "old",
						removed: "old",
					},
				},
				spec: {
					nodeName: "apply-merge-missing-node",
					containers: [{ name: "pause", image: "registry.k8s.io/pause:3.10" }],
				},
			},
		]);

		await core.patchNamespacedPod(
			{
				name,
				namespace,
				body: {
					metadata: {
						labels: {
							unmanaged: "keep",
						},
					},
				},
			},
			mergePatchOptions,
		);

		await apply([
			{
				apiVersion: "v1",
				kind: "Pod",
				metadata: {
					name,
					namespace,
					labels: {
						owned: "new",
					},
				},
				spec: {
					nodeName: "apply-merge-missing-node",
					containers: [{ name: "pause", image: "registry.k8s.io/pause:3.10" }],
				},
			},
		]);

		const current = await core.readNamespacedPod({ name, namespace });
		expect(current.metadata?.labels?.owned).toBe("new");
		expect(current.metadata?.labels?.unmanaged).toBe("keep");
		expect(current.metadata?.labels?.removed).toBeUndefined();
	});

	it("should update service spec fields and preserve allocated fields", async () => {
		const namespace = await getTestNamespace();

		await apply([
			{
				apiVersion: "v1",
				kind: "Service",
				metadata: {
					name: "apply-service",
					namespace,
				},
				spec: {
					selector: {
						app: "old",
						remove: "true",
					},
					ports: [{ name: "http", port: 80 }],
				},
			},
		]);
		const original = await core.readNamespacedService({ name: "apply-service", namespace });

		await apply([
			{
				apiVersion: "v1",
				kind: "Service",
				metadata: {
					name: "apply-service",
					namespace,
				},
				spec: {
					selector: {
						app: "new",
					},
					ports: [{ name: "http", port: 80 }],
				},
			},
		]);

		const service = await core.readNamespacedService({ name: "apply-service", namespace });
		expect(service.spec?.selector?.app).toBe("new");
		expect(service.spec?.selector?.remove).toBeUndefined();
		expect(service.spec?.clusterIP).toBe(original.spec?.clusterIP);
		expect(service.spec?.clusterIPs).toEqual(original.spec?.clusterIPs);
		expect(service.spec?.ports?.[0]?.port).toBe(80);
	});

	it("should reject resources without names", async () => {
		const namespace = await getTestNamespace();

		await expect(
			apply([
				{
					apiVersion: "v1",
					kind: "Pod",
					metadata: {
						namespace,
					},
					spec: {
						containers: [{ name: "pause", image: "registry.k8s.io/pause:3.10" }],
					},
				},
			]),
		).rejects.toThrow("resource name may not be empty");
	});

	it("should adopt existing resources without last-applied annotations", async () => {
		const namespace = await getTestNamespace();
		const name = uniqueName("apply-adopt-pod");

		await core.createNamespacedPod({
			namespace,
			body: {
				metadata: {
					name,
					labels: {
						owned: "old",
						unmanaged: "keep",
					},
				},
				spec: {
					nodeName: "apply-adopt-missing-node",
					containers: [{ name: "pause", image: "registry.k8s.io/pause:3.10" }],
				},
			},
		});

		await apply([
			{
				apiVersion: "v1",
				kind: "Pod",
				metadata: {
					name,
					namespace,
					labels: {
						owned: "new",
					},
				},
				spec: {
					nodeName: "apply-adopt-missing-node",
					containers: [{ name: "pause", image: "registry.k8s.io/pause:3.10" }],
				},
			},
		]);

		const current = await core.readNamespacedPod({ name, namespace });
		expect(current.metadata?.labels?.owned).toBe("new");
		expect(current.metadata?.labels?.unmanaged).toBe("keep");
		expect(current.metadata?.annotations?.[LAST_APPLIED_ANNOTATION]).toBeTruthy();
	});

	it("should reject immutable field updates", async () => {
		const namespace = await getTestNamespace();
		const name = uniqueName("apply-immutable-pod");

		await apply([
			{
				apiVersion: "v1",
				kind: "Pod",
				metadata: {
					name,
					namespace,
				},
				spec: {
					nodeName: "apply-immutable-node-a",
					containers: [{ name: "pause", image: "registry.k8s.io/pause:3.10" }],
				},
			},
		]);

		await expect(
			apply([
				{
					apiVersion: "v1",
					kind: "Pod",
					metadata: {
						name,
						namespace,
					},
					spec: {
						nodeName: "apply-immutable-node-b",
						containers: [{ name: "pause", image: "registry.k8s.io/pause:3.10" }],
					},
				},
			]),
		).rejects.toThrow("pod updates may not change fields other than");
	});

	it("should preserve status when applying an existing resource", async () => {
		const namespace = await getTestNamespace();

		await apply([
			{
				apiVersion: "v1",
				kind: "Pod",
				metadata: {
					name: "apply-status-pod",
					namespace,
				},
				spec: {
					nodeName: "apply-status-missing-node",
					containers: [{ name: "pause", image: "registry.k8s.io/pause:3.10" }],
				},
			},
		]);

		const current = await core.readNamespacedPod({ name: "apply-status-pod", namespace });
		await core.replaceNamespacedPodStatus({
			name: "apply-status-pod",
			namespace,
			body: {
				...current,
				status: {
					phase: "Running",
				},
			},
		});

		await apply([
			{
				apiVersion: "v1",
				kind: "Pod",
				metadata: {
					name: "apply-status-pod",
					namespace,
					labels: {
						app: "updated",
					},
				},
				spec: {
					nodeName: "apply-status-missing-node",
					containers: [{ name: "pause", image: "registry.k8s.io/pause:3.10" }],
				},
			},
		]);

		const pod = await core.readNamespacedPod({ name: "apply-status-pod", namespace });
		expect(pod.status?.phase).toBe("Running");
		expect(pod.metadata?.labels?.app).toBe("updated");
	});
});

function uniqueName(prefix: string): string {
	return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
