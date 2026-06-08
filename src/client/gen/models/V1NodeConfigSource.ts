import { V1ConfigMapNodeConfigSource } from "./V1ConfigMapNodeConfigSource";

export interface V1NodeConfigSource {
	configMap?: V1ConfigMapNodeConfigSource;
}
