import { expect, it } from "vitest";
import type { CoreV1Event } from "../gen/models";
import { kubernetes } from "../../test/harnesses/kubernetes";
import { apiErrorCode } from "../../test/harnesses/helpers";

kubernetes.describe("Events", ({ core, helpers }) => {
	const { getSuiteNamespace } = helpers;
	async function createEvent(event: Partial<CoreV1Event>): Promise<CoreV1Event> {
		const namespace = await getSuiteNamespace();
		return await core.createNamespacedEvent({
			namespace,
			body: {
				metadata: {
					...event.metadata,
				},
				involvedObject: {
					apiVersion: "v1",
					kind: "Pod",
					namespace,
					name: "event-subject",
					...event.involvedObject,
				},
				count: 1,
				firstTimestamp: new Date(),
				lastTimestamp: new Date(),
				message: "event message",
				reason: "Testing",
				source: {
					component: "k8s-web-simulator-test",
				},
				type: "Normal",
				...event,
			},
		});
	}

	it("should create, read, list, replace, and delete events", async () => {
		const namespace = await getSuiteNamespace();
		const created = await createEvent({
			metadata: {
				name: "event-crud",
				labels: { app: "event-crud" },
			},
			message: "created event",
			reason: "Created",
		});

		expect(created.metadata?.name).toBe("event-crud");
		expect(created.apiVersion).toBe("v1");
		expect(created.kind).toBe("Event");
		expect(created.metadata?.namespace).toBe(namespace);
		expect(created.involvedObject.name).toBe("event-subject");

		const read = await core.readNamespacedEvent({
			name: "event-crud",
			namespace,
		});
		expect(read.message).toBe("created event");
		expect(read.reason).toBe("Created");

		const namespaced = await core.listNamespacedEvent({
			namespace,
			labelSelector: "app=event-crud",
		});
		expect(namespaced.items.map((event) => event.metadata?.name)).toContain("event-crud");

		const all = await core.listEventForAllNamespaces({
			labelSelector: "app=event-crud",
		});
		expect(
			all.items.find(
				(event) => event.metadata?.name === "event-crud" && event.metadata?.namespace === namespace,
			),
		).toBeTruthy();

		const replaced = await core.replaceNamespacedEvent({
			name: "event-crud",
			namespace,
			body: {
				...read,
				message: "replaced event",
				reason: "Replaced",
			},
		});
		expect(replaced.message).toBe("replaced event");
		expect(replaced.reason).toBe("Replaced");

		const deleted = await core.deleteNamespacedEvent({
			name: "event-crud",
			namespace,
		});
		expect(deleted.status).toBe("Success");

		await expect(
			core.readNamespacedEvent({
				name: "event-crud",
				namespace,
			}),
		).rejects.toThrow(/NotFound|not found/);
	});

	it("should list events from an exact resourceVersion snapshot", async () => {
		const namespace = await getSuiteNamespace();
		await createEvent({
			metadata: {
				name: "exact-list-before",
			},
		});
		const firstList = await core.listNamespacedEvent({ namespace });
		const snapshotResourceVersion = firstList.metadata?.resourceVersion ?? "";
		expect(Number(snapshotResourceVersion)).toBeGreaterThan(0);

		await createEvent({
			metadata: {
				name: "exact-list-after",
			},
		});

		const exactList = await core.listNamespacedEvent({
			namespace,
			resourceVersion: snapshotResourceVersion,
			resourceVersionMatch: "Exact",
		});

		expect(exactList.metadata?.resourceVersion).toBe(snapshotResourceVersion);
		expect(exactList.items.map((event) => event.metadata?.name)).toContain("exact-list-before");
		expect(exactList.items.map((event) => event.metadata?.name)).not.toContain("exact-list-after");
	});

	it("should list events not older than a resourceVersion", async () => {
		const namespace = await getSuiteNamespace();
		const firstList = await core.listNamespacedEvent({ namespace });
		const snapshotResourceVersion = firstList.metadata?.resourceVersion ?? "";
		expect(Number(snapshotResourceVersion)).toBeGreaterThan(0);

		await createEvent({
			metadata: {
				name: "not-older-than-after",
			},
		});

		const notOlderThanList = await core.listNamespacedEvent({
			namespace,
			resourceVersion: snapshotResourceVersion,
			resourceVersionMatch: "NotOlderThan",
		});

		expect(Number(notOlderThanList.metadata?.resourceVersion)).toBeGreaterThanOrEqual(
			Number(snapshotResourceVersion),
		);
		expect(notOlderThanList.items.map((event) => event.metadata?.name)).toContain(
			"not-older-than-after",
		);
	});

	it("should reject replacing an event with a stale resourceVersion", async () => {
		const namespace = await getSuiteNamespace();
		await createEvent({
			metadata: {
				name: "replace-resource-version-conflict",
			},
			message: "created",
		});
		const stale = await core.readNamespacedEvent({
			name: "replace-resource-version-conflict",
			namespace,
		});

		await core.replaceNamespacedEvent({
			name: "replace-resource-version-conflict",
			namespace,
			body: {
				...stale,
				message: "fresh",
			},
		});

		let replaceError: unknown;
		try {
			await core.replaceNamespacedEvent({
				name: "replace-resource-version-conflict",
				namespace,
				body: {
					...stale,
					message: "stale",
				},
			});
		} catch (error) {
			replaceError = error;
		}

		expect(apiErrorCode(replaceError)).toBe(409);
		const current = await core.readNamespacedEvent({
			name: "replace-resource-version-conflict",
			namespace,
		});
		expect(current.message).toBe("fresh");
	});

	it("should allow replacing an event without a resourceVersion", async () => {
		const namespace = await getSuiteNamespace();
		const event = await createEvent({
			metadata: {
				name: "replace-without-resource-version",
			},
			message: "created",
		});
		const { resourceVersion: _resourceVersion, ...metadata } = event.metadata ?? {};

		const replaced = await core.replaceNamespacedEvent({
			name: "replace-without-resource-version",
			namespace,
			body: {
				...event,
				metadata,
				message: "unconditional",
			},
		});

		expect(replaced.message).toBe("unconditional");
	});

	it("should reject deleting an event with a stale resourceVersion precondition", async () => {
		const namespace = await getSuiteNamespace();
		const event = await createEvent({
			metadata: {
				name: "delete-resource-version-precondition",
			},
			message: "created",
		});
		const staleResourceVersion = event.metadata?.resourceVersion ?? "";
		expect(Number(staleResourceVersion)).toBeGreaterThan(0);

		await core.replaceNamespacedEvent({
			name: "delete-resource-version-precondition",
			namespace,
			body: {
				...event,
				message: "updated",
			},
		});

		let deleteError: unknown;
		try {
			await core.deleteNamespacedEvent({
				name: "delete-resource-version-precondition",
				namespace,
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
		const current = await core.readNamespacedEvent({
			name: "delete-resource-version-precondition",
			namespace,
		});
		expect(current.message).toBe("updated");
	});
});
