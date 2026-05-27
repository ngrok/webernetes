import type { V1ObjectReference, V1Pod } from "../../../client";
import type { Clock } from "../../../clock";
import type { Backoff } from "../../../client-go/util/flowcontrol/backoff";
import { Channel, select } from "../../../go/channel";
import * as context from "../../../go/context";
import type { PodSandboxConfig } from "../../cri";
import type { EventRecorder } from "../../events";
import { parseImageName } from "../../../util/parsers/parsers";
import type { ImageService, ImageSpec } from "../container";
import { newParallelImagePuller, type ImagePuller, type PullResult } from "./puller";
import { ImagePullError, type ImageManager } from "./types";

export interface NewImageManagerOptions {
	recorder: EventRecorder;
	imageService: ImageService;
	clock: Clock;
	imageBackOff: Backoff;
	imagePullManager?: ImagePullManager;
	puller?: ImagePuller;
	podPullingTimeRecorder?: ImagePodPullingTimeRecorder;
	maxParallelImagePulls?: number;
}

// Models kubernetes/pkg/kubelet/images/image_manager.go ImagePodPullingTimeRecorder.
export interface ImagePodPullingTimeRecorder {
	recordImageStartedPulling(podUID: string): void;
	recordImageFinishedPulling(podUID: string): void;
}

interface ImagePullManager {
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
		getPodCredentials: () => Promise<[pullCredentials: unknown[], err: Error | undefined]>,
	): Promise<[pullRequired: boolean, err: Error | undefined]>;
}

// Models kubernetes/pkg/kubelet/images/pullmanager/noop_pull_manager.go NoopImagePullManager.
class NoopImagePullManager implements ImagePullManager {
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
		_getPodCredentials: () => Promise<[pullCredentials: unknown[], err: Error | undefined]>,
	): Promise<[pullRequired: boolean, err: Error | undefined]> {
		return [false, undefined];
	}
}

class NoopImagePodPullingTimeRecorder implements ImagePodPullingTimeRecorder {
	recordImageStartedPulling(_podUID: string): void {}
	recordImageFinishedPulling(_podUID: string): void {}
}

// Models kubernetes/pkg/kubelet/images/image_manager.go imageManager.
export class KubeletImageManager implements ImageManager {
	private readonly recorder: EventRecorder;
	private readonly imageService: ImageService;
	private readonly imagePullManager: ImagePullManager;
	private readonly clock: Clock;
	private readonly backOff: Backoff;
	private readonly prevPullErrMsg = new Map<string, string>();
	private readonly puller: ImagePuller;
	private readonly podPullingTimeRecorder: ImagePodPullingTimeRecorder;

	constructor(options: NewImageManagerOptions) {
		this.recorder = options.recorder;
		this.imageService = options.imageService;
		this.imagePullManager = options.imagePullManager ?? new NoopImagePullManager();
		this.clock = options.clock;
		this.backOff = options.imageBackOff;
		this.puller =
			options.puller ??
			newParallelImagePuller(this.clock, this.imageService, options.maxParallelImagePulls);
		this.podPullingTimeRecorder =
			options.podPullingTimeRecorder ?? new NoopImagePodPullingTimeRecorder();
	}

	// Models kubernetes/pkg/kubelet/images/image_manager.go EnsureImageExists.
	async ensureImageExists(
		ctx: context.Context,
		objRef: V1ObjectReference | undefined,
		pod: V1Pod,
		requestedImage: string,
		_pullSecrets: unknown[],
		podSandboxConfig: PodSandboxConfig,
		podRuntimeHandler: string,
		pullPolicy: string | undefined,
	): Promise<[imageRef: string, message: string, err: Error | undefined]> {
		const logPrefix = `${pod.metadata?.namespace ?? ""}/${pod.metadata?.name ?? ""}/${requestedImage}`;
		if (!pullPolicy) {
			pullPolicy = "IfNotPresent";
		}
		const [image, tagErr] = applyDefaultImageTag(requestedImage);
		if (tagErr) {
			const msg = `Failed to apply default image tag "${requestedImage}": ${tagErr.message}`;
			await this.logIt(objRef, "Warning", "InspectFailed", logPrefix, msg);
			return ["", msg, new ImagePullError("InvalidImageName", msg)];
		}
		const spec: ImageSpec = {
			image,
			runtimeHandler: podRuntimeHandler,
			annotations: Object.entries(pod.metadata?.annotations ?? {}).map(([name, value]) => ({
				name,
				value,
			})),
		};

		const [imageRef, _imagePresentLocally, message, pullErr] = await this.imagePullPrecheck(
			ctx,
			objRef,
			logPrefix,
			pullPolicy,
			spec,
			requestedImage,
		);
		if (pullErr) {
			return ["", message, pullErr];
		}

		const lookupPullCredentials = this.makeLookupPullCredentialsFunc(
			spec.image,
			pod,
			_pullSecrets,
			podSandboxConfig,
		);
		const getPodCredentials = async () => lookupPullCredentials();

		if (imageRef !== "") {
			const [pullRequired, err] = await this.imagePullManager.mustAttemptImagePull(
				ctx,
				requestedImage,
				imageRef,
				getPodCredentials,
			);
			if (err !== undefined) {
				return ["", err.message, err];
			}
			if (!pullRequired) {
				const msg = `Container image "${requestedImage}" already present on machine and can be accessed by the pod`;
				await this.logIt(objRef, "Normal", "Pulled", logPrefix, msg);
				this.podPullingTimeRecorder.recordImageFinishedPulling(pod.metadata?.uid ?? "");
				return [imageRef, msg, undefined];
			}
		}

		if (pullPolicy === "Never") {
			return this.imageNotPresentOnNeverPolicyError(logPrefix, objRef, requestedImage);
		}

		const [pullCredentials, credentialsErr] = await lookupPullCredentials();
		if (credentialsErr !== undefined) {
			return ["", credentialsErr.message, credentialsErr];
		}
		return await this.pullImage(
			ctx,
			logPrefix,
			objRef,
			pod.metadata?.uid ?? "",
			requestedImage,
			spec,
			pullCredentials,
			podSandboxConfig,
		);
	}

