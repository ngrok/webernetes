import { V1Preconditions } from "./V1Preconditions";

export interface V1DeleteOptions {
	apiVersion?: string;
	dryRun?: Array<string>;
	gracePeriodSeconds?: number;
	ignoreStoreReadErrorWithClusterBreakingPotential?: boolean;
	kind?: string;
	orphanDependents?: boolean;
	preconditions?: V1Preconditions;
	propagationPolicy?: string;
}
