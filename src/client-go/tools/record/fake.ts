/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { EventObject, EventRecorder } from "./event";
import { Channel } from "../../../go/channel";

// Models staging/src/k8s.io/client-go/tools/record/fake.go FakeRecorder.
export class FakeRecorder implements EventRecorder {
	events: Channel<string> | undefined;
	includeObject = false;

	private async writeEvent(
		object: EventObject,
		annotations: Record<string, string> | undefined,
		eventtype: string,
		reason: string,
		messageFmt: string,
		...args: unknown[]
	): Promise<void> {
		if (!this.events) {
			return;
		}
		await this.events.send(
			sprintf(`${eventtype} ${reason} ${messageFmt}`, args) +
				objectString(object, this.includeObject) +
				annotationsString(annotations),
		);
	}

	async event(
		object: EventObject,
		eventtype: string,
		reason: string,
		message: string,
	): Promise<void> {
		await this.writeEvent(object, undefined, eventtype, reason, "%s", message);
	}

	async eventf(
		object: EventObject,
		eventtype: string,
		reason: string,
		messageFmt: string,
		...args: unknown[]
	): Promise<void> {
		await this.writeEvent(object, undefined, eventtype, reason, messageFmt, ...args);
	}

	async annotatedEventf(
		object: EventObject,
		annotations: Record<string, string>,
		eventtype: string,
		reason: string,
		messageFmt: string,
		...args: unknown[]
	): Promise<void> {
		await this.writeEvent(object, annotations, eventtype, reason, messageFmt, ...args);
	}
}

// Models staging/src/k8s.io/client-go/tools/record/fake.go NewFakeRecorder.
export function newFakeRecorder(bufferSize: number): FakeRecorder {
	const recorder = new FakeRecorder();
	recorder.events = new Channel<string>(bufferSize);
	return recorder;
}

function objectString(object: EventObject, includeObject: boolean): string {
	if (!includeObject || !("kind" in object || "apiVersion" in object)) {
		return "";
	}
	return ` involvedObject{kind=${object.kind ?? ""},apiVersion=${object.apiVersion ?? ""}}`;
}

function annotationsString(annotations: Record<string, string> | undefined): string {
	if (!annotations || Object.keys(annotations).length === 0) {
		return "";
	}
	return ` ${String(annotations)}`;
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
