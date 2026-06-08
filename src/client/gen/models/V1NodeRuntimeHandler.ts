import { V1NodeRuntimeHandlerFeatures } from "./V1NodeRuntimeHandlerFeatures";

export interface V1NodeRuntimeHandler {
	features?: V1NodeRuntimeHandlerFeatures;
	name?: string;
}
