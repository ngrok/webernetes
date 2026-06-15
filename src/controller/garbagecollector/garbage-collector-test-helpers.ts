/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import * as k8s from "../../client";
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
	let node = new Node(identity, {
		apiVersion: identity.apiVersion,
		kind: identity.kind,
		metadata: {
			name: identity.name,
			namespace: identity.namespace,
			uid: identity.uid,
		},
	});
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
