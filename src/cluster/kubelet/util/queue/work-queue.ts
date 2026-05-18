import type { Clock } from "../../../../clock";

export interface WorkQueue {
	getWork(): string[];
	enqueue(item: string, delayMs: number): void;
}

// Models kubernetes/pkg/kubelet/util/queue/work_queue.go basicWorkQueue.
export class BasicWorkQueue implements WorkQueue {
	private readonly queue = new Map<string, number>();

	constructor(private readonly clock: Clock) {}

	// Models kubernetes/pkg/kubelet/util/queue/work_queue.go basicWorkQueue.GetWork.
	getWork(): string[] {
		const now = this.clock.nowMs();
		const items: string[] = [];
		for (const [item, readyAt] of this.queue) {
			if (readyAt < now) {
				items.push(item);
				this.queue.delete(item);
			}
		}
		return items;
	}

	// Models kubernetes/pkg/kubelet/util/queue/work_queue.go basicWorkQueue.Enqueue.
	enqueue(item: string, delayMs: number): void {
		this.queue.set(item, this.clock.nowMs() + delayMs);
	}
}
