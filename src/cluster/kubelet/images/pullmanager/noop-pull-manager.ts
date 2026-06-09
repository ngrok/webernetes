/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type * as context from "../../../../go/context";
import type { GetPodCredentials, ImagePullManager } from "./interfaces";

// Models kubernetes/pkg/kubelet/images/pullmanager/noop_pull_manager.go NoopImagePullManager.
export class NoopImagePullManager implements ImagePullManager {
	async recordPullIntent(_image: string): Promise<Error | undefined> {
		return undefined;
	}

	async recordImagePulled(
		_ctx: context.Context,
		_image: string,
		_imageRef: string,
		_credentials: unknown | undefined,
	): Promise<void> {}

	async recordImagePullFailed(_ctx: context.Context, _image: string): Promise<void> {}

	// Models kubernetes/pkg/kubelet/images/pullmanager/noop_pull_manager.go NoopImagePullManager.MustAttemptImagePull.
	async mustAttemptImagePull(
		_ctx: context.Context,
		_image: string,
		_imageRef: string,
		_getPodCredentials: GetPodCredentials,
	): Promise<[pullRequired: boolean, err: Error | undefined]> {
		return [false, undefined];
	}
}
