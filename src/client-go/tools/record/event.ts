/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { V1ObjectReference } from "../../../client";
import type { KubernetesObject } from "../../../client/types";

// Models staging/src/k8s.io/client-go/tools/record/event.go EventRecorder.
export interface EventRecorder {
	event(object: EventObject, eventtype: string, reason: string, message: string): Promise<void>;
	eventf(
		object: EventObject,
		eventtype: string,
		reason: string,
		messageFmt: string,
		...args: unknown[]
	): Promise<void>;
	annotatedEventf(
		object: EventObject,
		annotations: Record<string, string>,
		eventtype: string,
		reason: string,
		messageFmt: string,
		...args: unknown[]
	): Promise<void>;
}

export type EventObject = KubernetesObject | V1ObjectReference;