	// Models kubernetes/pkg/kubelet/images/image_manager.go makeLookupPullCredentialsFunc.
	private makeLookupPullCredentialsFunc(
		image: string,
		_pod: V1Pod,
		_pullSecrets: unknown[],
		_podSandboxConfig: PodSandboxConfig,
	): () => Promise<[pullCredentials: unknown[], err: Error | undefined]> {
		let pullCredentials: unknown[] | undefined;
		return async () => {
			if (pullCredentials === undefined) {
				const [, , , err] = parseImageName(image);
				if (err !== undefined) {
					return [[], err];
				}
				pullCredentials = [];
			}
			return [pullCredentials, undefined];
		};
	}

	// Models kubernetes/pkg/kubelet/images/image_manager.go pullImage.
	private async pullImage(
		ctx: context.Context,
		logPrefix: string,
		objRef: V1ObjectReference | undefined,
		podUID: string,
		image: string,
		spec: ImageSpec,
		pullCredentials: unknown[],
		podSandboxConfig: PodSandboxConfig,
	): Promise<[imageRef: string, message: string, err: Error | undefined]> {
		let imageRef = "";
		let pullSucceeded = false;
		let finalPullCredentials: unknown | undefined;

		const recordPullIntentErr = await this.imagePullManager.recordPullIntent(image);
		if (recordPullIntentErr !== undefined) {
			return [
				"",
				`Failed to record image pull intent for container image "${image}": ${recordPullIntentErr.message}`,
				recordPullIntentErr,
			];
		}

		try {
			const backOffKey = `${podUID}_${image}`;
			if (this.backOff.isInBackOffSinceUpdate(backOffKey, this.clock.now())) {
				let msg = `Back-off pulling image "${image}"`;
				await this.logIt(objRef, "Normal", "BackOff", logPrefix, msg);
				const prevPullErrMsg = this.prevPullErrMsg.get(backOffKey);
				if (prevPullErrMsg !== undefined) {
					msg = `${msg}: ${prevPullErrMsg}`;
				}
				return ["", msg, new ImagePullError("ImagePullBackOff", msg)];
			}
			this.prevPullErrMsg.delete(backOffKey);

			this.podPullingTimeRecorder.recordImageStartedPulling(podUID);
			await this.logIt(objRef, "Normal", "Pulling", logPrefix, `Pulling image "${image}"`);
			const startTime = this.clock.nowMs();

			const pullChan = new Channel<PullResult>();
			this.puller.pullImage(ctx, spec, pullCredentials, pullChan, podSandboxConfig);
			const selected = await select()
				.case(pullChan, ({ value }) => ({ kind: "pull" as const, value: value as PullResult }))
				.case(ctx.done(), () => ({ kind: "canceled" as const }));
			if (selected.kind === "canceled") {
				throw ctx.err() ?? context.Canceled;
			}
			const imagePullResult = selected.value;
			if (imagePullResult.err !== undefined) {
				await this.logIt(
					objRef,
					"Warning",
					"Failed",
					logPrefix,
					`Failed to pull image "${image}": ${imagePullResult.err.message}`,
				);
				this.backOff.next(backOffKey, this.clock.now());
				const [errMsg, err] = evalCRIPullErr(image, imagePullResult.err);
				this.prevPullErrMsg.set(backOffKey, `${err.message}: ${errMsg}`);
				return ["", errMsg, err];
			}

			this.podPullingTimeRecorder.recordImageFinishedPulling(podUID);
			const imagePullDuration = Math.trunc(this.clock.nowMs() - startTime);
			const pullDuration = Math.trunc(imagePullResult.pullDuration);
			await this.logIt(
				objRef,
				"Normal",
				"Pulled",
				logPrefix,
				`Successfully pulled image "${image}" in ${pullDuration}ms (${imagePullDuration}ms including waiting). Image size: ${imagePullResult.imageSize} bytes.`,
			);
			this.backOff.gc();
			finalPullCredentials = imagePullResult.credentialsUsed;
			pullSucceeded = true;
			imageRef = imagePullResult.imageRef;

			return [imageRef, "", undefined];
		} finally {
			if (pullSucceeded) {
				await this.imagePullManager.recordImagePulled(ctx, image, imageRef, finalPullCredentials);
			} else {
				await this.imagePullManager.recordImagePullFailed(ctx, image);
			}
		}
	}

