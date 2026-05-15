import { expect, it } from "vitest";
import type { CoreV1Event } from "../gen/models";
import { kubernetes } from "../../test/harnesses/kubernetes";

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
});
