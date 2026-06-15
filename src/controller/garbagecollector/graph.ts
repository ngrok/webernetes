/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import * as k8s from "../../client";
import {
	finalizerDeleteDependents,
	finalizerOrphanDependents,
} from "../../client/gen/apis/impls/delete";

export type ModeledObject =
	| k8s.V1Deployment
	| k8s.V1ReplicaSet
	| k8s.V1Pod
	| k8s.V1Service
	| k8s.V1EndpointSlice;

// Models kubernetes/pkg/controller/garbagecollector/graph.go objectReference.
export interface ObjectReference extends k8s.V1OwnerReference {
	namespace: string;
}

// Models kubernetes/pkg/controller/garbagecollector/graph.go node.
export class Node {
	identity: ObjectReference;
	readonly dependents = new Set<Node>();
	deletingDependents: boolean;
	beingDeleted: boolean;
	virtual: boolean;
	private owners: k8s.V1OwnerReference[];

	constructor(identity: ObjectReference, object?: ModeledObject) {
		this.identity = identity;
		this.owners = object?.metadata?.ownerReferences ?? [];
		this.beingDeleted = object?.metadata?.deletionTimestamp !== undefined;
		this.deletingDependents = false;
		this.virtual = object === undefined;
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph.go clone.
	clone(): Node {
		const cloned = new Node(this.identity);
		for (const dependent of this.dependents) {
			cloned.dependents.add(dependent);
		}
		cloned.deletingDependents = this.deletingDependents;
		cloned.beingDeleted = this.beingDeleted;
		cloned.virtual = this.virtual;
		cloned.owners = [...this.owners];
		return cloned;
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph.go markBeingDeleted.
	markBeingDeleted(): void {
		this.beingDeleted = true;
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph.go isBeingDeleted.
	isBeingDeleted(): boolean {
		return this.beingDeleted;
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph.go markObserved.
	markObserved(): void {
		this.virtual = false;
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph.go isObserved.
	isObserved(): boolean {
		return !this.virtual;
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph.go markDeletingDependents.
	markDeletingDependents(): void {
		this.deletingDependents = true;
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph.go isDeletingDependents.
	isDeletingDependents(): boolean {
		return this.deletingDependents;
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph.go setOwners.
	setOwners(owners: k8s.V1OwnerReference[]): void {
		this.owners = owners;
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph.go getOwners.
	getOwners(): k8s.V1OwnerReference[] {
		return this.owners;
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph.go addDependent.
	addDependent(dependent: Node): void {
		this.dependents.add(dependent);
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph.go deleteDependent.
	deleteDependent(dependent: Node): void {
		this.dependents.delete(dependent);
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph.go dependentsLength.
	dependentsLength(): number {
		return this.dependents.size;
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph.go getDependents.
	getDependents(): Node[] {
		return [...this.dependents];
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph.go blockingDependents.
	blockingDependents(): Node[] {
		return this.getDependents().filter((dependent) =>
			dependent
				.getOwners()
				.some((owner) => owner.uid === this.identity.uid && owner.blockOwnerDeletion === true),
		);
	}
}

// Models kubernetes/pkg/controller/garbagecollector/graph.go ownerReferenceCoordinates.
export function ownerReferenceCoordinates(ref: k8s.V1OwnerReference): k8s.V1OwnerReference {
	return {
		uid: ref.uid,
		name: ref.name,
		kind: ref.kind,
		apiVersion: ref.apiVersion,
	};
}

// Models kubernetes/pkg/controller/garbagecollector/graph.go ownerReferenceMatchesCoordinates.
export function ownerReferenceMatchesCoordinates(
	a: k8s.V1OwnerReference,
	b: k8s.V1OwnerReference,
): boolean {
	return a.uid === b.uid && a.name === b.name && a.kind === b.kind && a.apiVersion === b.apiVersion;
}

// Simulator-only: upstream builds objectReference from metadata informer events.
// The simulator rebuilds from typed object caches, so it needs this adapter.
export function identityFor(object: ModeledObject): ObjectReference | undefined {
	const apiVersion = object.apiVersion;
	const kind = object.kind;
	const name = object.metadata?.name;
	const uid = object.metadata?.uid;
	if (!apiVersion || !kind || !name || !uid) {
		return undefined;
	}
	return {
		apiVersion,
		kind,
		name,
		namespace: object.metadata?.namespace ?? "default",
		uid,
	};
}

// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go hasDeleteDependentsFinalizer.
export function hasDeleteDependentsFinalizer(object: ModeledObject | undefined): boolean {
	return !!object && hasFinalizer(object, finalizerDeleteDependents);
}

// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go hasOrphanFinalizer.
export function hasOrphanFinalizer(object: ModeledObject | undefined): boolean {
	return !!object && hasFinalizer(object, finalizerOrphanDependents);
}

// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go hasFinalizer.
function hasFinalizer(object: ModeledObject, matchingFinalizer: string): boolean {
	return (object.metadata?.finalizers ?? []).includes(matchingFinalizer);
}
