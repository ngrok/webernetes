/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import * as k8s from "../client";
import { getControllerOf } from "../apimachinery/pkg/apis/meta/v1/controller_ref";
import { Set as LabelSet } from "../apimachinery/pkg/labels/labels";
import type { Selector } from "../apimachinery/pkg/labels/selector";
import type { GroupVersionKind } from "../apimachinery/pkg/runtime/schema/group_version";
import { newAggregate } from "../apimachinery/pkg/util/errors/errors";
import { isInvalidError, isNotFoundError } from "../client/errors";
import type * as context from "../go/context";
import { Once } from "../go/sync/once";
import type { PodControlInterface } from "./controller-utils";

// Models kubernetes/pkg/controller/controller_ref_manager.go BaseControllerRefManager.
export class BaseControllerRefManager {
	private canAdoptErr: Error | undefined;
	private canAdoptOnce = new Once();

	constructor(
		readonly controller: k8s.KubernetesObject,
		readonly selector: Selector,
		readonly canAdoptFunc?: (ctx: context.Context) => Promise<Error | undefined>,
	) {}

	// Models kubernetes/pkg/controller/controller_ref_manager.go CanAdopt.
	async canAdopt(ctx: context.Context): Promise<Error | undefined> {
		await this.canAdoptOnce.do(async () => {
			if (this.canAdoptFunc) {
				this.canAdoptErr = await this.canAdoptFunc(ctx);
			}
		});
		return this.canAdoptErr;
	}

	// Models kubernetes/pkg/controller/controller_ref_manager.go ClaimObject.
	async claimObject(
		ctx: context.Context,
		obj: k8s.KubernetesObject,
		match: (obj: k8s.KubernetesObject) => boolean,
		adopt: (ctx: context.Context, obj: k8s.KubernetesObject) => Promise<Error | undefined>,
		release: (ctx: context.Context, obj: k8s.KubernetesObject) => Promise<Error | undefined>,
	): Promise<[boolean, Error | undefined]> {
		const controllerRef = getControllerOf(obj);
		if (controllerRef) {
			if (controllerRef.uid !== this.controller.metadata?.uid) {
				return [false, undefined];
			}
			if (match(obj)) {
				return [true, undefined];
			}
			if (this.controller.metadata?.deletionTimestamp) {
				return [false, undefined];
			}
			const err = await release(ctx, obj);
			if (err) {
				if (isNotFoundError(err)) {
					return [false, undefined];
				}
				return [false, err];
			}
			return [false, undefined];
		}

		if (this.controller.metadata?.deletionTimestamp || !match(obj)) {
			return [false, undefined];
		}
		if (obj.metadata?.deletionTimestamp) {
			return [false, undefined];
		}
		const controllerNamespace = this.controller.metadata?.namespace ?? "";
		if (controllerNamespace.length > 0 && controllerNamespace !== (obj.metadata?.namespace ?? "")) {
			return [false, undefined];
		}

		const err = await adopt(ctx, obj);
		if (err) {
			if (isNotFoundError(err)) {
				return [false, undefined];
			}
			return [false, err];
		}
		return [true, undefined];
	}
}

// Models kubernetes/pkg/controller/controller_ref_manager.go PodControllerRefManager.
export class PodControllerRefManager extends BaseControllerRefManager {
	constructor(
		readonly podControl: PodControlInterface,
		controller: k8s.KubernetesObject,
		selector: Selector,
		readonly controllerKind: GroupVersionKind,
		canAdoptFunc?: (ctx: context.Context) => Promise<Error | undefined>,
		readonly finalizers: string[] = [],
	) {
		super(controller, selector, canAdoptFunc);
	}

