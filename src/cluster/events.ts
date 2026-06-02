import * as k8s from "../client";
import { isNotFoundError } from "../client/errors";
import type { V1ObjectReference } from "../client";
import type { EventObject, EventRecorder } from "../client-go/tools/record/event";
import type { Clock } from "../clock";

export interface EventRecorderOptions {
	api: k8s.CoreV1Api;
	clock: Clock;
	component: string;
	host?: string;
}

export class EventRecorderImpl implements EventRecorder {
	constructor(private readonly options: EventRecorderOptions) {}

	async event(object: EventObject, type: string, reason: string, message: string): Promise<void> {
		await this.record(object, undefined, type, reason, message);
	}

	async eventf(
		object: EventObject,
		type: string,
		reason: string,
		messageFmt: string,
		...args: unknown[]
	): Promise<void> {
		await this.record(object, undefined, type, reason, sprintf(messageFmt, args));
	}

	async annotatedEventf(
		object: EventObject,
		annotations: Record<string, string>,
		type: string,
		reason: string,
		messageFmt: string,
		...args: unknown[]
	): Promise<void> {
		await this.record(object, annotations, type, reason, sprintf(messageFmt, args));
	}

	private async record(
		object: EventObject,
		annotations: Record<string, string> | undefined,
		type: string,
		reason: string,
		message: string,
	): Promise<void> {
		const ref = objectReference(object);
		const namespace = ref.namespace ?? "default";
		const name = ref.name;
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
						annotations,
					},
					involvedObject: ref,
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

function objectReference(object: EventObject): V1ObjectReference {
	if ("metadata" in object) {
		return {
			apiVersion: object.apiVersion,
			kind: object.kind,
			name: object.metadata?.name,
			namespace: object.metadata?.namespace ?? "default",
			resourceVersion: object.metadata?.resourceVersion,
			uid: object.metadata?.uid,
		};
	}
	return object;
}

function sprintf(messageFmt: string, args: unknown[]): string {
	let index = 0;
	return messageFmt.replace(/%[sdvq]/g, (verb) => {
		const value = args[index++] ?? "";
		if (verb === "%q") {
			return JSON.stringify(String(value));
		}
		return String(value);
	});
}
