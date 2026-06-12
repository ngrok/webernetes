export interface V1DeploymentCondition {
	lastTransitionTime?: Date;
	lastUpdateTime?: Date;
	message?: string;
	reason?: string;
	status: string;
	type: string;
}
