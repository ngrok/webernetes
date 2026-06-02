import type { PassiveClock } from "../clock";

// Models vendor/k8s.io/utils/clock/testing/fake_clock.go FakePassiveClock.
export class FakePassiveClock implements PassiveClock {
	constructor(private time: Date) {}

	// Models vendor/k8s.io/utils/clock/testing/fake_clock.go FakePassiveClock.Now.
	now(): Date {
		return new Date(this.time);
	}

	// Models vendor/k8s.io/utils/clock/testing/fake_clock.go FakePassiveClock.Since.
	since(ts: Date): number {
		return this.time.getTime() - ts.getTime();
	}

	// Models vendor/k8s.io/utils/clock/testing/fake_clock.go FakePassiveClock.SetTime.
	setTime(t: Date): void {
		this.time = new Date(t);
	}

	// Models vendor/k8s.io/utils/clock/testing/fake_clock.go FakePassiveClock.Step.
	step(d: number): void {
		this.setTime(new Date(this.now().getTime() + d));
	}
}

// Models vendor/k8s.io/utils/clock/testing/fake_clock.go NewFakePassiveClock.
export function newFakePassiveClock(t: Date): FakePassiveClock {
	return new FakePassiveClock(t);
}
