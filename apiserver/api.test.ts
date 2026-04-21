import { beforeEach, describe, expect, it } from "vitest";

import { Clock } from "../clock";
import type { Pod } from "../types/core/v1/types";
import { Api, Event } from "./api";

describe("Api", () => {
	let api: Api;

	beforeEach(() => {
		api = new Api(new Clock());
	});

	describe("pods", () => {
		const pod: Pod = {
			kind: "Pod",
			apiVersion: "v1",
			metadata: {
				name: "pod-1",
			},
		};

		it("should be able to store and retrieve pods", async () => {
			await api.v1.pods.create(pod);
			const retrievedPod = await api.v1.pods.get("pod-1");
			expect(retrievedPod).toEqual(pod);
		});

		it("should be able to generate names", async () => {
			const pod: Pod = {
				kind: "Pod",
				apiVersion: "v1",
				metadata: {
					generateName: "generated-",
				},
			};

			const created = await api.v1.pods.create(pod);
			expect(created.metadata).toBeDefined();
			expect(created.metadata?.name).toMatch(/^generated-.+$/);
		});

		it("should refuse to create pods with duplicate names", async () => {
			await api.v1.pods.create(pod);
			await expect(api.v1.pods.create(pod)).rejects.toThrow("already exists");
		});

		it("should be able to delete pods", async () => {
			await api.v1.pods.create(pod);
			const deleted = await api.v1.pods.delete("pod-1");
			expect(deleted).toBe(true);

			const retrievedPod = await api.v1.pods.get("pod-1");
			expect(retrievedPod).toBeUndefined();
		});

		it("should be able to watch pods", async () => {
			const events: Event<Pod>[] = [];
			await api.v1.pods.watch(async (event) => {
				events.push(event);
			});
			await api.v1.pods.create(pod);

			expect(events).toHaveLength(1);
			const [event] = events;
			expect(event?.type).toBe("added");
			expect(event?.value).toEqual(pod);
		});

		it("should be able to get initial events from a watch", async () => {
			const events: Event<Pod>[] = [];
			await api.v1.pods.create(pod);
			await api.v1.pods.watch(
				async (event) => {
					events.push(event);
				},
				{ sendInitial: true },
			);

			expect(events).toHaveLength(2);
			const [addedEvent, bookmarkEvent] = events;
			expect(addedEvent?.type).toBe("added");
			expect(addedEvent?.value).toEqual(pod);
			expect(bookmarkEvent?.type).toBe("bookmark");
			expect(bookmarkEvent?.value).toEqual(undefined);
		});

		it("should still send bookmark if no added events", async () => {
			const events: Event<Pod>[] = [];
			await api.v1.pods.watch(
				async (event) => {
					events.push(event);
				},
				{ sendInitial: true },
			);

			expect(events).toHaveLength(1);
			const [event] = events;
			expect(event?.type).toBe("bookmark");
			expect(event?.value).toEqual(undefined);
		});

		it("should send full lifecycle of events", async () => {
			const events: Event<Pod>[] = [];
			await api.v1.pods.watch(async (event) => {
				events.push(event);
			});

			await api.v1.pods.create(pod);
			await api.v1.pods.update("pod-1", pod);
			await api.v1.pods.delete("pod-1");

			expect(events).toHaveLength(3);
			const [addedEvent, modifiedEvent, deletedEvent] = events;
			expect(addedEvent?.type).toBe("added");
			expect(addedEvent?.value).toEqual(pod);
			expect(modifiedEvent?.type).toBe("modified");
			expect(modifiedEvent?.value).toEqual(pod);
			expect(deletedEvent?.type).toBe("deleted");
			expect(deletedEvent?.value).toEqual(pod);
		});

		it("should be possible to remove watches", async () => {
			const events: Event<Pod>[] = [];
			const watch = await api.v1.pods.watch(async (event) => {
				events.push(event);
			});

			watch.cancel();
			await api.v1.pods.create(pod);

			expect(events).toHaveLength(0);
		});
	});
});
