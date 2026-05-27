import { expect, it, vi } from "vitest";
import { kubernetes } from "../../test/harnesses/kubernetes";
import { apiErrorCode, apiStatusMessage } from "../../test/harnesses/helpers";

kubernetes.describe("Namespaces", ({ core, discovery, k8s, helpers }) => {
	const { waitFor } = helpers;
	it("should be able to create a namespace", async () => {
		const namespace = await core.createNamespace({
			body: {
				metadata: {
					generateName: "create-namespace-",
				},
			},
		});
		const name = namespace.metadata?.name;
		if (!name) {
			throw new Error("Expected namespace name");
		}

		try {
			expect(namespace.apiVersion).toBe("v1");
			expect(namespace.kind).toBe("Namespace");
			expect(name).toMatch(/^create-namespace-/);
		} finally {
			await core.deleteNamespace({ name });
		}
	});

	it("should be able to delete a namespace", async () => {
		const namespace = await core.createNamespace({
			body: {
				metadata: {
					generateName: "delete-namespace-",
				},
			},
		});
		const name = namespace.metadata?.name;
		if (!name) {
			throw new Error("Expected namespace name");
		}

		const deleted = await core.deleteNamespace({ name });
		expect(deleted).toBeTruthy();
		await waitFor(async () => {
			const namespace = await readNamespaceOrUndefined(name);
			expect(namespace?.metadata?.deletionTimestamp).toBeDefined();
			expect(namespace?.status?.phase).not.toBe("Active");
		});
	});

	it("should reject deleting a namespace that does not exist", async () => {
		let deleteError: unknown;
		try {
			await core.deleteNamespace({ name: "missing-namespace" });
		} catch (error) {
			deleteError = error;
		}
		expect(apiErrorCode(deleteError)).toBe(404);
		expect(apiStatusMessage(deleteError)).toBe(`namespaces "missing-namespace" not found`);
	});

	it("should delete namespaced resources when a namespace is deleted", async () => {
		const namespace = await core.createNamespace({
			body: {
				metadata: {
					generateName: "cascade-namespace-",
				},
			},
		});
		const name = namespace.metadata?.name;
		if (!name) {
			throw new Error("Expected namespace name");
		}

		await core.createNamespacedPod({
			namespace: name,
			body: {
				metadata: { name: "pod", namespace: name },
				spec: {
					containers: [{ name: "pause", image: "registry.k8s.io/pause:3.10" }],
				},
			},
		});
		await core.createNamespacedService({
			namespace: name,
			body: {
				metadata: { name: "service", namespace: name },
				spec: {
					ports: [{ port: 80 }],
				},
			},
		});
		await discovery.createNamespacedEndpointSlice({
			namespace: name,
			body: {
				metadata: { name: "slice", namespace: name },
				addressType: "IPv4",
				ports: [],
				endpoints: [],
			},
		});
		await core.createNamespacedEvent({
			namespace: name,
			body: {
				metadata: { name: "event", namespace: name },
				involvedObject: {
					apiVersion: "v1",
					kind: "Pod",
					name: "pod",
					namespace: name,
				},
				message: "test event",
				reason: "Test",
				type: "Normal",
			},
		});

		await core.deleteNamespace({ name });

		await vi.waitFor(
			async () => {
				expect((await core.listNamespacedPod({ namespace: name })).items).toHaveLength(0);
				expect((await core.listNamespacedService({ namespace: name })).items).toHaveLength(0);
				expect(
					(await discovery.listNamespacedEndpointSlice({ namespace: name })).items,
				).toHaveLength(0);
				expect((await core.listNamespacedEvent({ namespace: name })).items).toHaveLength(0);
				expect(await readNamespaceOrUndefined(name)).toBeUndefined();
			},
			{ timeout: 60_000, interval: 500 },
		);
	}, 60_000);

	it("should allow deleting a terminating namespace again", async () => {
		const namespace = await core.createNamespace({
			body: {
				metadata: {
					generateName: "double-delete-namespace-",
				},
			},
		});
		const name = namespace.metadata?.name;
		if (!name) {
			throw new Error("Expected namespace name");
		}

		await core.createNamespacedPod({
			namespace: name,
			body: {
				metadata: { name: "pod", namespace: name },
				spec: {
					containers: [{ name: "pause", image: "registry.k8s.io/pause:3.10" }],
				},
			},
		});
		await core.createNamespacedService({
			namespace: name,
			body: {
				metadata: { name: "service", namespace: name },
				spec: {
					ports: [{ port: 80 }],
				},
			},
		});
		await discovery.createNamespacedEndpointSlice({
			namespace: name,
			body: {
				metadata: { name: "slice", namespace: name },
				addressType: "IPv4",
				ports: [],
				endpoints: [],
			},
		});

		await core.deleteNamespace({ name });
		const terminating = await core.readNamespace({ name });
		expect(terminating.metadata?.deletionTimestamp).toBeDefined();
		expect(terminating.status?.phase).not.toBe("Active");

		await expect(core.deleteNamespace({ name })).resolves.toBeTruthy();

		const afterSecondDelete = await readNamespaceOrUndefined(name);
		expect(
			afterSecondDelete === undefined ||
				(afterSecondDelete.metadata?.deletionTimestamp !== undefined &&
					afterSecondDelete.status?.phase !== "Active"),
		).toBe(true);
	}, 60_000);

	it("should be able to patch a namespace", async () => {
		const mergePatchOptions = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch);
		const namespace = await core.createNamespace({
			body: {
				metadata: {
					generateName: "patch-namespace-",
					labels: {
						app: "original",
						remove: "true",
					},
				},
			},
		});
		const name = namespace.metadata?.name;
		if (!name) {
			throw new Error("Expected namespace name");
		}

		try {
			const patched = await core.patchNamespace(
				{
					name,
					body: {
						metadata: {
							labels: {
								app: "patched",
								remove: null,
							},
						},
					},
				},
				mergePatchOptions,
			);

			expect(patched.metadata?.name).toBe(name);
			expect(patched.metadata?.labels?.app).toBe("patched");
			expect(patched.metadata?.labels?.remove).toBeUndefined();
		} finally {
			await core.deleteNamespace({ name });
		}
	});

	it("should reject patching a namespace name", async () => {
		const mergePatchOptions = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch);
		const namespace = await core.createNamespace({
			body: {
				metadata: {
					generateName: "patch-namespace-name-",
				},
			},
		});
		const name = namespace.metadata?.name;
		if (!name) {
			throw new Error("Expected namespace name");
		}
		const changedName = `${name}-changed`;

		try {
			await expect(
				core.patchNamespace(
					{
						name,
						body: {
							metadata: {
								name: changedName,
							},
						},
					},
					mergePatchOptions,
				),
			).rejects.toThrow(
				`the name of the object (${changedName}) does not match the name on the URL (${name})`,
			);
		} finally {
			await core.deleteNamespace({ name });
		}
	});

	async function readNamespaceOrUndefined(name: string) {
		try {
			return await core.readNamespace({ name });
		} catch (error) {
			if (error instanceof Error && /NotFound|not found/.test(error.message)) {
				return undefined;
			}
			throw error;
		}
	}
});
