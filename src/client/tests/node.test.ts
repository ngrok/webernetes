import { expect, it } from "vitest";
import { kubernetes } from "../../test/harnesses/kubernetes";
import { apiErrorCode } from "../../test/harnesses/helpers";

kubernetes.describe("Nodes", ({ core, k8s }) => {
	const mergePatchOptions = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch);

	it("should be able to create a node", async () => {
		const node = await core.createNode({
			body: {
				metadata: {
					generateName: "create-node-",
				},
			},
		});
		const name = node.metadata?.name;
		if (!name) {
			throw new Error("Expected node name");
		}

		try {
			expect(node.apiVersion).toBe("v1");
			expect(node.kind).toBe("Node");
			expect(name).toMatch(/^create-node-/);
		} finally {
			await core.deleteNode({ name });
		}
	});

	it("should support field selectors when listing nodes", async () => {
		const nodes = await core.listNode();
		const selectedNode = nodes.items.find((node) => node.metadata?.name);
		if (!selectedNode?.metadata?.name) {
			throw new Error("Expected at least one node");
		}

		const selectedNodes = await core.listNode({
			fieldSelector: `metadata.name=${selectedNode.metadata.name}`,
		});

		expect(selectedNodes.items).toEqual([
			expect.objectContaining({
				metadata: expect.objectContaining({
					name: selectedNode.metadata.name,
				}),
			}),
		]);
	});

	it("should support label selectors when listing nodes", async () => {
		const selected = await core.createNode({
			body: {
				metadata: {
					generateName: "label-selected-node-",
					labels: { app: "node-label-selected" },
				},
			},
		});
		const selectedName = selected.metadata?.name;
		const ignored = await core.createNode({
			body: {
				metadata: {
					generateName: "label-ignored-node-",
					labels: { app: "node-label-ignored" },
				},
			},
		});
		const ignoredName = ignored.metadata?.name;
		if (!selectedName || !ignoredName) {
			throw new Error("Expected node names");
		}

		try {
			const nodes = await core.listNode({
				labelSelector: "app=node-label-selected",
			});

			expect(nodes.items.map((node) => node.metadata?.name)).toContain(selectedName);
			expect(nodes.items.map((node) => node.metadata?.name)).not.toContain(ignoredName);
		} finally {
			await core.deleteNode({ name: selectedName });
			await core.deleteNode({ name: ignoredName });
		}
	});

	it("should list nodes from an exact resourceVersion snapshot", async () => {
		const before = await core.createNode({
			body: {
				metadata: {
					generateName: "exact-list-before-",
				},
			},
		});
		const beforeName = before.metadata?.name;
		if (!beforeName) {
			throw new Error("Expected node name");
		}
		const firstList = await core.listNode();
		const snapshotResourceVersion = firstList.metadata?.resourceVersion ?? "";
		expect(Number(snapshotResourceVersion)).toBeGreaterThan(0);

		const after = await core.createNode({
			body: {
				metadata: {
					generateName: "exact-list-after-",
				},
			},
		});
		const afterName = after.metadata?.name;
		if (!afterName) {
			throw new Error("Expected node name");
		}

		try {
			const exactList = await core.listNode({
				resourceVersion: snapshotResourceVersion,
				resourceVersionMatch: "Exact",
			});

			expect(exactList.metadata?.resourceVersion).toBe(snapshotResourceVersion);
			expect(exactList.items.map((node) => node.metadata?.name)).toContain(beforeName);
			expect(exactList.items.map((node) => node.metadata?.name)).not.toContain(afterName);
		} finally {
			await core.deleteNode({ name: beforeName });
			await core.deleteNode({ name: afterName });
		}
	});

	it("should list nodes not older than a resourceVersion", async () => {
		const firstList = await core.listNode();
		const snapshotResourceVersion = firstList.metadata?.resourceVersion ?? "";
		expect(Number(snapshotResourceVersion)).toBeGreaterThan(0);

		const node = await core.createNode({
			body: {
				metadata: {
					generateName: "not-older-than-after-",
				},
			},
		});
		const name = node.metadata?.name;
		if (!name) {
			throw new Error("Expected node name");
		}

		try {
			const notOlderThanList = await core.listNode({
				resourceVersion: snapshotResourceVersion,
				resourceVersionMatch: "NotOlderThan",
			});

			expect(Number(notOlderThanList.metadata?.resourceVersion)).toBeGreaterThanOrEqual(
				Number(snapshotResourceVersion),
			);
			expect(notOlderThanList.items.map((node) => node.metadata?.name)).toContain(name);
		} finally {
			await core.deleteNode({ name });
		}
	});

	it("should be able to patch a node", async () => {
		const nodes = await core.listNode();
		const node = nodes.items.find((candidate) => candidate.metadata?.name);
		const nodeName = node?.metadata?.name;
		if (!nodeName) {
			throw new Error("Expected at least one node");
		}

		const patched = await core.patchNode(
			{
				name: nodeName,
				body: {
					metadata: {
						labels: {
							"webernetes.test/patch": "true",
						},
					},
				},
			},
			mergePatchOptions,
		);

		expect(patched.metadata?.name).toBe(nodeName);
		expect(patched.metadata?.labels?.["webernetes.test/patch"]).toBe("true");
	});

	it("should reject replacing a node with a stale resourceVersion", async () => {
		const node = await core.createNode({
			body: {
				metadata: {
					generateName: "replace-resource-version-conflict-",
					labels: { revision: "created" },
				},
			},
		});
		const name = node.metadata?.name;
		if (!name) {
			throw new Error("Expected node name");
		}

		try {
			const current = await core.readNode({ name });

			let replaceError: unknown;
			try {
				await core.replaceNode({
					name,
					body: {
						...current,
						metadata: {
							...current.metadata,
							resourceVersion: "1",
							labels: { revision: "stale" },
						},
					},
				});
			} catch (error) {
				replaceError = error;
			}

			expect(apiErrorCode(replaceError)).toBe(409);
			const unchanged = await core.readNode({ name });
			expect(unchanged.metadata?.labels?.revision).toBe("created");
		} finally {
			await core.deleteNode({ name });
		}
	});

	it("should allow replacing a node without a resourceVersion", async () => {
		const node = await core.createNode({
			body: {
				metadata: {
					generateName: "replace-without-resource-version-",
				},
				spec: {
					podCIDR: "10.244.250.0/24",
					podCIDRs: ["10.244.250.0/24"],
				},
			},
		});
		const name = node.metadata?.name;
		if (!name) {
			throw new Error("Expected node name");
		}

		try {
			const current = await core.readNode({ name });
			const { resourceVersion: _resourceVersion, ...metadata } = current.metadata ?? {};
			const replaced = await core.replaceNode({
				name,
				body: {
					...current,
					metadata: {
						...metadata,
						labels: { revision: "unconditional" },
					},
				},
			});

			expect(replaced.metadata?.labels?.revision).toBe("unconditional");
		} finally {
			await core.deleteNode({ name });
		}
	});

	it("should reject deleting a node with a stale resourceVersion precondition", async () => {
		const node = await core.createNode({
			body: {
				metadata: {
					generateName: "delete-resource-version-precondition-",
					labels: { revision: "created" },
				},
			},
		});
		const name = node.metadata?.name;
		if (!name) {
			throw new Error("Expected node name");
		}

		try {
			let deleteError: unknown;
			try {
				await core.deleteNode({
					name,
					body: {
						preconditions: {
							resourceVersion: "1",
						},
					},
				});
			} catch (error) {
				deleteError = error;
			}

			expect(apiErrorCode(deleteError)).toBe(409);
			const current = await core.readNode({ name });
			expect(current.metadata?.name).toBe(name);
		} finally {
			try {
				await core.deleteNode({ name });
			} catch {
				// If the simulator incorrectly ignores the stale precondition, the node
				// is already gone; keep the test failure focused on the precondition.
			}
		}
	});

	it("should reject patching a node name", async () => {
		const nodes = await core.listNode();
		const node = nodes.items.find((candidate) => candidate.metadata?.name);
		const nodeName = node?.metadata?.name;
		if (!nodeName) {
			throw new Error("Expected at least one node");
		}
		const changedName = `${nodeName}-changed`;

		await expect(
			core.patchNode(
				{
					name: nodeName,
					body: {
						metadata: {
							name: changedName,
						},
					},
				},
				mergePatchOptions,
			),
		).rejects.toThrow(
			`the name of the object (${changedName}) does not match the name on the URL (${nodeName})`,
		);
	});
});
