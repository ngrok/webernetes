import { Node, objectReferenceToOwnerReference, type ObjectReference } from "./graph";

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

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go makeNode.
export function makeNode(identity: ObjectReference, owners: ReturnType<typeof withOwners>): Node {
	return new Node(identity, {
		apiVersion: identity.apiVersion,
		kind: identity.kind,
		metadata: {
			name: identity.name,
			namespace: identity.namespace,
			uid: identity.uid,
			ownerReferences: owners,
		},
	});
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go withOwners.
export function withOwners(...owners: ObjectReference[]) {
	return owners.map(objectReferenceToOwnerReference);
}
