export interface V1NamespaceCondition {
	lastTransitionTime?: Date;
	message?: string;
	reason?: string;
	status: string;
	type: string;
}
