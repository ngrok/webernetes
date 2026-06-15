import type { V1LabelSelector } from "../../client";

// Returns a function that blocks each caller until it has been called `count`
// times, letting tests force concurrent operations past a specific hook.
export function createBarrier(count: number): () => Promise<void> {
	let waiting = 0;
	let release: () => void = () => undefined;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});

	return async () => {
		waiting += 1;
		if (waiting === count) {
			release();
		}
		await released;
	};
}

export function formatStringMap(labels: Record<string, string> | undefined): string {
	return JSON.stringify(
		Object.fromEntries(
			Object.entries(labels ?? {}).sort(([left], [right]) => left.localeCompare(right)),
		),
	);
}

export function formatLabelSelector(selector: V1LabelSelector | undefined): string {
	return JSON.stringify(selector ?? {});
}
