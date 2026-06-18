// React 19.2.x development builds can retain a large number of
// PerformanceMeasure entries for React Performance Tracks under frequent
// updates. Webernetes' demo is intentionally high-churn, so this can look like
// an app memory leak locally even though production builds are unaffected.
// React has fixed this upstream by clearing these measures, but the fix is not
// in the latest stable 19.2.7 package yet. Remove this when a stable React
// release includes:
// - https://github.com/facebook/react/issues/34770
// - https://github.com/facebook/react/pull/34803
export function installDevPerformanceMeasureCleanup(): void {
	if (!import.meta.env.DEV || typeof performance === "undefined") {
		return;
	}

	type PatchedPerformance = Performance & {
		__webernetesOriginalMeasure?: Performance["measure"];
	};

	const patched = performance as PatchedPerformance;
	if (patched.__webernetesOriginalMeasure) {
		return;
	}

	patched.__webernetesOriginalMeasure = performance.measure.bind(performance);

	performance.measure = function measure(
		...args: Parameters<Performance["measure"]>
	): PerformanceMeasure {
		const entry = patched.__webernetesOriginalMeasure!(...args);
		performance.clearMeasures(entry.name);
		return entry;
	};
}
