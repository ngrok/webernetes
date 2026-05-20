import type { V1ObjectReference, V1Pod } from "../../../client";
import type * as context from "../../../go/context";
import type { PodSandboxConfig } from "../../cri";

export class ImagePullError extends Error {
	constructor(
		reason:
			| "ErrImagePull"
			| "ImagePullBackOff"
			| "ErrImageNeverPull"
			| "InvalidImageName"
			| "ErrImageInspect"
			| "RegistryUnavailable"
			| "SignatureValidationFailed",
		readonly messageForStatus: string,
	) {
		super(reason);
		this.name = reason;
	}
}

// Models kubernetes/pkg/kubelet/images/types.go ImageManager.
export interface ImageManager {
	ensureImageExists(
		ctx: context.Context,
		objRef: V1ObjectReference | undefined,
		pod: V1Pod,
		requestedImage: string,
		pullSecrets: unknown[],
		podSandboxConfig: PodSandboxConfig,
		podRuntimeHandler: string,
		pullPolicy: string | undefined,
	): Promise<[imageRef: string, message: string, err: Error | undefined]>;
}
