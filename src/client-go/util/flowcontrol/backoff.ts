import type { Clock } from "../../../clock";

interface BackoffEntry {
	backoff: number;
	lastUpdate: Date;
}

type HasExpiredFunc = (eventTime: Date, lastUpdate: Date, maxDurationMs: number) => boolean;

// Models staging/src/k8s.io/client-go/util/flowcontrol/backoff.go Backoff.
export class Backoff {
	hasExpiredFunc: HasExpiredFunc | undefined;
	private readonly perItemBackoff = new Map<string, BackoffEntry>();

	constructor(
		readonly clock: Clock,
		private readonly defaultDurationMs: number,
		private readonly maxDurationMs: number,
		private readonly maxJitterFactor: number,
	) {}

	// Models staging/src/k8s.io/client-go/util/flowcontrol/backoff.go Backoff.Get.
	get(id: string): number {
		return this.perItemBackoff.get(id)?.backoff ?? 0;
	}

	// Models staging/src/k8s.io/client-go/util/flowcontrol/backoff.go Backoff.Next.
	next(id: string, eventTime: Date): void {
		let entry = this.perItemBackoff.get(id);
		if (!entry || this.hasExpired(eventTime, entry.lastUpdate, this.maxDurationMs)) {
			entry = this.initEntry(id);
			entry.backoff += this.jitter(entry.backoff);
		} else {
			const delay = entry.backoff * 2 + this.jitter(entry.backoff);
			entry.backoff = Math.min(delay, this.maxDurationMs);
		}
		entry.lastUpdate = this.clock.now();
	}

	// Models staging/src/k8s.io/client-go/util/flowcontrol/backoff.go Backoff.Reset.
	reset(id: string): void {
		this.perItemBackoff.delete(id);
	}

	// Models staging/src/k8s.io/client-go/util/flowcontrol/backoff.go Backoff.IsInBackOffSince.
	isInBackOffSince(id: string, eventTime: Date): boolean {
		const entry = this.perItemBackoff.get(id);
		if (!entry) {
			return false;
		}
		if (this.hasExpired(eventTime, entry.lastUpdate, this.maxDurationMs)) {
			return false;
		}
		return this.clock.nowMs() - eventTime.getTime() < entry.backoff;
	}

	// Models staging/src/k8s.io/client-go/util/flowcontrol/backoff.go Backoff.IsInBackOffSinceUpdate.
	isInBackOffSinceUpdate(id: string, eventTime: Date): boolean {
		const entry = this.perItemBackoff.get(id);
		if (!entry) {
			return false;
		}
		if (this.hasExpired(eventTime, entry.lastUpdate, this.maxDurationMs)) {
			return false;
		}
		return eventTime.getTime() - entry.lastUpdate.getTime() < entry.backoff;
	}

	// Models staging/src/k8s.io/client-go/util/flowcontrol/backoff.go Backoff.GC.
	gc(): void {
		const now = this.clock.now();
		for (const [id, entry] of this.perItemBackoff) {
			if (this.hasExpired(now, entry.lastUpdate, this.maxDurationMs)) {
				this.perItemBackoff.delete(id);
			}
		}
	}

	// Models staging/src/k8s.io/client-go/util/flowcontrol/backoff.go Backoff.DeleteEntry.
	deleteEntry(id: string): void {
		this.perItemBackoff.delete(id);
	}

	// Models staging/src/k8s.io/client-go/util/flowcontrol/backoff.go Backoff.initEntryUnsafe.
	private initEntry(id: string): BackoffEntry {
		const entry = { backoff: this.defaultDurationMs, lastUpdate: new Date(0) };
		this.perItemBackoff.set(id, entry);
		return entry;
	}

	// Models staging/src/k8s.io/client-go/util/flowcontrol/backoff.go Backoff.jitter.
	private jitter(delay: number): number {
		return Math.random() * this.maxJitterFactor * delay;
	}

	// Models staging/src/k8s.io/client-go/util/flowcontrol/backoff.go Backoff.hasExpired.
	private hasExpired(eventTime: Date, lastUpdate: Date, maxDurationMs: number): boolean {
		if (this.hasExpiredFunc) {
			return this.hasExpiredFunc(eventTime, lastUpdate, maxDurationMs);
		}
		return eventTime.getTime() - lastUpdate.getTime() > maxDurationMs * 2;
	}
}

// Models staging/src/k8s.io/client-go/util/flowcontrol/backoff.go NewBackOff.
export function newBackOff(initialMs: number, maxMs: number, clock: Clock): Backoff {
	return newBackOffWithJitter(initialMs, maxMs, 0, clock);
}

// Models staging/src/k8s.io/client-go/util/flowcontrol/backoff.go NewBackOffWithJitter.
export function newBackOffWithJitter(
	initialMs: number,
	maxMs: number,
	maxJitterFactor: number,
	clock: Clock,
): Backoff {
	return new Backoff(clock, initialMs, maxMs, maxJitterFactor);
}
