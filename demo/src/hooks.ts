import { useEffect, useRef, useState } from "react";
import * as w8s from "webernetes";

import { idFor } from "./helpers";

export function useCluster(
	setup: (cluster: w8s.Cluster) => Promise<void> | void,
	options?: w8s.ClusterOptions,
) {
	const [cluster, setCluster] = useState<w8s.Cluster>();
	const [version, setVersion] = useState(0);

	useEffect(() => {
		let cancelled = false;
		let cluster: w8s.Cluster | undefined;

		async function startCluster() {
			cluster = new w8s.Cluster(options);
			await cluster.init();
			await setup(cluster);

			if (cancelled) {
				await cluster.close();
				return;
			}

			setCluster(cluster);
		}

		setCluster(undefined);
		void startCluster().catch((error: unknown) => {
			void cluster?.close();
			if (cancelled) {
				return;
			}
			console.error("failed to start demo cluster", error);
		});

		return () => {
			cancelled = true;
			void cluster?.close();
		};
	}, [options, setup, version]);

	return {
		cluster,
		reset: () => setVersion((current) => current + 1),
	};
}

export function useInformer<TResource extends w8s.ClusterInformerResource>({
	cluster,
	fieldSelector,
	labelSelector,
	limit,
	namespace,
	resource,
	sort,
}: {
	cluster: w8s.Cluster;
	fieldSelector?: string;
	labelSelector?: string;
	limit?: number;
	namespace?: string;
	resource: TResource;
	sort?: (
		items: w8s.ClusterInformerResources[TResource][],
	) => w8s.ClusterInformerResources[TResource][];
}) {
	const currentNamespace = useRef(namespace);
	const [items, setItems] = useState<w8s.ClusterInformerResources[TResource][]>([]);
	currentNamespace.current = namespace;

	useEffect(() => {
		const itemsByKey = new Map<string, w8s.ClusterInformerResources[TResource]>();
		setItems([]);
		const informer = cluster.informer(
			resource,
			(type, item) => {
				if (
					applyInformerEvent(itemsByKey, type, item, limit) &&
					namespace === currentNamespace.current
				) {
					const items = [...itemsByKey.values()];
					setItems(sort ? sort(items) : items);
				}
			},
			{
				fieldSelector,
				labelSelector,
				namespace,
				onError: (error) => {
					console.error(`informer failed for ${resource}`, error);
				},
			},
		);

		return () => {
			void informer.stop().catch((error: unknown) => {
				console.error(`failed to stop informer for ${resource}`, error);
			});
		};
	}, [cluster, fieldSelector, labelSelector, limit, namespace, resource, sort]);

	return items;
}

function applyInformerEvent<T extends w8s.KubernetesObject>(
	items: Map<string, T>,
	type: w8s.ClusterInformerEventType,
	item: T,
	limit: number | undefined,
): boolean {
	const key = idFor(item);
	if (!key) {
		return false;
	}

	if (type === "delete") {
		return items.delete(key);
	}

	items.set(key, item);
	if (limit !== undefined) {
		for (const removedKey of [...items.keys()].slice(0, Math.max(0, items.size - limit))) {
			items.delete(removedKey);
		}
	}
	return true;
}
