import type * as context from "../../../../go/context";

// Models kubernetes/pkg/kubelet/images/pullmanager/interfaces.go GetPodCredentials.
export type GetPodCredentials = () => Promise<[pullCredentials: unknown[], err: Error | undefined]>;

// Models kubernetes/pkg/kubelet/images/pullmanager/interfaces.go ImagePullManager.
export interface ImagePullManager {
	recordPullIntent(image: string): Promise<Error | undefined>;
	recordImagePulled(
		ctx: context.Context,
		image: string,
		imageRef: string,
		credentials: unknown | undefined,
	): Promise<void>;
	recordImagePullFailed(ctx: context.Context, image: string): Promise<void>;
	mustAttemptImagePull(
		ctx: context.Context,
		image: string,
		imageRef: string,
		getPodCredentials: GetPodCredentials,
	): Promise<[pullRequired: boolean, err: Error | undefined]>;
}
