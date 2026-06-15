import { expect, it } from "vitest";
import { deepMerge } from "../../deep-merge";
import { kubernetes } from "../../test/harnesses/kubernetes";
import { apiErrorCode, apiStatusMessage } from "../../test/harnesses/helpers";
import type { DeepPartial } from "../../test/harnesses/helpers";
import type { V1Deployment, V1Pod, V1ReplicaSet } from "../gen/models";

const podImage = "registry.k8s.io/pause:3.10";
const agnhostImage = "registry.k8s.io/e2e-test-images/agnhost:2.40";

kubernetes.describe("Deployments", ({ apps, core, k8s, kubeConfig, helpers }) => {
	const { getTestNamespace, waitFor } = helpers;
	const mergePatchOptions = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch);

	async function createDeployment(
		deployment: DeepPartial<V1Deployment> = {},
	): Promise<V1Deployment> {
		const namespace = await getTestNamespace();
		return await apps.createNamespacedDeployment({
			namespace,
			body: deepMerge<V1Deployment>(
				{
					metadata: {
						name: "test-deployment",
					},
					spec: {
						selector: {
							matchLabels: {
								app: "test-deployment",
							},
						},
						template: {
							metadata: {
								labels: {
									app: "test-deployment",
								},
							},
							spec: {
								containers: [{ name: "pause", image: podImage }],
							},
						},
					},
				},
				deployment,
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

	async function deploymentReplicaSets(
		namespace: string,
		labelSelector: string,
	): Promise<V1ReplicaSet[]> {
		const replicaSets = await apps.listNamespacedReplicaSet({ namespace, labelSelector });
		return replicaSets.items;
	}

	async function updateDeployment(
		namespace: string,
		name: string,
		mutate: (deployment: V1Deployment) => void,
	): Promise<void> {
		await waitFor(async () => {
			const deployment = await apps.readNamespacedDeployment({ namespace, name });
			mutate(deployment);
			try {
				await apps.replaceNamespacedDeployment({ namespace, name, body: deployment });
			} catch (error) {
				if (apiErrorCode(error) === 409) {
					throw new Error("Deployment update conflict", { cause: error });
				}
				throw error;
			}
		});
	}

	function replicaSetsByTemplateImage(replicaSets: V1ReplicaSet[], image: string): V1ReplicaSet[] {
		return replicaSets.filter(
			(replicaSet) => replicaSet.spec?.template?.spec?.containers?.[0]?.image === image,
		);
	}

	function serverRestartCount(pod: V1Pod): number {
		const status = pod.status?.containerStatuses?.find((container) => container.name === "server");
		if (!status) {
			throw new Error(`Expected pod ${pod.metadata?.name ?? ""} to have server container status`);
		}
		return status.restartCount ?? 0;
	}

	it("should create, read, list, and delete a deployment", async () => {
		const namespace = await getTestNamespace();
		const created = await createDeployment({ metadata: { name: "crud-deployment" } });

		expect(created.apiVersion).toBe("apps/v1");
		expect(created.kind).toBe("Deployment");
		expect(created.metadata?.namespace).toBe(namespace);
		expect(created.spec?.replicas).toBe(1);
		expect(created.spec?.strategy?.type).toBe("RollingUpdate");
		expect(created.spec?.strategy?.rollingUpdate?.maxUnavailable).toBe("25%");
		expect(created.spec?.strategy?.rollingUpdate?.maxSurge).toBe("25%");
		expect(created.spec?.revisionHistoryLimit).toBe(10);
		expect(created.spec?.progressDeadlineSeconds).toBe(600);

		const read = await apps.readNamespacedDeployment({ namespace, name: "crud-deployment" });
		expect(read.metadata?.name).toBe("crud-deployment");

		const list = await apps.listNamespacedDeployment({ namespace });
		expect(list.metadata?.resourceVersion).toBeTruthy();
		expect(list.items.map((item) => item.metadata?.name)).toContain("crud-deployment");

		await apps.deleteNamespacedDeployment({ namespace, name: "crud-deployment" });
		await waitFor(async () => {
			const current = await apps.listNamespacedDeployment({ namespace });
			expect(
				current.items.find((item) => item.metadata?.name === "crud-deployment"),
			).toBeUndefined();
		});
	});

	it("should reject a selector that does not match the pod template", async () => {
		let createError: unknown;

		try {
			await createDeployment({
				metadata: { name: "selector-mismatch-deployment" },
				spec: {
					selector: {
						matchLabels: {
							app: "selector-mismatch-deployment",
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
			`Deployment.apps "selector-mismatch-deployment" is invalid: spec.template.metadata.labels: Invalid value: {"app":"different"}: \`selector\` does not match template \`labels\``,
		);
	});

	it("should reject negative replicas", async () => {
		let createError: unknown;

		try {
			await createDeployment({
				metadata: { name: "negative-replicas-deployment" },
				spec: {
					replicas: -1,
				},
			});
		} catch (error) {
			createError = error;
		}

		expect(apiErrorCode(createError)).toBe(422);
		expect(apiStatusMessage(createError)).toBe(
			`Deployment.apps "negative-replicas-deployment" is invalid: spec.replicas: Invalid value: -1: must be greater than or equal to 0`,
		);
	});

	it("should reject progress deadlines that are not greater than minReadySeconds", async () => {
		let createError: unknown;

		try {
			await createDeployment({
				metadata: { name: "progress-deadline-deployment" },
				spec: {
					minReadySeconds: 10,
					progressDeadlineSeconds: 10,
				},
			});
		} catch (error) {
			createError = error;
		}

		expect(apiErrorCode(createError)).toBe(422);
		expect(apiStatusMessage(createError)).toBe(
			`Deployment.apps "progress-deadline-deployment" is invalid: spec.progressDeadlineSeconds: Invalid value: 10: must be greater than minReadySeconds`,
		);
	});

	it("should reject selector changes", async () => {
		const namespace = await getTestNamespace();
		await createDeployment({ metadata: { name: "immutable-selector-deployment" } });
		let updateError: unknown;
		await waitFor(async () => {
			const current = await apps.readNamespacedDeployment({
				namespace,
				name: "immutable-selector-deployment",
			});
			if (!current.spec) {
				throw new Error("Expected deployment spec");
			}
			current.spec.selector = {
				matchLabels: {
					app: "changed",
				},
			};
			current.spec.template.metadata ??= {};
			current.spec.template.metadata.labels = {
				app: "changed",
			};
			try {
				await apps.replaceNamespacedDeployment({
					namespace,
					name: "immutable-selector-deployment",
					body: current,
				});
			} catch (error) {
				updateError = error;
			}
			expect(apiErrorCode(updateError)).toBe(422);
		});

		expect(apiErrorCode(updateError)).toBe(422);
		expect(apiStatusMessage(updateError)).toBe(
			`Deployment.apps "immutable-selector-deployment" is invalid: spec.selector: Invalid value: {"matchLabels":{"app":"changed"}}: field is immutable`,
		);
	});

	it("should update status through the status subresource only", async () => {
		const namespace = await getTestNamespace();
		await createDeployment({ metadata: { name: "status-deployment" } });

		const replaced = await apps.replaceNamespacedDeploymentStatus({
			namespace,
			name: "status-deployment",
			body: {
				metadata: {
					name: "status-deployment",
				},
				status: {
					replicas: 3,
					readyReplicas: 2,
				},
			},
		});
		expect(replaced.status?.replicas).toBe(3);
		expect(replaced.status?.readyReplicas).toBe(2);

		const patched = await apps.patchNamespacedDeploymentStatus(
			{
				namespace,
				name: "status-deployment",
				body: {
					// Status subresource updates must not accept spec changes.
					spec: {
						replicas: 9,
					},
					status: {
						replicas: 3,
						readyReplicas: 2,
						// This is the only new field in this patch that should persist.
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
		await createDeployment({
			metadata: { name: "scale-deployment" },
			spec: {
				replicas: 2,
				selector: {
					matchLabels: {
						app: "scale-deployment",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "scale-deployment",
						},
					},
				},
			},
		});

		const scale = await apps.readNamespacedDeploymentScale({
			namespace,
			name: "scale-deployment",
		});
		expect(scale.apiVersion).toBe("autoscaling/v1");
		expect(scale.kind).toBe("Scale");
		expect(scale.metadata?.name).toBe("scale-deployment");
		expect(scale.spec?.replicas).toBe(2);
		expect(scale.status?.replicas).toBe(0);
		expect(scale.status?.selector).toBe("app=scale-deployment");

		await apps.replaceNamespacedDeploymentScale({
			namespace,
			name: "scale-deployment",
			body: {
				metadata: {
					name: "scale-deployment",
				},
				spec: {
					replicas: 4,
				},
			},
		});
		expect(
			(await apps.readNamespacedDeployment({ namespace, name: "scale-deployment" })).spec?.replicas,
		).toBe(4);

		await apps.patchNamespacedDeploymentScale(
			{
				namespace,
				name: "scale-deployment",
				body: {
					spec: {
						replicas: 1,
					},
				},
			},
			mergePatchOptions,
		);
		expect(
			(await apps.readNamespacedDeployment({ namespace, name: "scale-deployment" })).spec?.replicas,
		).toBe(1);
	});

	it("should create a replicaset and pods for a deployment", async () => {
		const namespace = await getTestNamespace();
		await createDeployment({
			metadata: { name: "controller-deployment" },
			spec: {
				replicas: 2,
				selector: {
					matchLabels: {
						app: "controller-deployment",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "controller-deployment",
						},
					},
					spec: {
						containers: [{ name: "pause", image: podImage }],
					},
				},
			},
		});

		await waitFor(async () => {
			const replicaSets = await apps.listNamespacedReplicaSet({
				namespace,
				labelSelector: "app=controller-deployment",
			});
			expect(replicaSets.items).toHaveLength(1);
			const replicaSet = replicaSets.items[0];
			if (!replicaSet) {
				throw new Error("Expected deployment ReplicaSet");
			}
			expect(replicaSet.metadata?.labels?.["pod-template-hash"]).toBeTruthy();
			expect(replicaSet.metadata?.ownerReferences?.[0]).toMatchObject({
				apiVersion: "apps/v1",
				kind: "Deployment",
				name: "controller-deployment",
				controller: true,
			});

			const pods = await core.listNamespacedPod({
				namespace,
				labelSelector: "app=controller-deployment",
			});
			expect(pods.items).toHaveLength(2);
		});
	});

	it("should recreate a manually deleted deployment pod", async () => {
		const namespace = await getTestNamespace();
		await createDeployment({
			metadata: { name: "pod-recreate-deployment" },
			spec: {
				replicas: 2,
				selector: {
					matchLabels: {
						app: "pod-recreate-deployment",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "pod-recreate-deployment",
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
			const pods = await activePods(namespace, "app=pod-recreate-deployment");
			expect(pods).toHaveLength(2);
			originalPodNames = pods.map((pod) => pod.metadata?.name ?? "").sort();
		});

		await core.deleteNamespacedPod({ namespace, name: originalPodNames[0] ?? "" });

		await waitFor(async () => {
			const pods = await activePods(namespace, "app=pod-recreate-deployment");
			const podNames = pods.map((pod) => pod.metadata?.name ?? "").sort();
			expect(pods).toHaveLength(2);
			expect(podNames).not.toEqual(originalPodNames);
			expect(podNames.some((name) => !originalPodNames.includes(name))).toBe(true);
		});
	});

	it("should keep deployment pod UIDs stable after liveness restarts containers", async () => {
		const namespace = await getTestNamespace();
		await createDeployment({
			metadata: { name: "liveness-restart-deployment" },
			spec: {
				replicas: 2,
				selector: {
					matchLabels: {
						app: "liveness-restart-deployment",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "liveness-restart-deployment",
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
			const pods = await activePods(namespace, "app=liveness-restart-deployment");
			expect(pods).toHaveLength(2);
			originalPodUIDs = pods.map((pod) => pod.metadata?.uid ?? "").sort();
			expect(originalPodUIDs.every(Boolean)).toBe(true);
		});

		await waitFor(async () => {
			const pods = await activePods(namespace, "app=liveness-restart-deployment");
			const podUIDs = pods.map((pod) => pod.metadata?.uid ?? "").sort();
			expect(pods).toHaveLength(2);
			expect(podUIDs).toEqual(originalPodUIDs);
			expect(pods.some((pod) => serverRestartCount(pod) > 0)).toBe(true);
		});
	});

	it("should adopt and reuse an existing matching replicaset", async () => {
		const namespace = await getTestNamespace();
		await apps.createNamespacedReplicaSet({
			namespace,
			body: {
				metadata: {
					name: "adopt-existing-rs",
					labels: {
						app: "adopt-existing",
					},
				},
				spec: {
					replicas: 0,
					selector: {
						matchLabels: {
							app: "adopt-existing",
						},
					},
					template: {
						metadata: {
							labels: {
								app: "adopt-existing",
							},
						},
						spec: {
							containers: [{ name: "pause", image: podImage }],
						},
					},
				},
			},
		});

		await createDeployment({
			metadata: { name: "adopt-existing" },
			spec: {
				replicas: 2,
				selector: {
					matchLabels: {
						app: "adopt-existing",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "adopt-existing",
						},
					},
					spec: {
						containers: [{ name: "pause", image: podImage }],
					},
				},
			},
		});

		await waitFor(async () => {
			const replicaSets = await apps.listNamespacedReplicaSet({
				namespace,
				labelSelector: "app=adopt-existing",
			});
			expect(replicaSets.items).toHaveLength(1);
			expect(replicaSets.items[0]?.metadata?.name).toBe("adopt-existing-rs");
			expect(replicaSets.items[0]?.metadata?.ownerReferences?.[0]).toMatchObject({
				apiVersion: "apps/v1",
				kind: "Deployment",
				name: "adopt-existing",
				controller: true,
			});
			expect(replicaSets.items[0]?.spec?.replicas).toBe(2);
		});
	});

	it("should retain old replicasets after a template update by default", async () => {
		const namespace = await getTestNamespace();
		await createDeployment({
			metadata: { name: "rollout-deployment" },
			spec: {
				replicas: 2,
				selector: {
					matchLabels: {
						app: "rollout-deployment",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "rollout-deployment",
							version: "one",
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
				labelSelector: "app=rollout-deployment",
			});
			expect(pods.items).toHaveLength(2);
		});

		const deployment = await apps.readNamespacedDeployment({
			namespace,
			name: "rollout-deployment",
		});
		if (!deployment.spec) {
			throw new Error("Expected deployment spec");
		}
		deployment.spec.template.metadata ??= {};
		deployment.spec.template.metadata.labels = {
			app: "rollout-deployment",
			version: "two",
		};
		await apps.replaceNamespacedDeployment({
			namespace,
			name: "rollout-deployment",
			body: deployment,
		});

		await waitFor(async () => {
			const replicaSets = await apps.listNamespacedReplicaSet({
				namespace,
				labelSelector: "app=rollout-deployment",
			});
			const newReplicaSets = replicaSets.items.filter(
				(replicaSet) => replicaSet.spec?.template?.metadata?.labels?.version === "two",
			);
			const oldReplicaSets = replicaSets.items.filter(
				(replicaSet) => replicaSet.spec?.template?.metadata?.labels?.version === "one",
			);
			expect(replicaSets.items).toHaveLength(2);
			expect(newReplicaSets).toHaveLength(1);
			expect(oldReplicaSets).toHaveLength(1);
			expect(newReplicaSets[0]?.spec?.replicas).toBe(2);
			expect(oldReplicaSets[0]?.spec?.replicas).toBe(0);
		});
	});

	it("should clean up old replicasets after a template update when revision history is zero", async () => {
		const namespace = await getTestNamespace();
		await createDeployment({
			metadata: { name: "rollout-cleanup-deployment" },
			spec: {
				replicas: 2,
				revisionHistoryLimit: 0,
				selector: {
					matchLabels: {
						app: "rollout-cleanup-deployment",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "rollout-cleanup-deployment",
							version: "one",
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
				labelSelector: "app=rollout-cleanup-deployment",
			});
			expect(pods.items).toHaveLength(2);
		});

		const deployment = await apps.readNamespacedDeployment({
			namespace,
			name: "rollout-cleanup-deployment",
		});
		if (!deployment.spec) {
			throw new Error("Expected deployment spec");
		}
		deployment.spec.template.metadata ??= {};
		deployment.spec.template.metadata.labels = {
			app: "rollout-cleanup-deployment",
			version: "two",
		};
		await apps.replaceNamespacedDeployment({
			namespace,
			name: "rollout-cleanup-deployment",
			body: deployment,
		});

		await waitFor(async () => {
			const replicaSets = await apps.listNamespacedReplicaSet({
				namespace,
				labelSelector: "app=rollout-cleanup-deployment",
			});
			const newReplicaSets = replicaSets.items.filter(
				(replicaSet) => replicaSet.spec?.template?.metadata?.labels?.version === "two",
			);
			const oldReplicaSets = replicaSets.items.filter(
				(replicaSet) => replicaSet.spec?.template?.metadata?.labels?.version === "one",
			);
			expect(replicaSets.items).toHaveLength(1);
			expect(newReplicaSets).toHaveLength(1);
			expect(oldReplicaSets).toHaveLength(0);
			expect(newReplicaSets[0]?.spec?.replicas).toBe(2);
		});
	});

	it("should replace every pod when a deployment image changes", async () => {
		const namespace = await getTestNamespace();
		const oldImage = "registry.k8s.io/pause:3.10";
		const newImage = "registry.k8s.io/pause:3.9";
		await createDeployment({
			metadata: { name: "image-rollout-deployment" },
			spec: {
				replicas: 2,
				selector: {
					matchLabels: {
						app: "image-rollout-deployment",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "image-rollout-deployment",
						},
					},
					spec: {
						containers: [{ name: "pause", image: oldImage }],
					},
				},
			},
		});

		let oldPodUIDs: string[] = [];
		await waitFor(async () => {
			const pods = await activePods(namespace, "app=image-rollout-deployment");
			expect(pods).toHaveLength(2);
			expect(pods.every((pod) => pod.spec?.containers?.[0]?.image === oldImage)).toBe(true);
			oldPodUIDs = pods.map((pod) => pod.metadata?.uid ?? "");
			expect(oldPodUIDs.every(Boolean)).toBe(true);
		});

		await updateDeployment(namespace, "image-rollout-deployment", (deployment) => {
			if (!deployment.spec?.template.spec?.containers?.[0]) {
				throw new Error("Expected deployment container");
			}
			deployment.spec.template.spec.containers[0].image = newImage;
		});

		await waitFor(async () => {
			const pods = await activePods(namespace, "app=image-rollout-deployment");
			expect(pods).toHaveLength(2);
			expect(pods.every((pod) => pod.spec?.containers?.[0]?.image === newImage)).toBe(true);
			expect(pods.some((pod) => oldPodUIDs.includes(pod.metadata?.uid ?? ""))).toBe(false);
		});
	});

	it("should replace every pod when a deployment template annotation changes", async () => {
		const namespace = await getTestNamespace();
		const restartedAt = "2026-06-12T12:00:00Z";
		await createDeployment({
			metadata: { name: "restart-rollout-deployment" },
			spec: {
				replicas: 2,
				selector: {
					matchLabels: {
						app: "restart-rollout-deployment",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "restart-rollout-deployment",
						},
					},
				},
			},
		});

		let oldPodUIDs: string[] = [];
		await waitFor(async () => {
			const pods = await activePods(namespace, "app=restart-rollout-deployment");
			expect(pods).toHaveLength(2);
			oldPodUIDs = pods.map((pod) => pod.metadata?.uid ?? "");
			expect(oldPodUIDs.every(Boolean)).toBe(true);
		});

		await updateDeployment(namespace, "restart-rollout-deployment", (deployment) => {
			if (!deployment.spec) {
				throw new Error("Expected deployment spec");
			}
			deployment.spec.template.metadata ??= {};
			deployment.spec.template.metadata.annotations ??= {};
			deployment.spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"] =
				restartedAt;
		});

		await waitFor(async () => {
			const pods = await activePods(namespace, "app=restart-rollout-deployment");
			expect(pods).toHaveLength(2);
			expect(pods.some((pod) => oldPodUIDs.includes(pod.metadata?.uid ?? ""))).toBe(false);
			expect(
				pods.every(
					(pod) => pod.metadata?.annotations?.["kubectl.kubernetes.io/restartedAt"] === restartedAt,
				),
			).toBe(true);
		});
	});

	it("should not create replacement pods for a recreate deployment until old pods are gone", async () => {
		const namespace = await getTestNamespace();
		const oldImage = "registry.k8s.io/pause:3.10";
		const newImage = "registry.k8s.io/pause:3.9";
		await createDeployment({
			metadata: { name: "recreate-rollout-deployment" },
			spec: {
				replicas: 2,
				strategy: {
					type: "Recreate",
				},
				selector: {
					matchLabels: {
						app: "recreate-rollout-deployment",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "recreate-rollout-deployment",
						},
					},
					spec: {
						containers: [{ name: "pause", image: oldImage }],
					},
				},
			},
		});

		let oldPodNames: string[] = [];
		await waitFor(async () => {
			const pods = await activePods(namespace, "app=recreate-rollout-deployment");
			expect(pods).toHaveLength(2);
			oldPodNames = pods.map((pod) => pod.metadata?.name ?? "");
			expect(oldPodNames.every(Boolean)).toBe(true);
		});
		for (const podName of oldPodNames) {
			await replacePodFinalizers(podName, ["example.com/hold"], namespace);
		}

		await updateDeployment(namespace, "recreate-rollout-deployment", (deployment) => {
			if (!deployment.spec?.template.spec?.containers?.[0]) {
				throw new Error("Expected deployment container");
			}
			deployment.spec.template.spec.containers[0].image = newImage;
		});

		await waitFor(async () => {
			const replicaSets = await deploymentReplicaSets(namespace, "app=recreate-rollout-deployment");
			const oldReplicaSets = replicaSetsByTemplateImage(replicaSets, oldImage);
			expect(oldReplicaSets).toHaveLength(1);
			expect(oldReplicaSets[0]?.spec?.replicas).toBe(0);
			expect(replicaSetsByTemplateImage(replicaSets, newImage)).toHaveLength(0);

			const pods = await core.listNamespacedPod({
				namespace,
				labelSelector: "app=recreate-rollout-deployment",
			});
			expect(pods.items.filter((pod) => !pod.metadata?.deletionTimestamp)).toHaveLength(0);
			for (const podName of oldPodNames) {
				const pod = pods.items.find((item) => item.metadata?.name === podName);
				expect(pod?.metadata?.deletionTimestamp).toBeTruthy();
			}
		});

		for (const podName of oldPodNames) {
			await replacePodFinalizers(podName, [], namespace);
		}

		await waitFor(async () => {
			const pods = await activePods(namespace, "app=recreate-rollout-deployment");
			expect(pods).toHaveLength(2);
			expect(pods.every((pod) => pod.spec?.containers?.[0]?.image === newImage)).toBe(true);
		});
	});

	it("should limit rolling update scale-up by maxSurge percent", async () => {
		const namespace = await getTestNamespace();
		const oldImage = "registry.k8s.io/pause:3.10";
		const newImage = "registry.k8s.io/webernetes/does-not-exist:404";
		await createDeployment({
			metadata: { name: "surge-percent-deployment" },
			spec: {
				replicas: 4,
				strategy: {
					type: "RollingUpdate",
					rollingUpdate: {
						maxSurge: "50%",
						maxUnavailable: 0,
					},
				},
				selector: {
					matchLabels: {
						app: "surge-percent-deployment",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "surge-percent-deployment",
						},
					},
					spec: {
						containers: [{ name: "pause", image: oldImage }],
					},
				},
			},
		});

		await waitFor(async () => {
			const pods = await activePods(namespace, "app=surge-percent-deployment");
			expect(pods).toHaveLength(4);
		});

		await updateDeployment(namespace, "surge-percent-deployment", (deployment) => {
			if (!deployment.spec?.template.spec?.containers?.[0]) {
				throw new Error("Expected deployment container");
			}
			deployment.spec.template.spec.containers[0].image = newImage;
		});

		await waitFor(async () => {
			const replicaSets = await deploymentReplicaSets(namespace, "app=surge-percent-deployment");
			const oldReplicaSets = replicaSetsByTemplateImage(replicaSets, oldImage);
			const newReplicaSets = replicaSetsByTemplateImage(replicaSets, newImage);
			expect(oldReplicaSets).toHaveLength(1);
			expect(newReplicaSets).toHaveLength(1);
			expect(oldReplicaSets[0]?.spec?.replicas).toBe(4);
			expect(newReplicaSets[0]?.spec?.replicas).toBe(2);
		});
	});

	it("should use maxUnavailable percent when rolling update cannot surge", async () => {
		const namespace = await getTestNamespace();
		const oldImage = "registry.k8s.io/pause:3.10";
		const newImage = "registry.k8s.io/webernetes/does-not-exist:404";
		await createDeployment({
			metadata: { name: "unavailable-percent-deployment" },
			spec: {
				replicas: 4,
				strategy: {
					type: "RollingUpdate",
					rollingUpdate: {
						maxSurge: 0,
						maxUnavailable: "50%",
					},
				},
				selector: {
					matchLabels: {
						app: "unavailable-percent-deployment",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "unavailable-percent-deployment",
						},
					},
					spec: {
						containers: [{ name: "pause", image: oldImage }],
					},
				},
			},
		});

		await waitFor(async () => {
			const pods = await activePods(namespace, "app=unavailable-percent-deployment");
			expect(pods).toHaveLength(4);
		});

		await updateDeployment(namespace, "unavailable-percent-deployment", (deployment) => {
			if (!deployment.spec?.template.spec?.containers?.[0]) {
				throw new Error("Expected deployment container");
			}
			deployment.spec.template.spec.containers[0].image = newImage;
		});

		await waitFor(async () => {
			const replicaSets = await deploymentReplicaSets(
				namespace,
				"app=unavailable-percent-deployment",
			);
			const oldReplicaSets = replicaSetsByTemplateImage(replicaSets, oldImage);
			const newReplicaSets = replicaSetsByTemplateImage(replicaSets, newImage);
			expect(oldReplicaSets).toHaveLength(1);
			expect(newReplicaSets).toHaveLength(1);
			expect(oldReplicaSets[0]?.spec?.replicas).toBe(2);
			expect(newReplicaSets[0]?.spec?.replicas).toBe(2);
		});
	});

	it("should delete owned replicasets and pods after deleting a deployment with background propagation", async () => {
		const namespace = await getTestNamespace();
		await createDeployment({
			metadata: { name: "background-delete-deployment" },
			spec: {
				replicas: 2,
				selector: {
					matchLabels: {
						app: "background-delete-deployment",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "background-delete-deployment",
						},
					},
					spec: {
						containers: [{ name: "pause", image: podImage }],
					},
				},
			},
		});

		await waitFor(async () => {
			const replicaSets = await apps.listNamespacedReplicaSet({
				namespace,
				labelSelector: "app=background-delete-deployment",
			});
			const pods = await core.listNamespacedPod({
				namespace,
				labelSelector: "app=background-delete-deployment",
			});
			expect(replicaSets.items).toHaveLength(1);
			expect(pods.items).toHaveLength(2);
		});

		await apps.deleteNamespacedDeployment({
			namespace,
			name: "background-delete-deployment",
			propagationPolicy: "Background",
			body: {
				propagationPolicy: "Background",
			},
		});

		await waitFor(async () => {
			const replicaSets = await apps.listNamespacedReplicaSet({
				namespace,
				labelSelector: "app=background-delete-deployment",
			});
			const pods = await core.listNamespacedPod({
				namespace,
				labelSelector: "app=background-delete-deployment",
			});
			expect(replicaSets.items).toHaveLength(0);
			expect(pods.items).toHaveLength(0);
		});
	});

	it("should delete owned replicasets and pods after deleting a deployment with foreground propagation", async () => {
		const namespace = await getTestNamespace();
		await createDeployment({
			metadata: { name: "foreground-delete-deployment" },
			spec: {
				replicas: 2,
				selector: {
					matchLabels: {
						app: "foreground-delete-deployment",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "foreground-delete-deployment",
						},
					},
					spec: {
						containers: [{ name: "pause", image: podImage }],
					},
				},
			},
		});

		await waitFor(async () => {
			const replicaSets = await apps.listNamespacedReplicaSet({
				namespace,
				labelSelector: "app=foreground-delete-deployment",
			});
			const pods = await core.listNamespacedPod({
				namespace,
				labelSelector: "app=foreground-delete-deployment",
			});
			expect(replicaSets.items).toHaveLength(1);
			expect(pods.items).toHaveLength(2);
		});

		await apps.deleteNamespacedDeployment({
			namespace,
			name: "foreground-delete-deployment",
			propagationPolicy: "Foreground",
			body: {
				propagationPolicy: "Foreground",
			},
		});

		await waitFor(async () => {
			const deployments = await apps.listNamespacedDeployment({
				namespace,
				labelSelector: "app=foreground-delete-deployment",
			});
			const replicaSets = await apps.listNamespacedReplicaSet({
				namespace,
				labelSelector: "app=foreground-delete-deployment",
			});
			const pods = await core.listNamespacedPod({
				namespace,
				labelSelector: "app=foreground-delete-deployment",
			});
			expect(deployments.items).toHaveLength(0);
			expect(replicaSets.items).toHaveLength(0);
			expect(pods.items).toHaveLength(0);
		});
	});

	it("should orphan owned replicasets and pods after deleting a deployment with orphan propagation", async () => {
		const namespace = await getTestNamespace();
		await createDeployment({
			metadata: { name: "orphan-delete-deployment" },
			spec: {
				replicas: 1,
				selector: {
					matchLabels: {
						app: "orphan-delete-deployment",
					},
				},
				template: {
					metadata: {
						labels: {
							app: "orphan-delete-deployment",
						},
					},
					spec: {
						containers: [{ name: "pause", image: podImage }],
					},
				},
			},
		});

		let replicaSetName = "";
		let podName = "";
		await waitFor(async () => {
			const replicaSets = await apps.listNamespacedReplicaSet({
				namespace,
				labelSelector: "app=orphan-delete-deployment",
			});
			const pods = await core.listNamespacedPod({
				namespace,
				labelSelector: "app=orphan-delete-deployment",
			});
			expect(replicaSets.items).toHaveLength(1);
			expect(pods.items).toHaveLength(1);
			replicaSetName = replicaSets.items[0]?.metadata?.name ?? "";
			podName = pods.items[0]?.metadata?.name ?? "";
			expect(replicaSetName).toBeTruthy();
			expect(podName).toBeTruthy();
		});

		await apps.deleteNamespacedDeployment({
			namespace,
			name: "orphan-delete-deployment",
			propagationPolicy: "Orphan",
			body: {
				propagationPolicy: "Orphan",
			},
		});

		await waitFor(async () => {
			const replicaSet = await apps.readNamespacedReplicaSet({
				namespace,
				name: replicaSetName,
			});
			const pod = await core.readNamespacedPod({ namespace, name: podName });
			expect(replicaSet.metadata?.ownerReferences ?? []).toHaveLength(0);
			expect(pod.metadata?.ownerReferences?.[0]).toMatchObject({
				kind: "ReplicaSet",
				name: replicaSetName,
				controller: true,
			});
		});
	});

	it("should watch deployments under the apps/v1 path", async () => {
		const namespace = await getTestNamespace();
		const events: Array<{ phase: string; obj: V1Deployment }> = [];
		const watch = new k8s.Watch(kubeConfig);
		const controller = await watch.watch(
			`/apis/apps/v1/namespaces/${namespace}/deployments`,
			{},
			(phase, obj) => {
				events.push({ phase, obj: obj as V1Deployment });
			},
			() => undefined,
		);

		try {
			await createDeployment({ metadata: { name: "watched-deployment" } });
			await waitFor(() => {
				expect(events).toContainEqual({
					phase: "ADDED",
					obj: expect.objectContaining({
						metadata: expect.objectContaining({
							name: "watched-deployment",
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
