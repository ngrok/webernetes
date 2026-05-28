// oxlint-disable typescript/no-non-null-assertion
import { expect, it } from "vitest";
import { CIDR } from "../../net";
import { kubernetes } from "../../test/harnesses/kubernetes";
import { apiErrorCode, apiStatusMessage } from "../../test/harnesses/helpers";

kubernetes.describe("Pods", (context) => {
	const { core, target, k8s } = context;
	const {
		createPod,
		replacePod,
		getTestNamespace,
		createNamespace,
		createAgnhostPod,
		createNodePortFor,
		fetchNodePort,
		readPod,
		containerStatus,
		exec,
		waitFor,
		waitForPodReady,
		eventsFor,
		eventReasonsFor,
		eventReasonCountFor,
	} = context.helpers;
	const podImage = "registry.k8s.io/pause:3.10";
	const busyboxImage = "busybox:1.36";
	const mergePatchOptions = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch);

	it("should be able to create a pod", async () => {
		const pod = await createPod({ metadata: { name: "create-test" } });
		expect(pod.apiVersion).toBe("v1");
		expect(pod.kind).toBe("Pod");
		expect(pod.metadata?.name).toBe("create-test");
	});

	it("should reject pods created with a resourceVersion", async () => {
		const namespace = await getTestNamespace();
		let createError: unknown;

		try {
			await core.createNamespacedPod({
				namespace,
				body: {
					metadata: {
						name: "create-resource-version-test",
						resourceVersion: "123",
					},
					spec: {
						containers: [{ name: "test", image: podImage }],
					},
				},
			});
		} catch (error) {
			createError = error;
		}

		expect(apiErrorCode(createError)).toBe(500);
		expect(apiStatusMessage(createError)).toBe(
			`resourceVersion should not be set on objects to be created`,
		);
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
		const namespace = await getTestNamespace();

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
		const namespace = await getTestNamespace();

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
		const namespace = await getTestNamespace();

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
		const namespace = await getTestNamespace();

		const pod = await core.readNamespacedPod({
			name: "read-test",
			namespace,
		});

		expect(pod.metadata?.name).toBe("read-test");
	});

	it("should emit scheduler and kubelet lifecycle events for a pod", async () => {
		const podName = "event-lifecycle-test";
		await createPod({ metadata: { name: podName } });
		const namespace = await getTestNamespace();
		const podResource = {
			apiVersion: "v1",
			kind: "Pod",
			metadata: {
				name: podName,
				namespace,
			},
		};

		await waitFor(async () => {
			const pod = await core.readNamespacedPod({ name: podName, namespace });
			expect(pod.status?.phase).toBe("Running");
		});

		await waitFor(async () => {
			expect(await eventReasonsFor(podResource)).toEqual(
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
			expect(await eventReasonsFor(podResource)).toContain("Killing");
		});

		const events = await eventsFor(podResource);
		expect(eventComponentFor(events.find((event) => event.reason === "Scheduled"))).toBe(
			"default-scheduler",
		);
		expect(eventComponentFor(events.find((event) => event.reason === "Started"))).toBe("kubelet");
	});

	it("should run postStart exec lifecycle hooks", async () => {
		const podName = "post-start-exec-hook-test";
		let pod = await createPod({
			metadata: { name: podName },
			spec: {
				containers: [
					{
						name: "test",
						image: busyboxImage,
						command: ["sleep", "3600"],
						lifecycle: {
							postStart: {
								exec: {
									command: ["touch", "/tmp/post-start"],
								},
							},
						},
					},
				],
			},
		});

		pod = await waitForPodReady(pod);

		await waitFor(async () => {
			const result = await exec(pod, "test", ["test", "-f", "/tmp/post-start"]);
			expect(result.exitCode).toBe(0);
		});
	});

	it("should record failed postStart lifecycle hooks", async () => {
		const podName = "post-start-fail-hook-test";
		await createPod({
			metadata: { name: podName },
			spec: {
				containers: [
					{
						name: "test",
						image: busyboxImage,
						command: ["sleep", "3600"],
						lifecycle: {
							postStart: {
								exec: {
									command: ["false"],
								},
							},
						},
					},
				],
			},
		});
		const namespace = await getTestNamespace();
		const podResource = {
			apiVersion: "v1",
			kind: "Pod",
			metadata: {
				name: podName,
				namespace,
			},
		};

		await waitFor(async () => {
			expect(await eventReasonsFor(podResource)).toContain("FailedPostStartHook");
		});
	});

	it("should record failed preStop lifecycle hooks before terminating containers", async () => {
		const podName = "pre-stop-fail-hook-test";
		let pod = await createPod({
			metadata: { name: podName },
			spec: {
				containers: [
					{
						name: "test",
						image: busyboxImage,
						command: ["sleep", "3600"],
						lifecycle: {
							preStop: {
								exec: {
									command: ["false"],
								},
							},
						},
					},
				],
			},
		});

		pod = await waitForPodReady(pod);
		await core.deleteNamespacedPod({
			name: pod.metadata!.name!,
			namespace: pod.metadata!.namespace!,
			gracePeriodSeconds: 5,
			body: {
				gracePeriodSeconds: 5,
			},
		});

		await waitFor(async () => {
			expect(await eventReasonsFor(pod)).toContain("FailedPreStopHook");
		});
	});

	it("should report image pull failures and back off retries", async () => {
		const podName = "image-pull-backoff-test";
		const image = "registry.k8s.io/webernetes/does-not-exist:404";
		await createPod({
			metadata: { name: podName },
			spec: {
				containers: [{ name: "missing", image, imagePullPolicy: "Always" }],
			},
		});
		const namespace = await getTestNamespace();
		const podResource = {
			apiVersion: "v1",
			kind: "Pod",
			metadata: {
				name: podName,
				namespace,
			},
		};
		const pullErrorMessage = `rpc error: code = NotFound desc = failed to pull and unpack image "${image}": failed to resolve reference "${image}": ${image}: not found`;
		const backOffMessage = `Back-off pulling image "${image}": ErrImagePull: ${pullErrorMessage}`;

		await waitFor(async () => {
			const pod = await readPod(podName, namespace);
			const status = containerStatus(pod, "missing");
			expect(pod.status?.phase).toBe("Pending");
			expect(status.state?.waiting?.reason).toBe("ErrImagePull");
			expect(status.state?.waiting?.message).toBe(pullErrorMessage);
		});

		await waitFor(async () => {
			const events = await eventsFor(podResource);
			expect(events).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						reason: "Pulling",
						message: `Pulling image "${image}"`,
					}),
					expect.objectContaining({
						reason: "Failed",
						message: `Failed to pull image "${image}": ${pullErrorMessage}`,
					}),
					expect.objectContaining({
						reason: "Failed",
						message: "Error: ErrImagePull",
					}),
				]),
			);
		});

		await core.patchNamespacedPod(
			{
				name: podName,
				namespace,
				body: {
					metadata: {
						labels: {
							retry: "now",
						},
					},
				},
			},
			mergePatchOptions,
		);

		await waitFor(async () => {
			const pod = await readPod(podName, namespace);
			const status = containerStatus(pod, "missing");
			expect(pod.status?.phase).toBe("Pending");
			expect(status.state?.waiting?.reason).toBe("ImagePullBackOff");
			expect(status.state?.waiting?.message).toBe(backOffMessage);
		});

		await waitFor(async () => {
			const events = await eventsFor(podResource);
			expect(events).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						reason: "BackOff",
						message: `Back-off pulling image "${image}"`,
					}),
					expect.objectContaining({
						reason: "Failed",
						message: "Error: ImagePullBackOff",
					}),
				]),
			);
		});
	});

	it("should report invalid image names without pulling", async () => {
		const podName = "invalid-image-name-test";
		const image = "FAILED_IMAGE";
		await createPod({
			metadata: { name: podName },
			spec: {
				containers: [{ name: "invalid", image, imagePullPolicy: "Always" }],
			},
		});
		const namespace = await getTestNamespace();
		const podResource = {
			apiVersion: "v1",
			kind: "Pod",
			metadata: {
				name: podName,
				namespace,
			},
		};
		const parseError = `couldn't parse image name "${image}": invalid reference format: repository name (library/${image}) must be lowercase`;
		const statusMessage = `Failed to apply default image tag "${image}": ${parseError}`;

		await waitFor(async () => {
			const pod = await readPod(podName, namespace);
			const status = containerStatus(pod, "invalid");
			expect(pod.status?.phase).toBe("Pending");
			expect(status.state?.waiting?.reason).toBe("InvalidImageName");
			expect(status.state?.waiting?.message).toBe(statusMessage);
		});

		await waitFor(async () => {
			const events = await eventsFor(podResource);
			expect(events).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						reason: "InspectFailed",
						message: statusMessage,
					}),
					expect.objectContaining({
						reason: "Failed",
						message: "Error: InvalidImageName",
					}),
				]),
			);
		});
	});

	it("should be able to replace a pod", async () => {
		const original = await createPod({
			metadata: {
				name: "replace-test",
				labels: { app: "original" },
			},
		});

		const replaced = await replacePod(original, (current) => {
			current.metadata = {
				name: "replace-test",
				labels: { app: "replaced" },
			};
		});

		expect(replaced.metadata?.labels?.app).toBe("replaced");

		const namespace = await getTestNamespace();
		const pods = await core.listNamespacedPod({ namespace });
		expect(
			pods.items.find((pod) => pod.metadata?.name === "replace-test")?.metadata?.labels?.app,
		).toBe("replaced");
	});

	it("should be able to bind a pod to a node", async () => {
		const namespace = await getTestNamespace();
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
		const namespace = await getTestNamespace();

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
		const namespace = await getTestNamespace();

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

	it("should reject patching pod status with a UID precondition mismatch", async () => {
		const name = "patch-status-uid-precondition-test";
		const mismatchedUid = "00000000-0000-0000-0000-000000000000";
		await createPod({
			metadata: {
				name,
			},
		});
		const namespace = await getTestNamespace();

		let patchError: unknown;
		try {
			await core.patchNamespacedPodStatus(
				{
					name,
					namespace,
					body: {
						metadata: {
							uid: mismatchedUid,
						},
						status: {
							phase: "Running",
						},
					},
				},
				mergePatchOptions,
			);
		} catch (error) {
			patchError = error;
		}
		expect(apiErrorCode(patchError)).toBe(422);
		expect(apiStatusMessage(patchError)).toBe(
			`Pod "${name}" is invalid: metadata.uid: Invalid value: "${mismatchedUid}": field is immutable`,
		);

		const current = await readPod(name);
		expect(current.status?.phase).not.toBe("Running");
	});

	it("should patch pod status with a matching UID precondition", async () => {
		const name = "patch-status-uid-precondition-success-test";
		let pod = await createPod({
			metadata: {
				name,
			},
		});
		pod = await waitForPodReady(pod);
		const namespace = await getTestNamespace();
		const podUid = pod.metadata?.uid;
		expect(podUid).toBeTruthy();
		if (!podUid) {
			throw new Error("Expected created pod to have metadata.uid");
		}

		const patched = await core.patchNamespacedPodStatus(
			{
				name,
				namespace,
				body: {
					metadata: {
						uid: podUid,
					},
					status: {
						phase: "Running",
						message: "uid precondition accepted",
					},
				},
			},
			mergePatchOptions,
		);

		expect(patched.status?.phase).toBe("Running");
		expect(patched.status?.message).toBe("uid precondition accepted");
	});

	it("should reject non-merge pod status patches in the simulator", async () => {
		if (target !== "simulator") {
			return;
		}

		const name = "patch-status-non-merge-test";
		const pod = await createPod({
			metadata: {
				name,
			},
		});
		const namespace = await getTestNamespace();
		const strategicPatchOptions = k8s.setHeaderOptions(
			"Content-Type",
			k8s.PatchStrategy.StrategicMergePatch,
		);

		await expect(
			core.patchNamespacedPodStatus(
				{
					name,
					namespace,
					body: {
						metadata: {
							uid: pod.metadata?.uid,
						},
						status: {
							phase: "Running",
						},
					},
				},
				strategicPatchOptions,
			),
		).rejects.toThrow(/415|Unsupported|Media/i);

		const current = await readPod(name);
		expect(current.status?.phase).not.toBe("Running");
	});

	it("should throw 409 when replacing a pod with a stale resourceVersion", async () => {
		await createPod({
			metadata: {
				name: "replace-conflict-test",
				labels: { app: "original" },
			},
		});

		const namespace = await getTestNamespace();
		const stale = await core.readNamespacedPod({
			name: "replace-conflict-test",
			namespace,
		});

		expect(Number(stale.metadata?.resourceVersion)).toBeGreaterThan(0);

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

	it("should allow replacing a pod without a resourceVersion", async () => {
		await createPod({
			metadata: {
				name: "replace-without-resource-version",
			},
		});
		const namespace = await getTestNamespace();
		const current = await core.readNamespacedPod({
			name: "replace-without-resource-version",
			namespace,
		});
		const { resourceVersion: _resourceVersion, ...metadata } = current.metadata ?? {};

		const replaced = await core.replaceNamespacedPod({
			name: "replace-without-resource-version",
			namespace,
			body: {
				...current,
				metadata: {
					...metadata,
					labels: { revision: "unconditional" },
				},
			},
		});

		expect(replaced.metadata?.labels?.revision).toBe("unconditional");
	});

	it("should list pods from an exact resourceVersion snapshot", async () => {
		const namespace = await getTestNamespace();
		await createPod({
			metadata: {
				name: "exact-list-before",
			},
		});

		const firstList = await core.listNamespacedPod({ namespace });
		const snapshotResourceVersion = firstList.metadata?.resourceVersion ?? "";
		expect(Number(snapshotResourceVersion)).toBeGreaterThan(0);

		await createPod({
			metadata: {
				name: "exact-list-after",
			},
		});

		const exactList = await core.listNamespacedPod({
			namespace,
			resourceVersion: snapshotResourceVersion,
			resourceVersionMatch: "Exact",
		});

		expect(exactList.metadata?.resourceVersion).toBe(snapshotResourceVersion);
		expect(exactList.items.map((pod) => pod.metadata?.name)).toContain("exact-list-before");
		expect(exactList.items.map((pod) => pod.metadata?.name)).not.toContain("exact-list-after");
	});

	it("should apply field selectors to exact resourceVersion snapshots", async () => {
		const namespace = await getTestNamespace();
		const firstList = await core.listNamespacedPod({ namespace });
		const snapshotResourceVersion = firstList.metadata?.resourceVersion ?? "";
		expect(Number(snapshotResourceVersion)).toBeGreaterThan(0);

		await createPod({
			metadata: {
				name: "exact-selected-after",
			},
		});

		const exactList = await core.listNamespacedPod({
			namespace,
			fieldSelector: "metadata.name=exact-selected-after",
			resourceVersion: snapshotResourceVersion,
			resourceVersionMatch: "Exact",
		});

		expect(exactList.metadata?.resourceVersion).toBe(snapshotResourceVersion);
		expect(exactList.items).toHaveLength(0);
	});

	it("should list pods not older than a resourceVersion", async () => {
		const namespace = await getTestNamespace();
		const firstList = await core.listNamespacedPod({ namespace });
		const snapshotResourceVersion = firstList.metadata?.resourceVersion ?? "";
		expect(Number(snapshotResourceVersion)).toBeGreaterThan(0);

		await createPod({
			metadata: {
				name: "not-older-than-after",
			},
			spec: {
				nodeName: "missing-not-older-than-node",
			},
		});

		const notOlderThanList = await core.listNamespacedPod({
			namespace,
			resourceVersion: snapshotResourceVersion,
			resourceVersionMatch: "NotOlderThan",
		});

		expect(Number(notOlderThanList.metadata?.resourceVersion)).toBeGreaterThanOrEqual(
			Number(snapshotResourceVersion),
		);
		expect(notOlderThanList.items.map((pod) => pod.metadata?.name)).toContain(
			"not-older-than-after",
		);
	});

	it("should reject invalid resourceVersionMatch list options", async () => {
		const namespace = await getTestNamespace();
		const cases = [
			{
				request: {
					namespace,
					resourceVersionMatch: "NotARealMatch",
				},
				message: `ListOptions.meta.k8s.io "" is invalid: [resourceVersionMatch: Forbidden: resourceVersionMatch is forbidden unless resourceVersion is provided, resourceVersionMatch: Unsupported value: "NotARealMatch": supported values: "Exact", "NotOlderThan", ""]`,
			},
			{
				request: {
					namespace,
					resourceVersionMatch: "Exact",
				},
				message: `ListOptions.meta.k8s.io "" is invalid: resourceVersionMatch: Forbidden: resourceVersionMatch is forbidden unless resourceVersion is provided`,
			},
			{
				request: {
					namespace,
					resourceVersion: "0",
					resourceVersionMatch: "Exact",
				},
				message: `ListOptions.meta.k8s.io "" is invalid: resourceVersionMatch: Forbidden: resourceVersionMatch "exact" is forbidden for resourceVersion "0"`,
			},
		];

		for (const { request, message } of cases) {
			let listError: unknown;
			try {
				await core.listNamespacedPod(request);
			} catch (error) {
				listError = error;
			}

			expect(apiErrorCode(listError)).toBe(422);
			expect(apiStatusMessage(listError)).toBe(message);
		}
	});

	it("should reject deletes with a stale resourceVersion precondition", async () => {
		const pod = await createPod({
			metadata: {
				name: "delete-resource-version-precondition-test",
				labels: { revision: "initial" },
			},
			spec: {
				nodeName: "missing-resource-version-precondition-node",
			},
		});
		const namespace = await getTestNamespace();
		const staleResourceVersion = pod.metadata?.resourceVersion ?? "";
		expect(Number(staleResourceVersion)).toBeGreaterThan(0);

		const updated = await replacePod("delete-resource-version-precondition-test", (current) => {
			current.metadata = {
				...current.metadata,
				labels: { revision: "updated" },
			};
		});
		const currentResourceVersion = updated.metadata?.resourceVersion ?? "";
		expect(Number(currentResourceVersion)).toBeGreaterThan(0);

		let deleteError: unknown;
		try {
			await core.deleteNamespacedPod({
				name: "delete-resource-version-precondition-test",
				namespace,
				gracePeriodSeconds: 0,
				body: {
					gracePeriodSeconds: 0,
					preconditions: {
						resourceVersion: staleResourceVersion,
					},
				},
			});
		} catch (error) {
			deleteError = error;
		}

		expect(apiErrorCode(deleteError)).toBe(409);
		expect(apiStatusMessage(deleteError)).toBe(
			`Operation cannot be fulfilled on Pod "delete-resource-version-precondition-test": the ResourceVersion in the precondition (${staleResourceVersion}) does not match the ResourceVersion in record (${currentResourceVersion}). The object might have been modified`,
		);
		const current = await core.readNamespacedPod({
			name: "delete-resource-version-precondition-test",
			namespace,
		});
		expect(current.metadata?.labels?.revision).toBe("updated");
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
		const namespace = await getTestNamespace();
		const otherNamespace = await createNamespace("list-all-namespaces-");
		const podName = "list-all-primary";
		const otherPodName = "list-all-secondary";

		await createPod({ metadata: { name: podName } });
		await createPod({ metadata: { name: otherPodName, namespace: otherNamespace } });

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
		const namespace = await getTestNamespace();
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
		await createPod({
			metadata: {
				name: otherSelectedPodName,
				namespace: otherNamespace,
				labels: { app: "selected" },
			},
		});
		await createPod({
			metadata: {
				name: ignoredPodName,
				namespace: otherNamespace,
				labels: { app: "ignored" },
			},
		});

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
		const namespace = await getTestNamespace();
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
		const namespace = await getTestNamespace();
		const otherNamespace = await createNamespace("list-all-field-selected-");
		const selectedPodName = "list-all-field-selected";
		const ignoredPodName = "list-all-field-ignored";

		await createPod({ metadata: { name: selectedPodName } });
		await createPod({ metadata: { name: ignoredPodName, namespace: otherNamespace } });

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
		const namespace = await getTestNamespace();
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

	it("should restart a spontaneously exited container when restartPolicy is Always", async () => {
		const pod = await createAgnhostPod({
			metadata: {
				labels: { app: "exit-always" },
			},
			spec: { restartPolicy: "Always" },
		});
		await waitForPodReady(pod);
		const nodePort = await createNodePortFor([pod]);
		const startedEventsBeforeExit = await eventReasonCountFor(pod, "Started");

		await fetchNodePort(nodePort, {
			path: "/exit?code=1&timeout=1s",
		});

		await waitFor(async () => {
			const current = await readPod(pod);
			const status = containerStatus(current, "server");
			expect(current.status?.phase).toBe("Running");
			expect(status.restartCount).toBeGreaterThan(0);
			expect(status.state?.running).toBeDefined();
			expect(await eventReasonCountFor(pod, "Started")).toBeGreaterThan(startedEventsBeforeExit);
		});
	});

	it("should restart a failed spontaneously exited container when restartPolicy is OnFailure", async () => {
		const pod = await createAgnhostPod({
			metadata: {
				labels: { app: "exit-onfailure-failed" },
			},
			spec: { restartPolicy: "OnFailure" },
		});
		await waitForPodReady(pod);
		const nodePort = await createNodePortFor([pod]);
		const startedEventsBeforeExit = await eventReasonCountFor(pod, "Started");

		await fetchNodePort(nodePort, {
			path: "/exit?code=1&timeout=1s",
		});

		await waitFor(async () => {
			const current = await readPod(pod);
			const status = containerStatus(current, "server");
			expect(current.status?.phase).toBe("Running");
			expect(status.restartCount).toBeGreaterThan(0);
			expect(status.state?.running).toBeDefined();
			expect(await eventReasonCountFor(pod, "Started")).toBeGreaterThan(startedEventsBeforeExit);
		});
	});

	it("should not restart a succeeded spontaneously exited container when restartPolicy is OnFailure", async () => {
		const pod = await createAgnhostPod({
			metadata: {
				labels: { app: "exit-onfailure-succeeded" },
			},
			spec: { restartPolicy: "OnFailure" },
		});
		await waitForPodReady(pod);
		const nodePort = await createNodePortFor([pod]);

		await fetchNodePort(nodePort, {
			// exit code 0 == succeeded
			path: "/exit?code=0&timeout=1s",
		});

		await waitFor(async () => {
			const current = await readPod(pod);
			const status = containerStatus(current, "server");
			expect(current.status?.phase).toBe("Succeeded");
			expect(status.restartCount).toBe(0);
			expect(status.state?.terminated?.exitCode).toBe(0);
		});

		// We wait here to give time for any spurious shenanigans to happen. The pod
		// should sit in its succeeded state without changing.
		await observeFor(2500);

		const current = await readPod(pod);
		const status = containerStatus(current, "server");
		expect(current.status?.phase).toBe("Succeeded");
		expect(status.restartCount).toBe(0);
		expect(status.state?.terminated?.exitCode).toBe(0);
	});

	it("should not restart a spontaneously exited container when restartPolicy is Never", async () => {
		const pod = await createAgnhostPod({
			metadata: {
				labels: { app: "exit-never" },
			},
			spec: { restartPolicy: "Never" },
		});
		await waitForPodReady(pod);
		const nodePort = await createNodePortFor([pod]);

		await fetchNodePort(nodePort, {
			path: "/exit?code=1&timeout=1s",
		});

		await waitFor(async () => {
			const current = await readPod(pod);
			const status = containerStatus(current, "server");
			expect(current.status?.phase).toBe("Failed");
			expect(status.restartCount).toBe(0);
			expect(status.state?.terminated?.exitCode).toBe(1);
		});

		// We wait here to give time for any spurious shenanigans to happen. The pod
		// should sit in its failed state without changing.
		await observeFor(2500);

		const current = await readPod(pod);
		const status = containerStatus(current, "server");
		expect(current.status?.phase).toBe("Failed");
		expect(status.restartCount).toBe(0);
		expect(status.state?.terminated?.exitCode).toBe(1);
	});
});

function eventComponentFor(
	event: { source?: { component?: string }; reportingComponent?: string } | undefined,
) {
	return event?.source?.component ?? event?.reportingComponent;
}

async function observeFor(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
