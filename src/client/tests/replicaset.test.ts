import { expect, it } from "vitest";
import { deepMerge } from "../../deep-merge";
import { kubernetes } from "../../test/harnesses/kubernetes";
import { apiErrorCode, apiStatusMessage } from "../../test/harnesses/helpers";
import type { DeepPartial } from "../../test/harnesses/helpers";
import type { V1Pod, V1ReplicaSet } from "../gen/models";

const podImage = "registry.k8s.io/pause:3.10";
const agnhostImage = "registry.k8s.io/e2e-test-images/agnhost:2.40";

kubernetes.describe("ReplicaSets", ({ apps, core, k8s, kubeConfig, helpers }) => {
	const { getTestNamespace, waitFor } = helpers;
	const mergePatchOptions = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch);

	async function createReplicaSet(
		replicaSet: DeepPartial<V1ReplicaSet> = {},
	): Promise<V1ReplicaSet> {
		const namespace = await getTestNamespace();
		return await apps.createNamespacedReplicaSet({
			namespace,
			body: deepMerge<V1ReplicaSet>(
				{
					metadata: {
						name: "test-rs",
					},
					spec: {
						selector: {
							matchLabels: {
								app: "test-rs",
							},
						},
						template: {
							metadata: {
								labels: {
									app: "test-rs",
								},
							},
							spec: {
								containers: [{ name: "pause", image: podImage }],
							},
						},
					},
				},
				replicaSet,
			),
		});
	}

	async function replacePodFinalizers(
		name: string,
		finalizers: string[],
		namespace: string,
	): Promise<void> {
		await waitFor(async () => {
			const pod = await core.readNamespacedPod({ namespace, name });
			pod.metadata ??= {};
			pod.metadata.finalizers = finalizers;
			try {
				await core.replaceNamespacedPod({ namespace, name, body: pod });
			} catch (error) {
				if (apiErrorCode(error) === 409) {
					throw new Error("Pod update conflict", { cause: error });
				}
				throw error;
			}
		});
	}

	async function activePods(namespace: string, labelSelector: string): Promise<V1Pod[]> {
		const pods = await core.listNamespacedPod({ namespace, labelSelector });
		return pods.items.filter((pod) => !pod.metadata?.deletionTimestamp);
	}

	function serverRestartCount(pod: V1Pod): number {
		const status = pod.status?.containerStatuses?.find((container) => container.name === "server");
		if (!status) {
			throw new Error(`Expected pod ${pod.metadata?.name ?? ""} to have server container status`);
		}
		return status.restartCount ?? 0;
	}

	it("should create, read, list, and delete a replicaset", async () => {
		const namespace = await getTestNamespace();
		const created = await createReplicaSet({ metadata: { name: "crud-rs" } });

		expect(created.apiVersion).toBe("apps/v1");
		expect(created.kind).toBe("ReplicaSet");
		expect(created.metadata?.namespace).toBe(namespace);
		expect(created.spec?.replicas).toBe(1);

		const read = await apps.readNamespacedReplicaSet({ namespace, name: "crud-rs" });
		expect(read.metadata?.name).toBe("crud-rs");

		const list = await apps.listNamespacedReplicaSet({ namespace });
		expect(list.metadata?.resourceVersion).toBeTruthy();
		expect(list.items.map((item) => item.metadata?.name)).toContain("crud-rs");

		await apps.deleteNamespacedReplicaSet({ namespace, name: "crud-rs" });
		await waitFor(async () => {
			const current = await apps.listNamespacedReplicaSet({ namespace });
			expect(current.items.find((item) => item.metadata?.name === "crud-rs")).toBeUndefined();
		});
	});

	it("should reject a selector that does not match the pod template", async () => {
		const namespace = await getTestNamespace();
		let createError: unknown;

		try {
			await createReplicaSet({
				metadata: { name: "selector-mismatch-rs" },
				spec: {
					selector: {
						matchLabels: {
							app: "selector-mismatch-rs",
						},
					},
					template: {
						metadata: {
							labels: {
								app: "different",
							},
						},
						spec: {
							containers: [{ name: "pause", image: podImage }],
						},
					},
				},
			});
		} catch (error) {
			createError = error;
		}

		expect(apiErrorCode(createError)).toBe(422);
		expect(apiStatusMessage(createError)).toBe(
			`ReplicaSet.apps "selector-mismatch-rs" is invalid: spec.template.metadata.labels: Invalid value: {"app":"different"}: \`selector\` does not match template \`labels\``,
		);

		const list = await apps.listNamespacedReplicaSet({ namespace });
		expect(
			list.items.find((item) => item.metadata?.name === "selector-mismatch-rs"),
		).toBeUndefined();
	});

	it("should reject negative replicas", async () => {
		let createError: unknown;

		try {
			await createReplicaSet({
				metadata: { name: "negative-replicas-rs" },
				spec: {
					replicas: -1,
				},
			});
		} catch (error) {
			createError = error;
		}

		expect(apiErrorCode(createError)).toBe(422);
		expect(apiStatusMessage(createError)).toBe(
			`ReplicaSet.apps "negative-replicas-rs" is invalid: spec.replicas: Invalid value: -1: must be greater than or equal to 0`,
		);
	});

	it("should reject selector changes", async () => {
		const namespace = await getTestNamespace();
		const created = await createReplicaSet({ metadata: { name: "immutable-selector-rs" } });
		if (!created.spec) {
			throw new Error("Expected ReplicaSet spec");
		}
		created.spec.selector = {
			matchLabels: {
				app: "changed",
			},
		};
		created.spec.template ??= {};
		created.spec.template.metadata ??= {};
		created.spec.template.metadata.labels = {
			app: "changed",
		};

		let updateError: unknown;
		try {
			await apps.replaceNamespacedReplicaSet({
				namespace,
				name: "immutable-selector-rs",
				body: created,
			});
		} catch (error) {
			updateError = error;
		}

		expect(apiErrorCode(updateError)).toBe(422);
		expect(apiStatusMessage(updateError)).toBe(
			`ReplicaSet.apps "immutable-selector-rs" is invalid: spec.selector: Invalid value: {"matchLabels":{"app":"changed"}}: field is immutable`,
		);
	});

	it("should update status through the status subresource only", async () => {
		const namespace = await getTestNamespace();
		await createReplicaSet({ metadata: { name: "status-rs" } });

		const replaced = await apps.replaceNamespacedReplicaSetStatus({
			namespace,
			name: "status-rs",
			body: {
				metadata: {
					name: "status-rs",
				},
				status: {
					replicas: 3,
					readyReplicas: 2,
				},
			},
		});
		expect(replaced.status?.replicas).toBe(3);
		expect(replaced.status?.readyReplicas).toBe(2);

		const patched = await apps.patchNamespacedReplicaSetStatus(
			{
				namespace,
				name: "status-rs",
				body: {
					spec: {
						replicas: 9,
					},
					status: {
						availableReplicas: 1,
					},
				},
			},
			mergePatchOptions,
		);
		expect(patched.spec?.replicas).toBe(1);
		expect(patched.status?.availableReplicas).toBe(1);
	});

	it("should expose and update the scale subresource", async () => {
		const namespace = await getTestNamespace();
		await createReplicaSet({
			metadata: { name: "scale-rs" },
			spec: {
				replicas: 2,
				selector: {
					matchLabels: {
						app: "scale-rs",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "scale-rs",
						},
					},
				},
			},
		});

		const scale = await apps.readNamespacedReplicaSetScale({ namespace, name: "scale-rs" });
		expect(scale.apiVersion).toBe("autoscaling/v1");
		expect(scale.kind).toBe("Scale");
		expect(scale.metadata?.name).toBe("scale-rs");
		expect(scale.spec?.replicas).toBe(2);
		expect(scale.status?.replicas).toBe(0);
		expect(scale.status?.selector).toBe("app=scale-rs");

		await apps.replaceNamespacedReplicaSetScale({
			namespace,
			name: "scale-rs",
			body: {
				metadata: {
					name: "scale-rs",
				},
				spec: {
					replicas: 4,
				},
			},
		});
		expect(
			(await apps.readNamespacedReplicaSet({ namespace, name: "scale-rs" })).spec?.replicas,
		).toBe(4);

		await apps.patchNamespacedReplicaSetScale(
			{
				namespace,
				name: "scale-rs",
				body: {
					spec: {
						replicas: 1,
					},
				},
			},
			mergePatchOptions,
		);
		expect(
			(await apps.readNamespacedReplicaSet({ namespace, name: "scale-rs" })).spec?.replicas,
		).toBe(1);
	});

	it("should create pods up to the desired replica count", async () => {
		const namespace = await getTestNamespace();
		await createReplicaSet({
			metadata: { name: "controller-rs" },
			spec: {
				replicas: 2,
				selector: {
					matchLabels: {
						app: "controller-rs",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "controller-rs",
						},
					},
					spec: {
						containers: [{ name: "pause", image: podImage }],
					},
				},
			},
		});

		await waitFor(async () => {
			const pods = await core.listNamespacedPod({
				namespace,
				labelSelector: "app=controller-rs",
			});
			expect(pods.items).toHaveLength(2);
			for (const pod of pods.items) {
				expect(pod.metadata?.ownerReferences?.[0]).toMatchObject({
					apiVersion: "apps/v1",
					kind: "ReplicaSet",
					name: "controller-rs",
					controller: true,
				});
			}
		});
	});

	it("should maintain the requested replica count after a replicaset pod is manually deleted", async () => {
		const namespace = await getTestNamespace();
		const desiredReplicas = 3;
		await createReplicaSet({
			metadata: { name: "pod-recreate-rs" },
			spec: {
				replicas: desiredReplicas,
				selector: {
					matchLabels: {
						app: "pod-recreate-rs",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "pod-recreate-rs",
						},
					},
					spec: {
						containers: [{ name: "pause", image: podImage }],
					},
				},
			},
		});

		let originalPodNames: string[] = [];
		await waitFor(async () => {
			const pods = await activePods(namespace, "app=pod-recreate-rs");
			expect(pods).toHaveLength(desiredReplicas);
			originalPodNames = pods.map((pod) => pod.metadata?.name ?? "").sort();
		});

		const deletedPodName = originalPodNames[0];
		expect(deletedPodName).toBeTruthy();
		await core.deleteNamespacedPod({ namespace, name: deletedPodName ?? "" });

		await waitFor(async () => {
			const pods = await activePods(namespace, "app=pod-recreate-rs");
			const podNames = pods.map((pod) => pod.metadata?.name ?? "").sort();
			expect(pods).toHaveLength(desiredReplicas);
			expect(podNames).not.toEqual(originalPodNames);
			expect(podNames.some((name) => !originalPodNames.includes(name))).toBe(true);
		});
	});

	it("should keep replicaset pod UIDs stable after liveness restarts containers", async () => {
		const namespace = await getTestNamespace();
		await createReplicaSet({
			metadata: { name: "liveness-restart-rs" },
			spec: {
				replicas: 2,
				selector: {
					matchLabels: {
						app: "liveness-restart-rs",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "liveness-restart-rs",
						},
					},
					spec: {
						containers: [
							{
								name: "server",
								image: agnhostImage,
								command: ["/agnhost", "netexec", "--http-port=8080"],
								ports: [{ name: "http", containerPort: 8080 }],
								livenessProbe: {
									httpGet: { path: "/echo?code=500", port: "http" },
									periodSeconds: 1,
									failureThreshold: 1,
								},
							},
						],
					},
				},
			},
		});

		let originalPodUIDs: string[] = [];
		await waitFor(async () => {
			const pods = await activePods(namespace, "app=liveness-restart-rs");
			expect(pods).toHaveLength(2);
			originalPodUIDs = pods.map((pod) => pod.metadata?.uid ?? "").sort();
			expect(originalPodUIDs.every(Boolean)).toBe(true);
		});

		await waitFor(async () => {
			const pods = await activePods(namespace, "app=liveness-restart-rs");
			const podUIDs = pods.map((pod) => pod.metadata?.uid ?? "").sort();
			expect(pods).toHaveLength(2);
			expect(podUIDs).toEqual(originalPodUIDs);
			expect(pods.some((pod) => serverRestartCount(pod) > 0)).toBe(true);
		});
	});

	it("should adopt matching orphan pods", async () => {
		const namespace = await getTestNamespace();
		await core.createNamespacedPod({
			namespace,
			body: {
				metadata: {
					name: "orphan-for-rs",
					labels: {
						app: "adopt-rs",
					},
				},
				spec: {
					containers: [{ name: "pause", image: podImage }],
				},
			},
		});
		await createReplicaSet({
			metadata: { name: "adopt-rs" },
			spec: {
				replicas: 1,
				selector: {
					matchLabels: {
						app: "adopt-rs",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "adopt-rs",
						},
					},
					spec: {
						containers: [{ name: "pause", image: podImage }],
					},
				},
			},
		});

		await waitFor(async () => {
			const pod = await core.readNamespacedPod({ namespace, name: "orphan-for-rs" });
			expect(pod.metadata?.ownerReferences?.[0]).toMatchObject({
				apiVersion: "apps/v1",
				kind: "ReplicaSet",
				name: "adopt-rs",
				controller: true,
			});
			const pods = await core.listNamespacedPod({ namespace, labelSelector: "app=adopt-rs" });
			expect(pods.items).toHaveLength(1);
		});
	});

	it("should not adopt pods controlled by another controller", async () => {
		const namespace = await getTestNamespace();
		const otherReplicaSet = await createReplicaSet({
			metadata: { name: "other-rs" },
			spec: {
				replicas: 1,
				selector: {
					matchLabels: {
						app: "no-steal-rs",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "no-steal-rs",
						},
					},
					spec: {
						containers: [{ name: "pause", image: podImage }],
					},
				},
			},
		});

		let controlledElsewhereName = "";
		await waitFor(async () => {
			const pods = await core.listNamespacedPod({ namespace, labelSelector: "app=no-steal-rs" });
			expect(pods.items).toHaveLength(1);
			const controlledElsewhere = pods.items[0];
			expect(controlledElsewhere?.metadata?.ownerReferences?.[0]).toMatchObject({
				name: "other-rs",
				uid: otherReplicaSet.metadata?.uid,
				controller: true,
			});
			controlledElsewhereName = controlledElsewhere?.metadata?.name ?? "";
			expect(controlledElsewhereName).toBeTruthy();
		});
		await createReplicaSet({
			metadata: { name: "no-steal-rs" },
			spec: {
				replicas: 1,
				selector: {
					matchLabels: {
						app: "no-steal-rs",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "no-steal-rs",
						},
					},
					spec: {
						containers: [{ name: "pause", image: podImage }],
					},
				},
			},
		});

		await waitFor(async () => {
			const pods = await core.listNamespacedPod({ namespace, labelSelector: "app=no-steal-rs" });
			expect(pods.items).toHaveLength(2);
			const controlledElsewhere = await core.readNamespacedPod({
				namespace,
				name: controlledElsewhereName,
			});
			expect(controlledElsewhere.metadata?.ownerReferences?.[0]).toMatchObject({
				name: "other-rs",
				uid: otherReplicaSet.metadata?.uid,
				controller: true,
			});
		});
	});

	it("should release controlled pods that no longer match the selector", async () => {
		const namespace = await getTestNamespace();
		await createReplicaSet({
			metadata: { name: "release-rs" },
			spec: {
				replicas: 1,
				selector: {
					matchLabels: {
						app: "release-rs",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "release-rs",
						},
					},
					spec: {
						containers: [{ name: "pause", image: podImage }],
					},
				},
			},
		});

		let podName = "";
		await waitFor(async () => {
			const pods = await core.listNamespacedPod({ namespace, labelSelector: "app=release-rs" });
			expect(pods.items).toHaveLength(1);
			podName = pods.items[0]?.metadata?.name ?? "";
			expect(podName).toBeTruthy();
		});

		const pod = await core.readNamespacedPod({ namespace, name: podName });
		pod.metadata ??= {};
		pod.metadata.labels = {
			app: "released",
		};
		await core.replaceNamespacedPod({ namespace, name: podName, body: pod });

		await waitFor(async () => {
			const released = await core.readNamespacedPod({ namespace, name: podName });
			expect(released.metadata?.ownerReferences ?? []).toHaveLength(0);

			const matchingPods = await core.listNamespacedPod({
				namespace,
				labelSelector: "app=release-rs",
			});
			expect(matchingPods.items).toHaveLength(1);
			expect(matchingPods.items[0]?.metadata?.name).not.toBe(podName);
			expect(matchingPods.items[0]?.metadata?.ownerReferences?.[0]).toMatchObject({
				apiVersion: "apps/v1",
				kind: "ReplicaSet",
				name: "release-rs",
				controller: true,
			});
		});
	});

	it("should not count ready pods as available before minReadySeconds elapses", async () => {
		const namespace = await getTestNamespace();
		await createReplicaSet({
			metadata: { name: "min-ready-rs" },
			spec: {
				minReadySeconds: 60,
				replicas: 1,
				selector: {
					matchLabels: {
						app: "min-ready-rs",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "min-ready-rs",
						},
					},
					spec: {
						containers: [{ name: "pause", image: podImage }],
					},
				},
			},
		});

		let podName = "";
		await waitFor(async () => {
			const pods = await core.listNamespacedPod({ namespace, labelSelector: "app=min-ready-rs" });
			expect(pods.items).toHaveLength(1);
			podName = pods.items[0]?.metadata?.name ?? "";
			expect(podName).toBeTruthy();
		});

		await core.patchNamespacedPodStatus(
			{
				namespace,
				name: podName,
				body: {
					status: {
						phase: "Running",
						conditions: [
							{
								type: "Ready",
								status: "True",
								lastTransitionTime: new Date(),
							},
						],
					},
				},
			},
			mergePatchOptions,
		);

		await waitFor(async () => {
			const replicaSet = await apps.readNamespacedReplicaSet({
				namespace,
				name: "min-ready-rs",
			});
			expect(replicaSet.status?.readyReplicas).toBe(1);
			expect(replicaSet.status?.availableReplicas ?? 0).toBe(0);
		});
	});

	it("should delete owned pods after deleting a replicaset with background propagation", async () => {
		const namespace = await getTestNamespace();
		await createReplicaSet({
			metadata: { name: "background-delete-rs" },
			spec: {
				replicas: 2,
				selector: {
					matchLabels: {
						app: "background-delete-rs",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "background-delete-rs",
						},
					},
					spec: {
						containers: [{ name: "pause", image: podImage }],
					},
				},
			},
		});

		await waitFor(async () => {
			const pods = await core.listNamespacedPod({
				namespace,
				labelSelector: "app=background-delete-rs",
			});
			expect(pods.items).toHaveLength(2);
		});

		await apps.deleteNamespacedReplicaSet({
			namespace,
			name: "background-delete-rs",
			propagationPolicy: "Background",
			body: {
				propagationPolicy: "Background",
			},
		});

		await waitFor(async () => {
			const pods = await core.listNamespacedPod({
				namespace,
				labelSelector: "app=background-delete-rs",
			});
			expect(pods.items).toHaveLength(0);
		});
	});

	it("should reject invalid delete propagation policies", async () => {
		const namespace = await getTestNamespace();
		await createReplicaSet({
			metadata: { name: "invalid-delete-policy-rs" },
			spec: {
				replicas: 0,
				selector: {
					matchLabels: {
						app: "invalid-delete-policy-rs",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "invalid-delete-policy-rs",
						},
					},
					spec: {
						containers: [{ name: "pause", image: podImage }],
					},
				},
			},
		});

		let deleteError: unknown;
		try {
			await apps.deleteNamespacedReplicaSet({
				namespace,
				name: "invalid-delete-policy-rs",
				propagationPolicy: "Never",
				body: {
					propagationPolicy: "Never",
				},
			});
		} catch (error) {
			deleteError = error;
		}

		expect(apiErrorCode(deleteError)).toBe(422);
		expect(apiStatusMessage(deleteError)).toBe(
			'DeleteOptions.meta.k8s.io "" is invalid: propagationPolicy: Unsupported value: "Never": supported values: "Foreground", "Background", "Orphan", "nil"',
		);
	});

	it("should reject delete options with both orphanDependents and propagationPolicy", async () => {
		const namespace = await getTestNamespace();
		await createReplicaSet({
			metadata: { name: "conflicting-delete-options-rs" },
			spec: {
				replicas: 0,
				selector: {
					matchLabels: {
						app: "conflicting-delete-options-rs",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "conflicting-delete-options-rs",
						},
					},
					spec: {
						containers: [{ name: "pause", image: podImage }],
					},
				},
			},
		});

		let deleteError: unknown;
		try {
			await apps.deleteNamespacedReplicaSet({
				namespace,
				name: "conflicting-delete-options-rs",
				orphanDependents: true,
				propagationPolicy: "Foreground",
				body: {
					orphanDependents: true,
					propagationPolicy: "Foreground",
				},
			});
		} catch (error) {
			deleteError = error;
		}

		expect(apiErrorCode(deleteError)).toBe(422);
		expect(apiStatusMessage(deleteError)).toBe(
			'DeleteOptions.meta.k8s.io "" is invalid: propagationPolicy: Invalid value: "Foreground": orphanDependents and deletionPropagation cannot be both set',
		);
	});

	it("should delete owned pods after deleting a replicaset with foreground propagation", async () => {
		const namespace = await getTestNamespace();
		await createReplicaSet({
			metadata: { name: "foreground-delete-rs" },
			spec: {
				replicas: 2,
				selector: {
					matchLabels: {
						app: "foreground-delete-rs",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "foreground-delete-rs",
						},
					},
					spec: {
						containers: [{ name: "pause", image: podImage }],
					},
				},
			},
		});

		await waitFor(async () => {
			const pods = await core.listNamespacedPod({
				namespace,
				labelSelector: "app=foreground-delete-rs",
			});
			expect(pods.items).toHaveLength(2);
		});

		await apps.deleteNamespacedReplicaSet({
			namespace,
			name: "foreground-delete-rs",
			propagationPolicy: "Foreground",
			body: {
				propagationPolicy: "Foreground",
			},
		});

		await waitFor(async () => {
			const replicaSets = await apps.listNamespacedReplicaSet({
				namespace,
				labelSelector: "app=foreground-delete-rs",
			});
			const pods = await core.listNamespacedPod({
				namespace,
				labelSelector: "app=foreground-delete-rs",
			});
			expect(replicaSets.items).toHaveLength(0);
			expect(pods.items).toHaveLength(0);
		});
	});

	it("should keep a foreground-deleting replicaset visible until blocking pod finalizers clear", async () => {
		const namespace = await getTestNamespace();
		await createReplicaSet({
			metadata: { name: "foreground-blocked-rs" },
			spec: {
				replicas: 1,
				selector: {
					matchLabels: {
						app: "foreground-blocked-rs",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "foreground-blocked-rs",
						},
					},
					spec: {
						containers: [{ name: "pause", image: podImage }],
					},
				},
			},
		});

		let podName = "";
		await waitFor(async () => {
			const pods = await core.listNamespacedPod({
				namespace,
				labelSelector: "app=foreground-blocked-rs",
			});
			expect(pods.items).toHaveLength(1);
			podName = pods.items[0]?.metadata?.name ?? "";
			expect(podName).toBeTruthy();
		});

		await replacePodFinalizers(podName, ["example.com/hold"], namespace);

		await apps.deleteNamespacedReplicaSet({
			namespace,
			name: "foreground-blocked-rs",
			propagationPolicy: "Foreground",
			body: {
				propagationPolicy: "Foreground",
			},
		});

		await waitFor(async () => {
			const replicaSet = await apps.readNamespacedReplicaSet({
				namespace,
				name: "foreground-blocked-rs",
			});
			expect(replicaSet.metadata?.deletionTimestamp).toBeDefined();
			expect(replicaSet.metadata?.finalizers).toContain("foregroundDeletion");

			const deletingPod = await core.readNamespacedPod({ namespace, name: podName });
			expect(deletingPod.metadata?.deletionTimestamp).toBeDefined();
			expect(deletingPod.metadata?.finalizers).toContain("example.com/hold");
		});

		await replacePodFinalizers(podName, [], namespace);

		await waitFor(async () => {
			const replicaSets = await apps.listNamespacedReplicaSet({
				namespace,
				labelSelector: "app=foreground-blocked-rs",
			});
			const pods = await core.listNamespacedPod({
				namespace,
				labelSelector: "app=foreground-blocked-rs",
			});
			expect(replicaSets.items).toHaveLength(0);
			expect(pods.items).toHaveLength(0);
		});
	});

	it("should orphan owned pods after deleting a replicaset with orphan propagation", async () => {
		const namespace = await getTestNamespace();
		await createReplicaSet({
			metadata: { name: "orphan-delete-rs" },
			spec: {
				replicas: 1,
				selector: {
					matchLabels: {
						app: "orphan-delete-rs",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "orphan-delete-rs",
						},
					},
					spec: {
						containers: [{ name: "pause", image: podImage }],
					},
				},
			},
		});

		let podName = "";
		await waitFor(async () => {
			const pods = await core.listNamespacedPod({
				namespace,
				labelSelector: "app=orphan-delete-rs",
			});
			expect(pods.items).toHaveLength(1);
			podName = pods.items[0]?.metadata?.name ?? "";
			expect(podName).toBeTruthy();
		});

		await apps.deleteNamespacedReplicaSet({
			namespace,
			name: "orphan-delete-rs",
			propagationPolicy: "Orphan",
			body: {
				propagationPolicy: "Orphan",
			},
		});

		await waitFor(async () => {
			const pod = await core.readNamespacedPod({ namespace, name: podName });
			expect(pod.metadata?.ownerReferences ?? []).toHaveLength(0);
		});
	});

	it("should honor an existing orphan finalizer when deleting a replicaset without delete options", async () => {
		const namespace = await getTestNamespace();
		await createReplicaSet({
			metadata: {
				name: "existing-orphan-finalizer-rs",
				finalizers: ["orphan"],
			},
			spec: {
				replicas: 1,
				selector: {
					matchLabels: {
						app: "existing-orphan-finalizer-rs",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "existing-orphan-finalizer-rs",
						},
					},
					spec: {
						containers: [{ name: "pause", image: podImage }],
					},
				},
			},
		});

		let podName = "";
		await waitFor(async () => {
			const pods = await core.listNamespacedPod({
				namespace,
				labelSelector: "app=existing-orphan-finalizer-rs",
			});
			expect(pods.items).toHaveLength(1);
			podName = pods.items[0]?.metadata?.name ?? "";
			expect(podName).toBeTruthy();
		});

		await apps.deleteNamespacedReplicaSet({
			namespace,
			name: "existing-orphan-finalizer-rs",
		});

		await waitFor(async () => {
			const pod = await core.readNamespacedPod({ namespace, name: podName });
			expect(pod.metadata?.ownerReferences ?? []).toHaveLength(0);
			const replicaSets = await apps.listNamespacedReplicaSet({
				namespace,
				labelSelector: "app=existing-orphan-finalizer-rs",
			});
			expect(replicaSets.items).toHaveLength(0);
		});
	});

	it("should watch replicasets under the apps/v1 path", async () => {
		const namespace = await getTestNamespace();
		const events: Array<{ phase: string; obj: V1ReplicaSet }> = [];
		const watch = new k8s.Watch(kubeConfig);
		const controller = await watch.watch(
			`/apis/apps/v1/namespaces/${namespace}/replicasets`,
			{},
			(phase, obj) => {
				events.push({ phase, obj: obj as V1ReplicaSet });
			},
			() => undefined,
		);

		try {
			await createReplicaSet({ metadata: { name: "watched-rs" } });
			await waitFor(() => {
				expect(events).toContainEqual({
					phase: "ADDED",
					obj: expect.objectContaining({
						metadata: expect.objectContaining({
							name: "watched-rs",
							namespace,
						}),
					}),
				});
			});
		} finally {
			controller.abort();
		}
	});
});
