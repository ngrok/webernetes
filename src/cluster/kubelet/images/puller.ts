/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { getClock } from "../../../clock-context";
import { Channel, type SendChannel } from "../../../go/channel";
import type * as context from "../../../go/context";
import type { PodSandboxConfig } from "../../cri";
import type { ImageService, ImageSpec } from "../container";

// Models kubernetes/pkg/kubelet/images/puller.go pullResult.
export interface PullResult {
	imageRef: string;
	imageSize: number;
	err: Error | undefined;
	pullDuration: number;
	credentialsUsed: unknown | undefined;
}

// Models kubernetes/pkg/kubelet/images/puller.go imagePuller.
export interface ImagePuller {
	pullImage(
		ctx: context.Context,
		spec: ImageSpec,
		credentials: unknown[],
		pullChan: SendChannel<PullResult>,
		podSandboxConfig: PodSandboxConfig,
	): void;
}

// Models kubernetes/pkg/kubelet/images/puller.go parallelImagePuller.
class ParallelImagePuller implements ImagePuller {
	private readonly tokens: Channel<void> | undefined;

	constructor(
		private readonly imageService: ImageService,
		maxParallelImagePulls: number | undefined,
	) {
		if (maxParallelImagePulls !== undefined && maxParallelImagePulls >= 1) {
			this.tokens = new Channel<void>(maxParallelImagePulls);
		}
	}

	// Models kubernetes/pkg/kubelet/images/puller.go parallelImagePuller.pullImage.
	pullImage(
		ctx: context.Context,
		spec: ImageSpec,
		credentials: unknown[],
		pullChan: SendChannel<PullResult>,
		podSandboxConfig: PodSandboxConfig,
	): void {
		void (async () => {
			void ctx;
			if (this.tokens !== undefined) {
				await this.tokens.send(undefined);
			}
			try {
				const clock = getClock(ctx);
				const startTime = clock.nowMs();
				const [imageRef, credentialsUsed, err] = await this.imageService.pullImage(
					ctx,
					spec,
					credentials,
					podSandboxConfig,
				);
				let size = 0;
				if (err === undefined && imageRef !== "") {
					[size] = await this.imageService.getImageSize(ctx, spec);
				}
				await pullChan.send({
					imageRef,
					imageSize: size,
					err,
					pullDuration: clock.nowMs() - startTime,
					credentialsUsed,
				});
			} finally {
				if (this.tokens !== undefined) {
					await this.tokens.receive();
				}
			}
		})();
	}
}

// Models kubernetes/pkg/kubelet/images/puller.go newParallelImagePuller.
export function newParallelImagePuller(
	imageService: ImageService,
	maxParallelImagePulls?: number,
): ImagePuller {
	return new ParallelImagePuller(imageService, maxParallelImagePulls);
}
