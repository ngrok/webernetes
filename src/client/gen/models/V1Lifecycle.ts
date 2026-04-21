import { V1LifecycleHandler } from "./V1LifecycleHandler";
export interface V1Lifecycle {
	postStart?: V1LifecycleHandler;
	preStop?: V1LifecycleHandler;
	stopSignal?: string;
}