	// Models kubernetes/pkg/kubelet/images/image_manager.go imagePullPrecheck.
	private async imagePullPrecheck(
		ctx: context.Context,
		objRef: V1ObjectReference | undefined,
		logPrefix: string,
		pullPolicy: string | undefined,
		spec: ImageSpec,
		requestedImage: string,
	): Promise<
		[imageRef: string, imageFound: boolean | undefined, message: string, err: Error | undefined]
	> {
		let imageRef = "";
		switch (pullPolicy) {
			case "Always":
				return ["", undefined, "", undefined];
			case "IfNotPresent":
			case "Never":
				{
					const [ref, err] = await this.imageService.getImageRef(ctx, spec);
					imageRef = ref;
					if (err) {
						const msg = `Failed to inspect image "${imageRef}": ${err.message}`;
						await this.logIt(objRef, "Warning", "InspectFailed", logPrefix, msg);
						return ["", undefined, msg, new ImagePullError("ErrImageInspect", msg)];
					}
				}
				break;
		}

		const imageFound = imageRef.length > 0;
		if (!imageFound && pullPolicy === "Never") {
			const [, msg, err] = await this.imageNotPresentOnNeverPolicyError(
				logPrefix,
				objRef,
				requestedImage,
			);
			return ["", false, msg, err];
		}

		return [imageRef, imageFound, "", undefined];
	}

	// Models kubernetes/pkg/kubelet/images/image_manager.go logIt.
	private async logIt(
		objRef: V1ObjectReference | undefined,
		eventType: "Normal" | "Warning",
		event: string,
		prefix: string,
		msg: string,
	): Promise<void> {
		void prefix;
		if (objRef !== undefined) {
			await this.recorder.event(objRef, eventType, event, msg);
		}
	}

	// Models kubernetes/pkg/kubelet/images/image_manager.go imageNotPresentOnNeverPolicyError.
	private async imageNotPresentOnNeverPolicyError(
		logPrefix: string,
		objRef: V1ObjectReference | undefined,
		requestedImage: string,
	): Promise<[imageRef: string, message: string, err: Error | undefined]> {
		const msg = `Container image "${requestedImage}" is not present with pull policy of Never`;
		const err = new ImagePullError("ErrImageNeverPull", msg);
		await this.logIt(objRef, "Warning", "ErrImageNeverPull", logPrefix, msg);
		return ["", msg, err];
	}
}

// Models kubernetes/pkg/kubelet/images/image_manager.go applyDefaultImageTag.
function applyDefaultImageTag(image: string): [string, Error | undefined] {
	const [, tag, digest, err] = parseImageName(image);
	if (err) {
		return ["", err];
	}
	if (digest === "" && tag !== "" && !image.endsWith(`:${tag}`)) {
		image = `${image}:${tag}`;
	}
	return [image, undefined];
}

// Models kubernetes/pkg/kubelet/images/image_manager.go evalCRIPullErr.
export function evalCRIPullErr(image: string, err: Error): [errMsg: string, errRes: Error] {
	if (err.message.startsWith(errRegistryUnavailable)) {
		const errMsg = `image pull failed for ${image} because the registry is unavailable${err.message.slice(errRegistryUnavailable.length)}`;
		return [errMsg, new ImagePullError("RegistryUnavailable", errMsg)];
	}

	if (err.message.startsWith(errSignatureValidationFailed)) {
		const errMsg = `image pull failed for ${image} because the signature validation failed${err.message.slice(errSignatureValidationFailed.length)}`;
		return [errMsg, new ImagePullError("SignatureValidationFailed", errMsg)];
	}

	return [err.message, new ImagePullError("ErrImagePull", err.message)];
}

const errRegistryUnavailable = "RegistryUnavailable";
const errSignatureValidationFailed = "SignatureValidationFailed";
