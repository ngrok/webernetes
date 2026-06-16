/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import * as k8s from "../../client";
import { expect } from "vitest";
import { Clock } from "../../clock";
import { withClock } from "../../clock-context";
import { KubeConfig } from "../../client/config";
import { TestKubeClient } from "../../client/test";
import { Etcd } from "../../cluster/etcd";
import * as context from "../../go/context";
import { GraphBuilder, type GraphEvent } from "./graph-builder";
import { Node, type ObjectReference } from "./graph";

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go makeID.
export function makeID(
	apiVersion: string,
	kind: string,
	namespace: string,
	name: string,
	uid: string,
): ObjectReference {
	return { apiVersion, kind, namespace, name, uid };
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go nodeTweak.
type NodeTweak = (node: Node) => Node;

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go makeNode.
export function makeNode(identity: ObjectReference, ...tweaks: NodeTweak[]): Node {
	let node = new Node({ identity });
	for (const tweak of tweaks) {
		node = tweak(node);
	}
	return node;
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go withOwners.
export function withOwners(...ownerReferences: ObjectReference[]): NodeTweak {
	return (node: Node): Node => {
		const owners: k8s.V1OwnerReference[] = [];
		for (const owner of ownerReferences) {
			owners.push({
				apiVersion: owner.apiVersion,
				kind: owner.kind,
				name: owner.name,
				uid: owner.uid,
			});
		}
		node.setOwners(owners);
		return node;
	};
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go createEvent.
export function createEvent(
	eventType: GraphEvent["eventType"],
	selfUID: string,
	owners: string[],
): GraphEvent {
	const ownerReferences: k8s.V1OwnerReference[] = owners.map((owner) => ({
		apiVersion: "v1",
		kind: "Pod",
		name: owner,
		uid: owner,
	}));
	const pod: k8s.V1Pod = {
		apiVersion: "v1",
		kind: "Pod",
		metadata: {
			name: selfUID,
			namespace: "default",
			ownerReferences,
			uid: selfUID,
		},
	};
	return { eventType, obj: pod };
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go verifyGraphInvariants.
export function verifyGraphInvariants(scenario: string, uidToNode: Map<string, Node>): void {
	for (const [myUID, node] of uidToNode) {
		for (const dependentNode of node.dependents) {
			expect(
				dependentNode.getOwners().some((owner) => owner.uid === myUID),
				`${scenario}: node ${node.identity.uid} has node ${dependentNode.identity.uid} as a dependent, but it is not present in the latter node's owners list`,
			).toBe(true);
		}

		for (const owner of node.getOwners()) {
			const ownerNode = uidToNode.get(owner.uid);
			if (!ownerNode) {
				continue;
			}
			expect(
				ownerNode.dependents.has(node),
				`${scenario}: node ${node.identity.uid} has node ${ownerNode.identity.uid} as an owner, but it is not present in the latter node's dependents list`,
			).toBe(true);
		}
	}
}

export function newTestGraphBuilder(): GraphBuilder {
	const ctx = withClock(context.background(), new Clock());
	const kubeConfig = new KubeConfig({
		ctx,
		etcd: new Etcd(ctx),
		nodePortRange: { from: 30000, to: 32767 },
	});
	return new GraphBuilder(new TestKubeClient(kubeConfig), kubeConfig);
}
