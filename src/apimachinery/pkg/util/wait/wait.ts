// Models staging/src/k8s.io/apimachinery/pkg/util/wait/wait.go Jitter.
export function jitter(durationMs: number, maxFactor: number): number {
	if (maxFactor <= 0) {
		maxFactor = 1;
	}
	return durationMs + Math.random() * maxFactor * durationMs;
}
