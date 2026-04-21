import { V1ConfigMapEnvSource } from "./V1ConfigMapEnvSource";
import { V1SecretEnvSource } from "./V1SecretEnvSource";
export interface V1EnvFromSource {
	configMapRef?: V1ConfigMapEnvSource;
	prefix?: string;
	secretRef?: V1SecretEnvSource;
}
