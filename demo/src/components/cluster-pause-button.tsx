import { Button } from "@ngrok/mantle/button";
import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import * as w8s from "webernetes";

export function ClusterPauseButton({ cluster }: { cluster: w8s.Cluster }) {
	const paused = useClusterPaused(cluster);

	function togglePaused() {
		if (cluster.isPaused()) {
			cluster.resume();
		} else {
			cluster.pause();
		}
	}

	return (
		<Button type="button" priority="neutral" onClick={togglePaused}>
			{paused ? <PlayIcon aria-hidden weight="bold" /> : <PauseIcon aria-hidden weight="bold" />}
			{paused ? "Play" : "Pause"}
		</Button>
	);
}

export function useClusterPaused(cluster: w8s.Cluster): boolean {
	const [paused, setPaused] = useState(() => cluster.isPaused());

	useEffect(() => {
		const onPause = () => setPaused(true);
		const onResume = () => setPaused(false);
		setPaused(cluster.isPaused());
		cluster.on("pause", onPause);
		cluster.on("resume", onResume);
		return () => {
			cluster.off("pause", onPause);
			cluster.off("resume", onResume);
		};
	}, [cluster]);

	return paused;
}
