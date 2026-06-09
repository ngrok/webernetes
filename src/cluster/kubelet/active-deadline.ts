/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { V1Pod, V1PodStatus } from "../../client";
import type { EventRecorder } from "../../client-go/tools/record/event";
import type { Clock } from "../../clock";
import type { PodSyncLoopHandler, PodSyncHandler, ShouldEvictResponse } from "./lifecycle";

const reason = "DeadlineExceeded";
const message = "Pod was active on the node longer than the specified deadline";

interface PodStatusProvider {
	getPodStatus(podUid: string): V1PodStatus | undefined;
}

// Models kubernetes/pkg/kubelet/active_deadline.go activeDeadlineHandler.
export class ActiveDeadlineHandler implements PodSyncLoopHandler, PodSyncHandler {
	constructor(
		private readonly podStatusProvider: PodStatusProvider,
		private readonly recorder: EventRecorder,
		private readonly clock: Clock,
	) {}

	// Models kubernetes/pkg/kubelet/active_deadline.go activeDeadlineHandler.ShouldSync.
	shouldSync(pod: V1Pod): boolean {
		return this.pastActiveDeadline(pod);
	}

	// Models kubernetes/pkg/kubelet/active_deadline.go activeDeadlineHandler.ShouldEvict.
	shouldEvict(pod: V1Pod): ShouldEvictResponse {
		if (!this.pastActiveDeadline(pod)) {
			return { evict: false, reason: "", message: "" };
		}
		void this.recorder.eventf(pod, "Normal", reason, message);
		return { evict: true, reason, message };
	}

	// Models kubernetes/pkg/kubelet/active_deadline.go activeDeadlineHandler.pastActiveDeadline.
	private pastActiveDeadline(pod: V1Pod): boolean {
		if (pod.spec?.activeDeadlineSeconds === undefined) {
			return false;
		}
		const podStatus = this.podStatusProvider.getPodStatus(pod.metadata?.uid ?? "") ?? pod.status;
		if (!podStatus?.startTime) {
			return false;
		}
		const duration = this.clock.since(podStatus.startTime);
		const allowedDuration = pod.spec.activeDeadlineSeconds * 1000;
		return duration >= allowedDuration;
	}
}

// Models kubernetes/pkg/kubelet/active_deadline.go newActiveDeadlineHandler.
export function newActiveDeadlineHandler(
	podStatusProvider: PodStatusProvider | undefined,
	recorder: EventRecorder | undefined,
	clock: Clock | undefined,
): [activeDeadlineHandler: ActiveDeadlineHandler | undefined, err: Error | undefined] {
	if (!clock || !podStatusProvider || !recorder) {
		return [
			undefined,
			new Error(`required arguments must not be nil: ${clock}, ${podStatusProvider}, ${recorder}`),
		];
	}
	return [new ActiveDeadlineHandler(podStatusProvider, recorder, clock), undefined];
}
