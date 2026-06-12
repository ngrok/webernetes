import { Button } from "@ngrok/mantle/button";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import * as w8s from "webernetes";

import { Cluster } from "./components/cluster";
import { Header } from "./components/header";
import { RequestOverlay } from "./components/request-overlay";
import { ResourcesTabs } from "./components/resources-tabs";
import {
	demoRequestIdHeader,
	demoRequestTypeButtonClick,
	demoRequestTypeHeader,
	distance,
	getNodePort,
	idFor,
	sendRequestButtonId,
} from "./helpers";
import { useCluster } from "./hooks";
import { setup } from "./setup";

const demoClusterOptions: w8s.ClusterOptions = {
	latencyProvider: w8s.newLatencyProvider({
		clusterNetworkRequestLatency: (chain) => getLatency("request", chain),
		clusterNetworkResponseLatency: (chain) => getLatency("response", chain),
	}),
};

export function App() {
	const { cluster, reset } = useCluster(setup, demoClusterOptions);
	const [namespace, setNamespace] = useState<string | undefined>("default");
	const requestLayerRef = useRef<HTMLDivElement>(null);

	if (!cluster) {
		return <div className="text-muted text-sm">Booting simulated Kubernetes cluster...</div>;
	}

	async function sendRequest() {
		if (!cluster) {
			return;
		}
		const nodePort = await getNodePort(cluster, "default", "api");
		await cluster.fetch(`http://node-1:${nodePort}/checkout`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				[demoRequestIdHeader]: crypto.randomUUID(),
				[demoRequestTypeHeader]: demoRequestTypeButtonClick,
			},
			body: JSON.stringify({ cartId: "demo-cart" }),
		});
	}

	return (
		<div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-4 py-6 md:px-6">
			<Header
				cluster={cluster}
				namespace={namespace}
				onNamespaceChange={setNamespace}
				onReset={reset}
			/>
			<main className="space-y-6">
				<div ref={requestLayerRef} className="relative space-y-6">
					<Cluster cluster={cluster} namespace={namespace} />
					<div className="flex items-center justify-end">
						<Button id={sendRequestButtonId} type="button" onClick={sendRequest}>
							<PaperPlaneTiltIcon aria-hidden weight="bold" />
							Send request
						</Button>
					</div>
					<RequestOverlay cluster={cluster} containerRef={requestLayerRef} />
				</div>
				<ResourcesTabs cluster={cluster} namespace={namespace} />
			</main>
		</div>
	);
}

function getLatency(direction: "request" | "response", chain: readonly w8s.NetworkHop[]): number {
	const [fromId, toId] = endpoints(direction, chain);
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
	return Math.max(150, (px / dotSpeed()) * 1000);
}

function endpoints(
	direction: "request" | "response",
	chain: readonly w8s.NetworkHop[],
): [string | undefined, string | undefined] {
	const ids = chain
		.map((hop) => (hop.type === "external" ? undefined : idFor(hop.resource)))
		.filter((id): id is string => id !== undefined);
	if (direction === "request" && chain[0]?.type === "node") {
		return [sendRequestButtonId, ids.at(-1)];
	}
	if (direction === "response" && chain.at(-1)?.type === "node") {
		return [ids[0], sendRequestButtonId];
	}
	return [ids[0], ids.at(-1)];
}

function dotSpeed(): number {
	const min = 350;
	const max = 450;
	return min + Math.random() * (max - min);
}
