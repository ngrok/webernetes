import type { Clock } from "../../../clock";
import type * as context from "../../../go/context";
import {
	newTokenBucketRateLimiterWithClock,
	type RateLimiter,
} from "../../../client-go/util/flowcontrol/throttle";
import type { ImageFsInfoResponse, PodSandboxConfig } from "../../cri";
import type { Image, ImageService, ImageSpec, ImageStats } from "../container";

// Models kubernetes/pkg/kubelet/images/helpers.go throttleImagePulling.
export function throttleImagePulling(
	imageService: ImageService,
	qps: number | undefined,
	burst: number | undefined,
	clock: Clock,
): ImageService {
	if (qps === undefined || qps === 0.0) {
		return imageService;
	}
	return new ThrottledImageService(
		imageService,
		newTokenBucketRateLimiterWithClock(qps, burst ?? 0, clock),
	);
}

// Models kubernetes/pkg/kubelet/images/helpers.go throttledImageService.
class ThrottledImageService implements ImageService {
	constructor(
		private readonly imageService: ImageService,
		private readonly limiter: RateLimiter,
	) {}

	// Models kubernetes/pkg/kubelet/images/helpers.go throttledImageService.PullImage.
	async pullImage(
		ctx: context.Context,
		image: ImageSpec,
		credentials: unknown[],
		podSandboxConfig: PodSandboxConfig,
	): Promise<[imageRef: string, credentialsUsed: unknown | undefined, err: Error | undefined]> {
		if (this.limiter.tryAccept()) {
			return await this.imageService.pullImage(ctx, image, credentials, podSandboxConfig);
		}
		return ["", undefined, new Error("pull QPS exceeded")];
	}

	async getImageRef(
		ctx: context.Context,
		image: ImageSpec,
	): Promise<[imageRef: string, err: Error | undefined]> {
		return await this.imageService.getImageRef(ctx, image);
	}

	async listImages(ctx: context.Context): Promise<[images: Image[], err: Error | undefined]> {
		return await this.imageService.listImages(ctx);
	}

	async removeImage(ctx: context.Context, image: ImageSpec): Promise<Error | undefined> {
		return await this.imageService.removeImage(ctx, image);
	}

	async imageStats(
		ctx: context.Context,
	): Promise<[imageStats: ImageStats | undefined, err: Error | undefined]> {
		return await this.imageService.imageStats(ctx);
	}

	async imageFsInfo(
		ctx: context.Context,
	): Promise<[imageFsInfo: ImageFsInfoResponse | undefined, err: Error | undefined]> {
		return await this.imageService.imageFsInfo(ctx);
	}

	async getImageSize(
		ctx: context.Context,
		image: ImageSpec,
	): Promise<[imageSize: number, err: Error | undefined]> {
		return await this.imageService.getImageSize(ctx, image);
	}
}
