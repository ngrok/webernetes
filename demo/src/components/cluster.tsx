import * as w8s from "webernetes";

import { idFor, sortByName } from "../helpers";
import { useInformer } from "../hooks";
import { Node } from "./node";

export function Cluster({
	cluster,
	highlightedPodIds,
	namespace,
}: {
	cluster: w8s.Cluster;
	highlightedPodIds: ReadonlySet<string>;
	namespace: string | undefined;
}) {
	const nodes = useInformer({
		cluster,
		resource: "nodes",
		sort: sortByName,
	});

	return (
		<div className="grid gap-4 lg:grid-cols-3">
			{nodes.map((node) => (
				<Node
					key={idFor(node)}
					cluster={cluster}
					highlightedPodIds={highlightedPodIds}
					namespace={namespace}
					node={node}
				/>
			))}
		</div>
	);
}
