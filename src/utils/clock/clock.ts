// Models vendor/k8s.io/utils/clock/clock.go PassiveClock.
export interface PassiveClock {
	now(): Date;
	since(ts: Date): number;
}
