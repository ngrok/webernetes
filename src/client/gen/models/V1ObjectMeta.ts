import { V1ManagedFieldsEntry } from "./V1ManagedFieldsEntry";
import { V1OwnerReference } from "./V1OwnerReference";
export interface V1ObjectMeta {
	annotations?: {
		[key: string]: string;
	};
	creationTimestamp?: Date;
	deletionGracePeriodSeconds?: number;
	deletionTimestamp?: Date;
	finalizers?: Array<string>;
	generateName?: string;
	generation?: number;
	labels?: {
		[key: string]: string;
	};
	managedFields?: Array<V1ManagedFieldsEntry>;
	name?: string;
	namespace?: string;
	ownerReferences?: Array<V1OwnerReference>;
	resourceVersion?: string;
	selfLink?: string;
	uid?: string;
}
