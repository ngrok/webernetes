/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { PassiveClock } from "../clock";

// Models vendor/k8s.io/utils/clock/testing/fake_clock.go FakePassiveClock.
export class FakePassiveClock implements PassiveClock {
	private time: Date;

	constructor(time: Date) {
		this.time = new Date(time);
	}

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
		this.time = new Date(this.time.getTime() + d);
	}
}

// Models vendor/k8s.io/utils/clock/testing/fake_clock.go NewFakePassiveClock.
export function newFakePassiveClock(t: Date): FakePassiveClock {
	return new FakePassiveClock(t);
}
