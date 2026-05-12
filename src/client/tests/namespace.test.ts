import { expect, it } from "vitest";
import { kubernetes } from "../../test/harnesses/kubernetes";
import { waitFor } from "../../test/wait";

kubernetes.describe("Namespaces", ({ core, k8s }) => {
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
			expect(namespace?.status?.phase).not.toBe("Active");
		});
	});

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
