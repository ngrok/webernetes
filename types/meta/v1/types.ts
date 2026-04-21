// Copying from:
//   kubernetes/kubernetes/staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/types.go

export interface TypeMeta {
	apiVersion: string;
	kind: string;
}

export interface OwnerReference {
	apiVersion: string;
	kind: string;
	name: string;
	uid: string;
	controller?: boolean;
	blockOwnerDeletion?: boolean;
}

export interface Metadata {
	name?: string;
	generateName?: string;
	namespace?: string;
	uid?: string;
	resourceVersion?: string;
	generation?: number;
	creationTimestamp?: string;
	deletionTimestamp?: string;
	annotations?: Record<string, string>;
	labels?: Record<string, string>;
	ownerReferences?: OwnerReference[];
}

export interface ObjectMeta {
	metadata?: Metadata;
}
