import { Badge } from "@ngrok/mantle/badge";
import { Card } from "@ngrok/mantle/card";
import * as w8s from "webernetes";

import { getName, idFor, kubeletIdForNodeName, sortByName } from "../helpers";
import { useInformer } from "../hooks";
import { Pod } from "./pod";

export function Node({
	cluster,
	highlightedPodIds,
	namespace,
	node,
}: {
	cluster: w8s.Cluster;
	highlightedPodIds: ReadonlySet<string>;
	namespace: string | undefined;
	node: w8s.V1Node;
}) {
	const name = getName(node, "unknown-node");
	const ip = getNodeIP(node);
	const ready = getNodeReady(node);
	const pods = useInformer({
		cluster,
		fieldSelector: `spec.nodeName=${name}`,
		namespace,
		resource: "pods",
		sort: sortByName,
	});

	return (
		<Card.Root id={idFor(node)}>
			<Card.Header>
				<div className="flex items-center justify-between gap-3">
					<Card.Title className="flex items-baseline gap-2 font-mono text-sm">
						<span className="font-semibold">{name}</span>
						<span className="text-muted text-xs">{ip}</span>
					</Card.Title>
					<Badge appearance="muted" color={ready ? "success" : "warning"}>
						{ready ? "Ready" : "Not ready"}
					</Badge>
				</div>
			</Card.Header>

			<Card.Body>
				<div className="flex min-h-32 flex-col justify-between gap-2">
					<div className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2">
						{pods.map((pod) => (
							<Pod key={idFor(pod)} highlighted={highlightedPodIds.has(idFor(pod))} pod={pod} />
						))}
					</div>
					<div className="flex justify-center pt-2">
						<div
							id={kubeletIdForNodeName(name)}
							className="border-muted text-muted flex h-7 w-20 items-center justify-center rounded border border-dashed px-2 text-center font-mono text-[0.6875rem] font-semibold"
						>
							kubelet
						</div>
					</div>
				</div>
			</Card.Body>
		</Card.Root>
	);
}

function getNodeIP(node: w8s.V1Node): string {
	return (
		node.status?.addresses?.find((address) => address.type === "InternalIP")?.address ??
		node.status?.addresses?.find((address) => address.type === "ExternalIP")?.address ??
		node.spec?.podCIDR ??
		"no address"
	);
}

function getNodeReady(node: w8s.V1Node): boolean {
	return node.status?.phase !== "NotReady";
}
