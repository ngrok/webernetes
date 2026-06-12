import { useState } from "react";

import { Cluster } from "./components/cluster";
import { Header } from "./components/header";
import { ResourcesTabs } from "./components/resources-tabs";
import { useCluster } from "./hooks";
import { setup } from "./setup";

export function App() {
	const { cluster, reset } = useCluster(setup);
	const [namespace, setNamespace] = useState<string | undefined>("default");

	if (!cluster) {
		return <div className="text-muted text-sm">Booting simulated Kubernetes cluster...</div>;
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
				<Cluster cluster={cluster} namespace={namespace} />
				<ResourcesTabs cluster={cluster} namespace={namespace} />
			</main>
		</div>
	);
}
