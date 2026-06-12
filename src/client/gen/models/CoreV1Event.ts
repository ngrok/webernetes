/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { CoreV1EventSeries } from "./CoreV1EventSeries";
import { V1EventSource } from "./V1EventSource";
import type { V1MicroTime } from "../../types";
import { V1ObjectMeta } from "./V1ObjectMeta";
import { V1ObjectReference } from "./V1ObjectReference";

export interface CoreV1Event {
	action?: string;
	apiVersion?: string;
	count?: number;
	eventTime?: V1MicroTime;
	firstTimestamp?: Date;
	involvedObject: V1ObjectReference;
	kind?: string;
	lastTimestamp?: Date;
	message?: string;
	metadata: V1ObjectMeta;
	reason?: string;
	related?: V1ObjectReference;
	reportingComponent?: string;
	reportingInstance?: string;
	series?: CoreV1EventSeries;
	source?: V1EventSource;
	type?: string;
}