	// Models kubernetes/pkg/controller/controller_ref_manager.go ClaimPods.
	async claimPods(
		ctx: context.Context,
		pods: k8s.V1Pod[],
		...filters: Array<(pod: k8s.V1Pod) => boolean>
	): Promise<[k8s.V1Pod[], Error | undefined]> {
		const claimed: k8s.V1Pod[] = [];
		const errlist: Error[] = [];

		const match = (obj: k8s.KubernetesObject): boolean => {
			const pod = obj as k8s.V1Pod;
			if (!this.selector.matches(new LabelSet(pod.metadata?.labels))) {
				return false;
			}
			for (const filter of filters) {
				if (!filter(pod)) {
					return false;
				}
			}
			return true;
		};
		const adopt = async (
			adoptCtx: context.Context,
			obj: k8s.KubernetesObject,
		): Promise<Error | undefined> => await this.adoptPod(adoptCtx, obj as k8s.V1Pod);
		const release = async (
			releaseCtx: context.Context,
			obj: k8s.KubernetesObject,
		): Promise<Error | undefined> => await this.releasePod(releaseCtx, obj as k8s.V1Pod);

		for (const pod of pods) {
			const [ok, err] = await this.claimObject(ctx, pod, match, adopt, release);
			if (err) {
				errlist.push(err);
				continue;
			}
			if (ok) {
				claimed.push(pod);
			}
		}
		return [claimed, newAggregate(errlist)];
	}

	// Models kubernetes/pkg/controller/controller_ref_manager.go AdoptPod.
	async adoptPod(ctx: context.Context, pod: k8s.V1Pod): Promise<Error | undefined> {
		const err = await this.canAdopt(ctx);
		if (err) {
			return new Error(
				`can't adopt Pod ${pod.metadata?.namespace}/${pod.metadata?.name} (${pod.metadata?.uid}): ${err.message}`,
			);
		}
		const patchResult = ownerRefControllerPatch(
			this.controller,
			this.controllerKind,
			pod.metadata?.uid,
			this.finalizers,
		);
		const patchBytes = patchResult[0];
		const patchErr = patchResult[1];
		if (patchErr) {
			return patchErr;
		}
		if (!patchBytes) {
			return new Error("ownerRefControllerPatch returned no patch");
		}
		return await this.podControl.patchPod(
			ctx,
			pod.metadata?.namespace ?? "default",
			pod.metadata?.name ?? "",
			patchBytes,
		);
	}

	// Models kubernetes/pkg/controller/controller_ref_manager.go ReleasePod.
	async releasePod(ctx: context.Context, pod: k8s.V1Pod): Promise<Error | undefined> {
		const patchResult = generateDeleteOwnerRefStrategicMergeBytes(
			pod.metadata?.uid,
			[this.controller.metadata?.uid ?? ""],
			this.finalizers,
		);
		const patchBytes = patchResult[0];
		const patchErr = patchResult[1];
		if (patchErr) {
			return patchErr;
		}
		if (!patchBytes) {
			return new Error("GenerateDeleteOwnerRefStrategicMergeBytes returned no patch");
		}
		const err = await this.podControl.patchPod(
			ctx,
			pod.metadata?.namespace ?? "default",
			pod.metadata?.name ?? "",
			patchBytes,
		);
		if (err) {
			if (isNotFoundError(err) || isInvalidError(err)) {
				return undefined;
			}
		}
		return err;
	}
}

// Models kubernetes/pkg/controller/controller_ref_manager.go NewPodControllerRefManager.
export function newPodControllerRefManager(
	podControl: PodControlInterface,
	controller: k8s.KubernetesObject,
	selector: Selector,
	controllerKind: GroupVersionKind,
	canAdopt?: (ctx: context.Context) => Promise<Error | undefined>,
	...finalizers: string[]
): PodControllerRefManager {
	return new PodControllerRefManager(
		podControl,
		controller,
		selector,
		controllerKind,
		canAdopt,
		finalizers,
	);
}

