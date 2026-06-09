/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { ReadOnlyChannel } from "../../../go/channel";

// Models kubernetes/pkg/kubelet/pleg/pleg.go PodLifeCycleEventType.
export type PodLifeCycleEventType =
	| "ContainerStarted"
	| "ContainerDied"
	| "ContainerRemoved"
	| "PodSync"
	| "ContainerChanged";

export const ContainerStarted = "ContainerStarted" satisfies PodLifeCycleEventType;
export const ContainerDied = "ContainerDied" satisfies PodLifeCycleEventType;
export const ContainerRemoved = "ContainerRemoved" satisfies PodLifeCycleEventType;
export const PodSync = "PodSync" satisfies PodLifeCycleEventType;
export const ContainerChanged = "ContainerChanged" satisfies PodLifeCycleEventType;

// Models kubernetes/pkg/kubelet/pleg/pleg.go RelistDuration.
export interface RelistDuration {
	relistPeriodMs: number;
	relistThresholdMs: number;
}

// Models kubernetes/pkg/kubelet/pleg/pleg.go PodLifecycleEvent.
export interface PodLifecycleEvent {
	id: string;
	type: PodLifeCycleEventType;
	data?: string;
}

// Models kubernetes/pkg/kubelet/pleg/pleg.go PodLifecycleEventGenerator.
export interface PodLifecycleEventGenerator {
	start(): void;
	watch(): ReadOnlyChannel<PodLifecycleEvent>;
	healthy(): { ok: boolean; error?: Error };
	requestReinspect(podUID: string): void;
	requestRelist(podUID: string): void;
}

// Models kubernetes/pkg/kubelet/pleg/pleg.go podLifecycleEventGeneratorHandler.
export interface PodLifecycleEventGeneratorHandler extends PodLifecycleEventGenerator {
	stop(): Promise<void>;
	update(relistDuration: RelistDuration): void;
	relist(): void;
}
