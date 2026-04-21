export interface V1ContainerRestartRuleOnExitCodes {
	containerName?: string;
	operator: string;
	values: Array<number>;
}
