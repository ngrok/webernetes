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

	it("should list namespaces from an exact resourceVersion snapshot", async () => {
		const before = await core.createNamespace({
			body: {
				metadata: {
					generateName: "exact-list-before-",
				},
			},
		});
		const beforeName = before.metadata?.name;
		if (!beforeName) {
			throw new Error("Expected namespace name");
		}
		const firstList = await core.listNamespace();
		const snapshotResourceVersion = firstList.metadata?.resourceVersion ?? "";
		expect(Number(snapshotResourceVersion)).toBeGreaterThan(0);

		const after = await core.createNamespace({
			body: {
				metadata: {
					generateName: "exact-list-after-",
				},
			},
		});
		const afterName = after.metadata?.name;
		if (!afterName) {
			throw new Error("Expected namespace name");
		}

		try {
			const exactList = await core.listNamespace({
				resourceVersion: snapshotResourceVersion,
				resourceVersionMatch: "Exact",
			});

			expect(exactList.metadata?.resourceVersion).toBe(snapshotResourceVersion);
			expect(exactList.items.map((namespace) => namespace.metadata?.name)).toContain(beforeName);
			expect(exactList.items.map((namespace) => namespace.metadata?.name)).not.toContain(afterName);
		} finally {
			await core.deleteNamespace({ name: beforeName });
			await core.deleteNamespace({ name: afterName });
		}
	});

	it("should list namespaces not older than a resourceVersion", async () => {
		const firstList = await core.listNamespace();
		const snapshotResourceVersion = firstList.metadata?.resourceVersion ?? "";
		expect(Number(snapshotResourceVersion)).toBeGreaterThan(0);

		const namespace = await core.createNamespace({
			body: {
				metadata: {
					generateName: "not-older-than-after-",
				},
			},
		});
		const name = namespace.metadata?.name;
		if (!name) {
			throw new Error("Expected namespace name");
		}

		try {
			const notOlderThanList = await core.listNamespace({
				resourceVersion: snapshotResourceVersion,
				resourceVersionMatch: "NotOlderThan",
			});

			expect(Number(notOlderThanList.metadata?.resourceVersion)).toBeGreaterThanOrEqual(
				Number(snapshotResourceVersion),
			);
			expect(notOlderThanList.items.map((namespace) => namespace.metadata?.name)).toContain(name);
		} finally {
			await core.deleteNamespace({ name });
		}
	});

	it("should reject replacing a namespace with a stale resourceVersion", async () => {
		const namespace = await core.createNamespace({
			body: {
				metadata: {
					generateName: "replace-resource-version-conflict-",
					labels: { revision: "created" },
				},
			},
		});
		const name = namespace.metadata?.name;
		if (!name) {
			throw new Error("Expected namespace name");
		}

		try {
			await core.replaceNamespace({
				name,
				body: {
					...namespace,
					metadata: {
						...namespace.metadata,
						labels: { revision: "fresh" },
					},
				},
			});

			let replaceError: unknown;
			try {
				await core.replaceNamespace({
					name,
					body: {
						...namespace,
						metadata: {
							...namespace.metadata,
							labels: { revision: "stale" },
						},
					},
				});
			} catch (error) {
				replaceError = error;
			}

			expect(apiErrorCode(replaceError)).toBe(409);
			const current = await core.readNamespace({ name });
			expect(current.metadata?.labels?.revision).toBe("fresh");
		} finally {
			await core.deleteNamespace({ name });
		}
	});

	it("should allow replacing a namespace without a resourceVersion", async () => {
		const namespace = await core.createNamespace({
			body: {
				metadata: {
					generateName: "replace-without-resource-version-",
				},
			},
		});
		const name = namespace.metadata?.name;
		if (!name) {
			throw new Error("Expected namespace name");
		}
		const { resourceVersion: _resourceVersion, ...metadata } = namespace.metadata ?? {};

		try {
			const replaced = await core.replaceNamespace({
				name,
				body: {
					...namespace,
					metadata: {
						...metadata,
						labels: { revision: "unconditional" },
					},
				},
			});

			expect(replaced.metadata?.labels?.revision).toBe("unconditional");
		} finally {
			await core.deleteNamespace({ name });
		}
	});

	it("should reject deleting a namespace with a stale resourceVersion precondition", async () => {
		const namespace = await core.createNamespace({
			body: {
				metadata: {
					generateName: "delete-resource-version-precondition-",
					labels: { revision: "created" },
				},
			},
		});
		const name = namespace.metadata?.name;
		const staleResourceVersion = namespace.metadata?.resourceVersion ?? "";
		expect(Number(staleResourceVersion)).toBeGreaterThan(0);
		if (!name) {
			throw new Error("Expected namespace name");
		}

		try {
			await core.replaceNamespace({
				name,
				body: {
					...namespace,
					metadata: {
						...namespace.metadata,
						labels: { revision: "updated" },
					},
				},
			});

			let deleteError: unknown;
			try {
				await core.deleteNamespace({
					name,
					body: {
						preconditions: {
							resourceVersion: staleResourceVersion,
						},
					},
				});
			} catch (error) {
				deleteError = error;
			}

			expect(apiErrorCode(deleteError)).toBe(409);
			const current = await core.readNamespace({ name });
			expect(current.metadata?.labels?.revision).toBe("updated");
			expect(current.metadata?.deletionTimestamp).toBeUndefined();
		} finally {
			await core.deleteNamespace({ name });
		}
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
					terminationGracePeriodSeconds: 0,
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
		await waitFor(async () => {
			expect((await core.readNamespacedPod({ name: "pod", namespace: name })).status?.phase).toBe(
				"Running",
			);
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

				const namespace = await readNamespaceOrUndefined(name);
				if (!namespace) {
					return;
				}
				if (!namespace.metadata?.deletionTimestamp || namespace.status?.phase === "Active") {
					throw new Error(`Expected namespace ${name} to be deleted or terminating`);
				}
			},
			{ timeout: 180_000, interval: 500 },
		);
	}, 210_000);

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
