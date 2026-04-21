export interface V1OwnerReference {
	apiVersion: string;
	blockOwnerDeletion?: boolean;
	controller?: boolean;
	kind: string;
	name: string;
	uid: string;
}
