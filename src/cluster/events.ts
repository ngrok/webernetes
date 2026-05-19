import * as k8s from "../client";
import { isNotFoundError } from "../client/errors";
import type { KubernetesObject } from "../client/types";
import type { Clock } from "../clock";

export interface EventRecorderOptions {
	api: k8s.CoreV1Api;
	clock: Clock;
	component: string;
	host?: string;
}

export class EventRecorder {
	constructor(private readonly options: EventRecorderOptions) {}

	async event(
		involvedObject: KubernetesObject,
		type: string,
		reason: string,
		message: string,
	): Promise<void> {
		const namespace = involvedObject.metadata?.namespace ?? "default";
		const name = involvedObject.metadata?.name;
		if (!name) {
			return;
		}

		const now = this.options.clock.now();
		try {
			await this.options.api.createNamespacedEvent({
				namespace,
				body: {
					metadata: {
						generateName: `${name}.`,
						namespace,
					},
					involvedObject: {
						apiVersion: involvedObject.apiVersion,
						kind: involvedObject.kind,
						name,
						namespace,
						resourceVersion: involvedObject.metadata?.resourceVersion,
						uid: involvedObject.metadata?.uid,
					},
					count: 1,
					firstTimestamp: now,
					lastTimestamp: now,
					message,
					reason,
					reportingComponent: this.options.component,
					reportingInstance: this.options.host ?? this.options.component,
					source: {
						component: this.options.component,
						host: this.options.host,
					},
					type,
				},
			});
		} catch (error) {
			if (!isNotFoundError(error)) {
				throw error;
			}
		}
	}
}
