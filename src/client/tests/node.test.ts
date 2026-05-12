import { expect, it } from "vitest";
import { kubernetes } from "../../test/harnesses/kubernetes";

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
