import { V1ContainerRestartRuleOnExitCodes } from "./V1ContainerRestartRuleOnExitCodes";
export interface V1ContainerRestartRule {
	action: string;
	exitCodes?: V1ContainerRestartRuleOnExitCodes;
}
