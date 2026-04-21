import { V1ConfigMapKeySelector } from "./V1ConfigMapKeySelector";
import { V1FileKeySelector } from "./V1FileKeySelector";
import { V1ObjectFieldSelector } from "./V1ObjectFieldSelector";
import { V1ResourceFieldSelector } from "./V1ResourceFieldSelector";
import { V1SecretKeySelector } from "./V1SecretKeySelector";
export interface V1EnvVarSource {
	configMapKeyRef?: V1ConfigMapKeySelector;
	fileKeyRef?: V1FileKeySelector;
	fieldRef?: V1ObjectFieldSelector;
	resourceFieldRef?: V1ResourceFieldSelector;
	secretKeyRef?: V1SecretKeySelector;
}
