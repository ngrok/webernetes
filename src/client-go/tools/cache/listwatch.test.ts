/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import * as context from "../../../go/context";
import { browser } from "../../../test/describe";
import type { ListOptions } from "../../../apimachinery/pkg/apis/meta/v1/types";
import type { Selector, TransformFunc } from "../../../apimachinery/pkg/fields/selector";
import type { Requirements } from "../../../apimachinery/pkg/fields/requirements";
import type { Interface } from "../../../apimachinery/pkg/watch/watch";
import type { KubeList, KubernetesObject } from "../../../client/types";
import { doesClientNotSupportWatchListSemantics } from "../../util/watchlist/watch_list";
import {
	ListWatch,
	type ListWatchClient,
	newFilteredListWatchFromClient,
	newListWatchFromClient,
	toListWatcherWithWatchListSemantics,
} from "./listwatch";

interface TestObject extends KubernetesObject {
	metadata: {
		name: string;
	};
}

// Models staging/src/k8s.io/client-go/tools/cache/listwatch_test.go fakeWatchListClient.
class FakeWatchListClient {
	constructor(private readonly unsupportedWatchListSemantics: boolean) {}

	isWatchListSemanticsUnsupported(): boolean {
		return this.unsupportedWatchListSemantics;
	}
}

browser.describe("ListWatch", () => {
	// Models staging/src/k8s.io/client-go/tools/cache/listwatch_test.go TestToListWatcherWithWatchListSemantics.
	it("wraps watch-list semantics support from the client", () => {
		const scenarios: Array<{
			name: string;
			client: unknown;
			expectUnsupportedWatchListSemantics: boolean;
		}> = [
			{
				name: "client which doesn't implement the interface supports WatchList semantics",
				client: undefined,
				expectUnsupportedWatchListSemantics: false,
			},
			{
				name: "client does not support WatchList semantics",
				client: new FakeWatchListClient(true),
				expectUnsupportedWatchListSemantics: true,
			},
			{
				name: "client supports WatchList semantics",
				client: new FakeWatchListClient(false),
				expectUnsupportedWatchListSemantics: false,
			},
		];

		for (const scenario of scenarios) {
			const target = toListWatcherWithWatchListSemantics(
				new ListWatch<TestObject>(),
				scenario.client,
			);

			expect(doesClientNotSupportWatchListSemantics(target)).toBe(
				scenario.expectUnsupportedWatchListSemantics,
			);
		}
	});

	it("creates a filtered list watch from a client and field selector", async () => {
		const client = new FakeListWatchClient();
		const fieldSelector = new FakeSelector("spec.nodeName=node-1");
		const target = newListWatchFromClient(client, "pods", "", fieldSelector);

		await target.list({ resourceVersion: "10" });
		await target.watch({ resourceVersion: "11" });
		await target.listWithContext(context.background(), { resourceVersion: "12" });
		await target.watchWithContext(context.background(), { resourceVersion: "13" });

		expect(client.calls).toEqual([
			{
				operation: "get",
				namespace: "",
				resource: "pods",
				options: {
					resourceVersion: "10",
					fieldSelector: "spec.nodeName=node-1",
				},
			},
			{
				operation: "watch",
				namespace: "",
				resource: "pods",
				options: {
					resourceVersion: "11",
					watch: true,
					fieldSelector: "spec.nodeName=node-1",
				},
			},
			{
				operation: "get",
				namespace: "",
				resource: "pods",
				options: {
					resourceVersion: "12",
					fieldSelector: "spec.nodeName=node-1",
				},
			},
			{
				operation: "watch",
				namespace: "",
				resource: "pods",
				options: {
					resourceVersion: "13",
					watch: true,
					fieldSelector: "spec.nodeName=node-1",
				},
			},
		]);
	});

	it("creates a filtered list watch with all function fields populated", async () => {
		const client = new FakeListWatchClient();
		const target = newFilteredListWatchFromClient(
			client,
			"pods",
			"default",
			(options: ListOptions) => {
				options.labelSelector = "app=demo";
			},
		);

		expect(target.listFunc).toBeDefined();
		expect(target.watchFunc).toBeDefined();
		expect(target.listWithContextFunc).toBeDefined();
		expect(target.watchFuncWithContext).toBeDefined();

		await target.list({ resourceVersion: "20" });
		await target.watch({ resourceVersion: "21" });

		expect(client.calls).toEqual([
			{
				operation: "get",
				namespace: "default",
				resource: "pods",
				options: {
					resourceVersion: "20",
					labelSelector: "app=demo",
				},
			},
			{
				operation: "watch",
				namespace: "default",
				resource: "pods",
				options: {
					resourceVersion: "21",
					watch: true,
					labelSelector: "app=demo",
				},
			},
		]);
	});
});

class FakeSelector implements Selector {
	constructor(private readonly value: string) {}

	matches(): boolean {
		return true;
	}

	empty(): boolean {
		return this.value === "";
	}

	requiresExactMatch(_field: string): [value: string, found: boolean] {
		return ["", false];
	}

	transform(_fn: TransformFunc): [selector: Selector | undefined, err: Error | undefined] {
		return [this, undefined];
	}

	requirements(): Requirements {
		return [];
	}

	string(): string {
		return this.value;
	}

	deepCopySelector(): Selector {
		return new FakeSelector(this.value);
	}
}

interface RequestCall {
	operation: "get" | "watch";
	namespace: string;
	resource: string;
	options: ListOptions;
}

class FakeListWatchClient implements ListWatchClient<TestObject> {
	readonly calls: RequestCall[] = [];
	readonly listObject: KubeList<TestObject> = {
		metadata: { resourceVersion: "1" },
		items: [],
	};

	list(
		resource: string,
		namespace: string,
		options: ListOptions,
	): [KubeList<TestObject>, undefined] {
		this.record("get", resource, namespace, options);
		return [this.listObject, undefined];
	}

	watch(
		resource: string,
		namespace: string,
		options: ListOptions,
	): [Interface<TestObject> | undefined, Error | undefined] {
		this.record("watch", resource, namespace, options);
		return [undefined, undefined];
	}

	private record(
		operation: "get" | "watch",
		resource: string,
		namespace: string,
		options: ListOptions,
	): void {
		this.calls.push({
			operation,
			namespace,
			resource,
			options,
		});
	}
}