// Models kubernetes/pkg/controller/controller_ref_manager.go RecheckDeletionTimestamp.
export function recheckDeletionTimestamp(
	getObject: (
		ctx: context.Context,
	) => Promise<[k8s.KubernetesObject | undefined, Error | undefined]>,
): (ctx: context.Context) => Promise<Error | undefined> {
	return async (ctx: context.Context): Promise<Error | undefined> => {
		const [obj, err] = await getObject(ctx);
		if (err) {
			return new Error(`can't recheck DeletionTimestamp: ${err.message}`);
		}
		if (obj?.metadata?.deletionTimestamp) {
			return new Error(
				`${obj.metadata.namespace}/${obj.metadata.name} has just been deleted at ${String(
					obj.metadata.deletionTimestamp,
				)}`,
			);
		}
		return undefined;
	};
}

// Models kubernetes/pkg/controller/controller_ref_manager.go objectForAddOwnerRefPatch.
interface ObjectForAddOwnerRefPatch {
	metadata: ObjectMetaForPatch;
}

// Models kubernetes/pkg/controller/controller_ref_manager.go objectMetaForPatch.
interface ObjectMetaForPatch {
	ownerReferences: k8s.V1OwnerReference[];
	uid: string | undefined;
	finalizers?: string[];
}

type MarshalResult = [Uint8Array, undefined] | [undefined, Error];

// Models kubernetes/pkg/controller/controller_ref_manager.go ownerRefControllerPatch.
function ownerRefControllerPatch(
	controller: k8s.KubernetesObject,
	controllerKind: GroupVersionKind,
	uid: string | undefined,
	finalizers: string[],
): MarshalResult {
	const blockOwnerDeletion = true;
	const isController = true;
	const addControllerPatch: ObjectForAddOwnerRefPatch = {
		metadata: {
			uid,
			ownerReferences: [
				{
					apiVersion: controllerKind.groupVersion().toString(),
					kind: controllerKind.kind,
					name: controller.metadata?.name ?? "",
					uid: controller.metadata?.uid ?? "",
					controller: isController,
					blockOwnerDeletion,
				},
			],
			finalizers: finalizers.length > 0 ? finalizers : undefined,
		},
	};
	return jsonMarshal(addControllerPatch);
}

// Models kubernetes/pkg/controller/controller_ref_manager.go objectForDeleteOwnerRefStrategicMergePatch.
interface ObjectForDeleteOwnerRefStrategicMergePatch {
	metadata: ObjectMetaForMergePatch;
}

// Models kubernetes/pkg/controller/controller_ref_manager.go objectMetaForMergePatch.
interface ObjectMetaForMergePatch {
	uid: string | undefined;
	ownerReferences: Array<Record<string, string>>;
	"$deleteFromPrimitiveList/finalizers"?: string[];
}

// Models kubernetes/pkg/controller/controller_ref_manager.go GenerateDeleteOwnerRefStrategicMergeBytes.
function generateDeleteOwnerRefStrategicMergeBytes(
	dependentUID: string | undefined,
	ownerUIDs: string[],
	finalizers: string[],
): MarshalResult {
	const ownerReferences: Array<Record<string, string>> = [];
	for (const ownerUID of ownerUIDs) {
		ownerReferences.push(ownerReference(ownerUID, "delete"));
	}
	const patch: ObjectForDeleteOwnerRefStrategicMergePatch = {
		metadata: {
			uid: dependentUID,
			ownerReferences,
			"$deleteFromPrimitiveList/finalizers": finalizers.length > 0 ? finalizers : undefined,
		},
	};
	return jsonMarshal(patch);
}

// Models kubernetes/pkg/controller/controller_ref_manager.go ownerReference.
function ownerReference(uid: string, patchType: string): Record<string, string> {
	return {
		$patch: patchType,
		uid,
	};
}

// Models encoding/json Marshal.
function jsonMarshal(value: unknown): MarshalResult {
	try {
		return [new TextEncoder().encode(JSON.stringify(value)), undefined];
	} catch (error) {
		return [undefined, error instanceof Error ? error : new Error(String(error))];
	}
}
