import type { Clock } from "../../../clock";
import { Channel, type SendChannel } from "../../../go/channel";
import type * as context from "../../../go/context";
import type { ImageManagerService, ImageSpec, PodSandboxConfig } from "../../cri";

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
		private readonly clock: Clock,
		private readonly imageService: ImageManagerService,
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
				const startTime = this.clock.nowMs();
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
					pullDuration: this.clock.nowMs() - startTime,
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
	clock: Clock,
	imageService: ImageManagerService,
	maxParallelImagePulls?: number,
): ImagePuller {
	return new ParallelImagePuller(clock, imageService, maxParallelImagePulls);
}
