export interface V1ConfigMapNodeConfigSource {
	kubeletConfigKey: string;
	name: string;
	namespace: string;
	resourceVersion?: string;
	uid?: string;
}
