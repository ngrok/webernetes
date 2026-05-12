import { expect, it } from "vitest";
import { CIDR } from "../../net";
import type { CoreV1Event, V1Pod } from "../gen/models";
import { kubernetes } from "../../test/harnesses/kubernetes";
import { waitFor } from "../../test/wait";

kubernetes.describe("Pods", ({ core, getSuiteNamespace, createNamespace, target, k8s }) => {
	const podImage = "registry.k8s.io/pause:3.10";
	const mergePatchOptions = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch);

	async function createPod(pod: Partial<V1Pod>, podNamespace?: string): Promise<V1Pod> {
		const namespace = podNamespace ?? (await getSuiteNamespace());
		return await core.createNamespacedPod({
			namespace,
			body: {
				...pod,
				metadata: {
					...pod.metadata,
				},
				spec: {
					...pod.spec,
					containers: pod.spec?.containers ?? [{ name: "test", image: podImage }],
				},
			},
		});
	}

	async function replacePod(name: string, mutate: (pod: V1Pod) => void): Promise<V1Pod> {
		let lastError: unknown;
		const namespace = await getSuiteNamespace();

		for (let attempt = 0; attempt < 5; attempt++) {
			const current = await core.readNamespacedPod({ name, namespace });
			mutate(current);

			try {
				return await core.replaceNamespacedPod({
					name,
					namespace,
					body: current,
				});
			} catch (error) {
				if (
					error instanceof Error &&
					(error.message.includes("HTTP-Code: 409") ||
						(error.message.includes("HTTP-Code: 422") && error.message.includes("NodeName")))
				) {
					lastError = error;
					await new Promise((resolve) => setTimeout(resolve, 50));
					continue;
				}
				throw error;
			}
		}

		throw lastError ?? new Error(`Failed to replace pod ${name}`);
	}

	async function podEventReasons(name: string, namespace: string): Promise<string[]> {
		const events = await core.listNamespacedEvent({ namespace });
		return events.items
			.filter((event) => event.involvedObject.kind === "Pod" && event.involvedObject.name === name)
			.map((event) => event.reason)
			.filter((reason): reason is string => reason !== undefined);
	}

	async function podEvents(name: string, namespace: string): Promise<CoreV1Event[]> {
		const events = await core.listNamespacedEvent({ namespace });
		return events.items.filter(
			(event) => event.involvedObject.kind === "Pod" && event.involvedObject.name === name,
		);
	}

	function eventComponent(event: CoreV1Event | undefined): string | undefined {
		return event?.source?.component ?? event?.reportingComponent;
	}

	it("should be able to create a pod", async () => {
		const pod = await createPod({ metadata: { name: "create-test" } });
		expect(pod.apiVersion).toBe("v1");
		expect(pod.kind).toBe("Pod");
		expect(pod.metadata?.name).toBe("create-test");
	});

	it("should not be able to create a pod in a namespace that does not exist", async () => {
		await expect(
			core.createNamespacedPod({
				namespace: "non-existent-namespace",
				body: {
					metadata: {
						namespace: "non-existent-namespace",
						name: "test",
					},
					spec: {
						containers: [{ name: "test", image: "pause" }],
					},
				},
			}),
		).rejects.toThrow(/NotFound/);
	});

	it("should reject pods without containers", async () => {
		const namespace = await getSuiteNamespace();

		await expect(
			core.createNamespacedPod({
				namespace,
				body: {
					metadata: {
						name: "empty-containers-test",
					},
					spec: {
						containers: [],
					},
				},
			}),
		).rejects.toThrow("spec.containers: Required value");
	});

	it("should be able to delete a pod", async () => {
		await createPod({ metadata: { name: "delete-test" } });
		const namespace = await getSuiteNamespace();

		const deleted = await core.deleteNamespacedPod({
			name: "delete-test",
			namespace,
			gracePeriodSeconds: 0,
			body: {
				gracePeriodSeconds: 0,
			},
		});

		expect(deleted.metadata?.name).toBe("delete-test");

		await waitFor(async () => {
			const pods = await core.listNamespacedPod({ namespace });
			expect(pods.items.find((pod) => pod.metadata?.name === "delete-test")).toBeUndefined();
		});
	});

	it("should keep a pod while graceful deletion is in progress", async () => {
		if (target !== "simulator") {
			return;
		}

		await createPod({
			metadata: { name: "graceful-delete-test" },
			spec: {
				containers: [{ name: "test", image: podImage }],
				terminationGracePeriodSeconds: 1,
			},
		});
		const namespace = await getSuiteNamespace();

		const deleted = await core.deleteNamespacedPod({
			name: "graceful-delete-test",
			namespace,
			gracePeriodSeconds: 1,
			body: {
				gracePeriodSeconds: 1,
			},
		});

		expect(deleted.metadata?.deletionTimestamp).toBeDefined();
		expect(deleted.metadata?.deletionGracePeriodSeconds).toBe(1);

		const terminating = await core.readNamespacedPod({
			name: "graceful-delete-test",
			namespace,
		});
		expect(terminating.metadata?.deletionTimestamp).toBeDefined();

		await waitFor(async () => {
			const pods = await core.listNamespacedPod({ namespace });
			expect(
				pods.items.find((pod) => pod.metadata?.name === "graceful-delete-test"),
			).toBeUndefined();
		});
	});

	it("should be able to read a pod", async () => {
		await createPod({ metadata: { name: "read-test" } });
		const namespace = await getSuiteNamespace();

		const pod = await core.readNamespacedPod({
			name: "read-test",
			namespace,
		});

		expect(pod.metadata?.name).toBe("read-test");
	});

	it("should emit scheduler and kubelet lifecycle events for a pod", async () => {
		const podName = "event-lifecycle-test";
		await createPod({ metadata: { name: podName } });
		const namespace = await getSuiteNamespace();

		await waitFor(async () => {
			const pod = await core.readNamespacedPod({ name: podName, namespace });
			expect(pod.status?.phase).toBe("Running");
		});

		await waitFor(async () => {
			expect(await podEventReasons(podName, namespace)).toEqual(
				expect.arrayContaining(["Scheduled", "Pulled", "Created", "Started"]),
			);
		});

		await core.deleteNamespacedPod({
			name: podName,
			namespace,
			gracePeriodSeconds: 0,
			body: {
				gracePeriodSeconds: 0,
			},
		});

		await waitFor(async () => {
			expect(await podEventReasons(podName, namespace)).toContain("Killing");
		});

		const events = await podEvents(podName, namespace);
		expect(eventComponent(events.find((event) => event.reason === "Scheduled"))).toBe(
			"default-scheduler",
		);
		expect(eventComponent(events.find((event) => event.reason === "Started"))).toBe("kubelet");
	});

	it("should be able to replace a pod", async () => {
		await createPod({
			metadata: {
				name: "replace-test",
				labels: { app: "original" },
			},
		});

		const replaced = await replacePod("replace-test", (current) => {
			current.metadata = {
				name: "replace-test",
				labels: { app: "replaced" },
			};
		});

		expect(replaced.metadata?.labels?.app).toBe("replaced");

		const namespace = await getSuiteNamespace();
		const pods = await core.listNamespacedPod({ namespace });
		expect(
			pods.items.find((pod) => pod.metadata?.name === "replace-test")?.metadata?.labels?.app,
		).toBe("replaced");
	});

	it("should be able to bind a pod to a node", async () => {
		const namespace = await getSuiteNamespace();
		const nodeName = (await core.listNode()).items.find((node) => node.metadata?.name)?.metadata
			?.name;
		if (!nodeName) {
			throw new Error("Expected at least one node");
		}
		await core.createNamespacedPod({
			namespace,
			body: {
				metadata: {
					name: "binding-test",
				},
				spec: {
					containers: [{ name: "test", image: podImage }],
					schedulerName: "manual",
				},
			},
		});

		await core.createNamespacedPodBinding({
			name: "binding-test",
			namespace,
			body: {
				apiVersion: "v1",
				kind: "Binding",
				metadata: {
					name: "binding-test",
					namespace,
				},
				target: {
					apiVersion: "v1",
					kind: "Node",
					name: nodeName,
				},
			},
		});

		const pod = await core.readNamespacedPod({ name: "binding-test", namespace });
		expect(pod.spec?.nodeName).toBe(nodeName);
	});

	it("should be able to patch a pod", async () => {
		await createPod({
			metadata: {
				name: "patch-test",
				labels: {
					app: "original",
					remove: "true",
				},
			},
		});
		const namespace = await getSuiteNamespace();

		const patched = await core.patchNamespacedPod(
			{
				name: "patch-test",
				namespace,
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

		expect(patched.metadata?.labels?.app).toBe("patched");
		expect(patched.metadata?.labels?.remove).toBeUndefined();
		expect(patched.spec?.containers?.[0]?.name).toBe("test");
	});

	it("should reject patching a pod name", async () => {
		const name = "patch-name-test";
		const changedName = `${name}-changed`;
		await createPod({
			metadata: {
				name,
			},
		});
		const namespace = await getSuiteNamespace();

		await expect(
			core.patchNamespacedPod(
				{
					name,
					namespace,
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
	});

	it("should throw 409 when replacing a pod with a stale resourceVersion", async () => {
		await createPod({
			metadata: {
				name: "replace-conflict-test",
				labels: { app: "original" },
			},
		});

		const namespace = await getSuiteNamespace();
		const stale = await core.readNamespacedPod({
			name: "replace-conflict-test",
			namespace,
		});

		expect(stale.metadata?.resourceVersion).toBeTruthy();

		await replacePod("replace-conflict-test", (current) => {
			current.metadata = {
				...current.metadata,
				name: "replace-conflict-test",
				labels: { app: "fresh" },
			};
		});

		await expect(
			core.replaceNamespacedPod({
				name: "replace-conflict-test",
				namespace,
				body: {
					...stale,
					metadata: {
						...stale.metadata,
						labels: { app: "stale" },
					},
				},
			}),
		).rejects.toThrow(/HTTP-Code: 409/);

		const current = await core.readNamespacedPod({
			name: "replace-conflict-test",
			namespace,
		});
		expect(current.metadata?.labels?.app).toBe("fresh");
	});

	it("should default pods without metadata.namespace to the default namespace", async () => {
		const pod = await core.createNamespacedPod({
			namespace: "default",
			body: {
				metadata: {
					generateName: "default-namespace-test-",
				},
				spec: {
					containers: [{ name: "test", image: podImage }],
				},
			},
		});

		if (!pod.metadata?.name) {
			throw new Error("Failed to create pod");
		}

		try {
			expect(pod.metadata.namespace).toBe("default");

			const current = await core.readNamespacedPod({
				name: pod.metadata.name,
				namespace: "default",
			});

			expect(current.metadata?.namespace).toBe("default");
		} finally {
			await core.deleteNamespacedPod({
				name: pod.metadata.name,
				namespace: "default",
				gracePeriodSeconds: 0,
				body: {
					gracePeriodSeconds: 0,
				},
			});
		}
	});

	it("should list pods across namespaces", async () => {
		const namespace = await getSuiteNamespace();
		const otherNamespace = await createNamespace("list-all-namespaces-");
		const podName = "list-all-primary";
		const otherPodName = "list-all-secondary";

		await createPod({ metadata: { name: podName } });
		await createPod({ metadata: { name: otherPodName } }, otherNamespace);

		try {
			const pods = await core.listPodForAllNamespaces();

			expect(pods.items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						metadata: expect.objectContaining({
							name: podName,
							namespace,
						}),
					}),
					expect.objectContaining({
						metadata: expect.objectContaining({
							name: otherPodName,
							namespace: otherNamespace,
						}),
					}),
				]),
			);
		} finally {
			await core.deleteNamespacedPod({
				name: otherPodName,
				namespace: otherNamespace,
				gracePeriodSeconds: 0,
				body: {
					gracePeriodSeconds: 0,
				},
			});
			await core.deleteNamespacedPod({
				name: podName,
				namespace,
				gracePeriodSeconds: 0,
				body: {
					gracePeriodSeconds: 0,
				},
			});
			await core.deleteNamespace({
				name: otherNamespace,
			});
		}
	});

	it("should support label selectors when listing pods across namespaces", async () => {
		const namespace = await getSuiteNamespace();
		const otherNamespace = await createNamespace("list-all-selected-");
		const selectedPodName = "list-all-selected-primary";
		const otherSelectedPodName = "list-all-selected-secondary";
		const ignoredPodName = "list-all-ignored";

		await createPod({
			metadata: {
				name: selectedPodName,
				labels: { app: "selected" },
			},
		});
		await createPod(
			{
				metadata: {
					name: otherSelectedPodName,
					labels: { app: "selected" },
				},
			},
			otherNamespace,
		);
		await createPod(
			{
				metadata: {
					name: ignoredPodName,
					labels: { app: "ignored" },
				},
			},
			otherNamespace,
		);

		try {
			const pods = await core.listPodForAllNamespaces({
				labelSelector: "app=selected",
			});

			expect(pods.items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						metadata: expect.objectContaining({
							name: selectedPodName,
							namespace,
							labels: expect.objectContaining({
								app: "selected",
							}),
						}),
					}),
					expect.objectContaining({
						metadata: expect.objectContaining({
							name: otherSelectedPodName,
							namespace: otherNamespace,
							labels: expect.objectContaining({
								app: "selected",
							}),
						}),
					}),
				]),
			);
			expect(
				pods.items.find(
					(pod) =>
						pod.metadata?.name === ignoredPodName && pod.metadata?.namespace === otherNamespace,
				),
			).toBeUndefined();
		} finally {
			await core.deleteNamespacedPod({
				name: ignoredPodName,
				namespace: otherNamespace,
				gracePeriodSeconds: 0,
				body: {
					gracePeriodSeconds: 0,
				},
			});
			await core.deleteNamespacedPod({
				name: otherSelectedPodName,
				namespace: otherNamespace,
				gracePeriodSeconds: 0,
				body: {
					gracePeriodSeconds: 0,
				},
			});
			await core.deleteNamespacedPod({
				name: selectedPodName,
				namespace,
				gracePeriodSeconds: 0,
				body: {
					gracePeriodSeconds: 0,
				},
			});
			await core.deleteNamespace({
				name: otherNamespace,
			});
		}
	});

	it("should support field selectors when listing namespaced pods", async () => {
		const namespace = await getSuiteNamespace();
		const selectedName = "field-selected";
		const ignoredName = "field-ignored";

		await createPod({ metadata: { name: selectedName } });
		await createPod({ metadata: { name: ignoredName } });

		const pods = await core.listNamespacedPod({
			namespace,
			fieldSelector: `metadata.name=${selectedName}`,
		});

		expect(pods.items).toEqual([
			expect.objectContaining({
				metadata: expect.objectContaining({
					name: selectedName,
					namespace,
				}),
			}),
		]);
	});

	it("should support field selectors when listing pods across namespaces", async () => {
		const namespace = await getSuiteNamespace();
		const otherNamespace = await createNamespace("list-all-field-selected-");
		const selectedPodName = "list-all-field-selected";
		const ignoredPodName = "list-all-field-ignored";

		await createPod({ metadata: { name: selectedPodName } });
		await createPod({ metadata: { name: ignoredPodName } }, otherNamespace);

		try {
			const pods = await core.listPodForAllNamespaces({
				fieldSelector: `metadata.name=${selectedPodName}`,
			});

			expect(pods.items).toEqual([
				expect.objectContaining({
					metadata: expect.objectContaining({
						name: selectedPodName,
						namespace,
					}),
				}),
			]);
		} finally {
			await core.deleteNamespacedPod({
				name: ignoredPodName,
				namespace: otherNamespace,
				gracePeriodSeconds: 0,
				body: {
					gracePeriodSeconds: 0,
				},
			});
			await core.deleteNamespacedPod({
				name: selectedPodName,
				namespace,
				gracePeriodSeconds: 0,
				body: {
					gracePeriodSeconds: 0,
				},
			});
			await core.deleteNamespace({
				name: otherNamespace,
			});
		}
	});

	it("should allocate pod IPs from the scheduled node pod CIDR", async () => {
		const namespace = await getSuiteNamespace();
		const nodes = (await core.listNode()).items.filter((node) =>
			Boolean(node.metadata?.name && node.spec?.podCIDR),
		);
		expect(nodes.length).toBeGreaterThan(0);

		const createdPods: Array<{ name: string; namespace: string }> = [];

		try {
			for (const [index, node] of nodes.entries()) {
				const nodeName = node.metadata?.name;
				const podCIDR = node.spec?.podCIDR;
				if (!nodeName || !podCIDR) {
					continue;
				}
				const cidr = new CIDR(podCIDR);

				const name = `node-cidr-${index}`;
				await core.createNamespacedPod({
					namespace,
					body: {
						metadata: { name },
						spec: {
							nodeName,
							automountServiceAccountToken: false,
							containers: [{ name: "test", image: podImage }],
						},
					},
				});
				createdPods.push({ name, namespace });

				await waitFor(async () => {
					const pod = await core.readNamespacedPod({ name, namespace });
					expect(pod.status?.phase).toBe("Running");
					expect(pod.status?.podIP).toBeTruthy();
					expect(cidr.contains(pod.status?.podIP ?? "")).toBe(true);
				});
			}
		} finally {
			for (const pod of createdPods) {
				await core.deleteNamespacedPod({
					name: pod.name,
					namespace: pod.namespace,
					gracePeriodSeconds: 0,
					body: {
						gracePeriodSeconds: 0,
					},
				});
			}
		}
	});
});
