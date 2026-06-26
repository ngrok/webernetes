import { useRef, useState } from "react";
import * as w8s from "webernetes";

import { Cluster } from "./components/cluster";
import { Header } from "./components/header";
import { RequestOverlay } from "./components/request-overlay";
import { ResourcesTabs } from "./components/resources-tabs";
import { distance, getHeader, healthCheckHeader, idFor, kubeletIdForNodeName } from "./helpers";
import { useCluster, usePauseClusterWhenPageInactive } from "./hooks";
import { setup } from "./setup";

type PreNetworkEvent = w8s.PreNetworkRequestEvent | w8s.PreNetworkResponseEvent;
const containerTerminationLatencyMs = 2000;

const demoClusterOptions: w8s.ClusterOptions = {
	latencyProvider: w8s.newLatencyProvider({
		clusterNetworkRequestLatency: (event) => getLatency("request", event),
		clusterNetworkResponseLatency: (event) => getLatency("response", event),
		containerTerminationLatency: () => containerTerminationLatencyMs,
	}),
};

export function App() {
	const { cluster, reset } = useCluster(setup, demoClusterOptions);
	usePauseClusterWhenPageInactive(cluster);
	const [namespace, setNamespace] = useState<string | undefined>("default");
	const [highlightedPodIds, setHighlightedPodIds] = useState<Set<string>>(new Set());
	const requestLayerRef = useRef<HTMLDivElement>(null);

	function changeNamespace(value: string | undefined) {
		setNamespace(value);
		setHighlightedPodIds(new Set());
	}

	if (!cluster) {
		return <div className="text-muted text-sm">Booting simulated Kubernetes cluster...</div>;
	}

	return (
		<div className="demo-shell min-h-screen">
			<div className="demo-glow" aria-hidden="true" />
			<div className="relative z-10 flex min-h-screen w-full flex-col">
				<Header
					cluster={cluster}
					namespace={namespace}
					onNamespaceChange={changeNamespace}
					onReset={reset}
				/>
				<main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 md:px-6">
					<div ref={requestLayerRef} className="relative space-y-6">
						<Cluster
							cluster={cluster}
							highlightedPodIds={highlightedPodIds}
							namespace={namespace}
						/>
						<RequestOverlay
							cluster={cluster}
							containerRef={requestLayerRef}
							namespace={namespace}
						/>
					</div>
					<ResourcesTabs
						cluster={cluster}
						namespace={namespace}
						onHighlightedPodIdsChange={setHighlightedPodIds}
					/>
				</main>
			</div>
		</div>
	);
}

function getLatency(direction: "request" | "response", event: PreNetworkEvent): number {
	const [fromId, toId] = endpoints(direction, event);
	if (!fromId || !toId || fromId === toId || typeof document === "undefined") {
		return 0;
	}
	const from = document.getElementById(fromId);
	const to = document.getElementById(toId);
	if (!from || !to) {
		return 0;
	}
	const px = distance(from, to);
	if (px === 0) {
		return 0;
	}
	return (px / dotSpeed()) * 1000;
}

function endpoints(
	direction: "request" | "response",
	event: PreNetworkEvent,
): [string | undefined, string | undefined] {
	const { chain } = event;
	const ids = chain
		.map((hop) => (hop.type === "external" ? undefined : idFor(hop.resource)))
		.filter((id): id is string => id !== undefined);
	const pod = isHealthCheckRequest(event) ? podForHealthCheck(chain) : undefined;
	if (pod) {
		const podId = idFor(pod);
		const kubeletId = kubeletIdForNodeName(pod.spec?.nodeName ?? "");
		return direction === "request" ? [kubeletId, podId] : [podId, kubeletId];
	}
	return [ids[0], ids.at(-1)];
}

function isHealthCheckRequest(event: PreNetworkEvent): boolean {
	return getHeader(event.request.header, healthCheckHeader) !== undefined;
}

function podForHealthCheck(chain: readonly w8s.NetworkHop[]): w8s.V1Pod | undefined {
	return chain.find(
		(hop): hop is Extract<w8s.NetworkHop, { type: "pod" }> =>
			hop.type === "pod" && hop.resource.spec?.nodeName !== undefined,
	)?.resource;
}

function dotSpeed(): number {
	const min = 245;
	const max = 315;
	return min + Math.random() * (max - min);
}
