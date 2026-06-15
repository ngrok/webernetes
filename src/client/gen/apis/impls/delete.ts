import { getClock } from "../../../../clock-context";
import type { Store, Storable } from "../../../../cluster/storage";
import type * as context from "../../../../go/context";
import { BadRequest, Invalid, NotFound } from "../../../errors";
import type { V1DeleteOptions } from "../../models";
import { validateDeletePreconditions } from "./resource-version";

export const finalizerDeleteDependents = "foregroundDeletion";
export const finalizerOrphanDependents = "orphan";

export type DeletePropagationPolicy = "Background" | "Foreground" | "Orphan";

export interface DeleteRequest {
	body?: V1DeleteOptions;
	gracePeriodSeconds?: number;
	orphanDependents?: boolean;
	propagationPolicy?: string;
}

export interface DeleteResourceOptions {
	defaultGracePeriodSeconds?: number;
	defaultPropagationPolicy?: DeletePropagationPolicy;
	orphanDependentsFalsePolicy?: DeletePropagationPolicy;
}

export async function deleteResource<T extends Storable>(
	ctx: context.Context,
	store: Store<T>,
	resourceKind: string,
	name: string,
	namespace: string | undefined,
	request: DeleteRequest,
	options: DeleteResourceOptions = {},
): Promise<T> {
	const existing = await store.get(name, namespace);
	if (!existing) {
		throw new NotFound(`${resourceKind} "${name}" not found`);
	}
	validateDeletePreconditions(resourceKind, name, request.body, existing);

	const finalizers = existing.metadata?.finalizers ?? [];
	const deleteOptions = normalizeDeleteOptions(request, options, finalizers);
	const gracePeriodSeconds =
		request.gracePeriodSeconds ??
		request.body?.gracePeriodSeconds ??
		options.defaultGracePeriodSeconds;

	if (existing.metadata?.deletionTimestamp) {
		const shortened = shortenedGracePeriod(existing, gracePeriodSeconds);
		const nextFinalizers = deletionFinalizers(finalizers, deleteOptions.propagationPolicy);
		const finalizersChanged = !stringSetsEqual(finalizers, nextFinalizers);
		if (shortened !== undefined || finalizersChanged) {
			const updated = structuredClone(existing);
			updated.metadata ??= {};
			if (shortened !== undefined) {
				updated.metadata.deletionGracePeriodSeconds = shortened;
			}
			if (finalizersChanged) {
				updated.metadata.finalizers = nextFinalizers.length > 0 ? nextFinalizers : undefined;
			}
			const result = await store.update(name, updated, { skipValidateUpdate: true });
			if (nextFinalizers.length === 0 && gracePeriodExpired(ctx, result, gracePeriodSeconds)) {
				await store.delete(name, namespace);
			}
			return result;
		}
		if (finalizers.length === 0 && gracePeriodExpired(ctx, existing, gracePeriodSeconds)) {
			await store.delete(name, namespace);
		}
		return existing;
	}

	const nextFinalizers = deletionFinalizers(finalizers, deleteOptions.propagationPolicy);
	if (
		nextFinalizers.length === 0 &&
		(gracePeriodSeconds === undefined || gracePeriodSeconds === 0)
	) {
		await store.delete(name, namespace);
		return existing;
	}

	const updated = structuredClone(existing);
	updated.metadata ??= {};
	updated.metadata.deletionTimestamp = getClock(ctx).now();
	if (gracePeriodSeconds !== undefined) {
		updated.metadata.deletionGracePeriodSeconds = gracePeriodSeconds;
	}
	updated.metadata.finalizers = nextFinalizers.length > 0 ? nextFinalizers : undefined;
	return await store.update(name, updated, { skipValidateUpdate: true });
}

export function normalizeDeleteOptions(
	request: DeleteRequest,
	options: DeleteResourceOptions = {},
	existingFinalizers: readonly string[] = [],
): { propagationPolicy: DeletePropagationPolicy } {
	validateDeleteOptionsBody(request.body);
	const orphanDependents = firstDefined(request.orphanDependents, request.body?.orphanDependents);
	const propagationPolicy = firstDefined(
		request.propagationPolicy,
		request.body?.propagationPolicy,
	);

	if (orphanDependents !== undefined && typeof orphanDependents !== "boolean") {
		throw new BadRequest("DeleteOptions.orphanDependents must be a boolean");
	}
	if (propagationPolicy !== undefined && typeof propagationPolicy !== "string") {
		throw new BadRequest("DeleteOptions.propagationPolicy must be a string");
	}
	if (orphanDependents !== undefined && propagationPolicy !== undefined) {
		throw new Invalid(
			`DeleteOptions.meta.k8s.io "" is invalid: propagationPolicy: Invalid value: "${propagationPolicy}": orphanDependents and deletionPropagation cannot be both set`,
		);
	}

	if (orphanDependents === true) {
		return { propagationPolicy: "Orphan" };
	}
	if (orphanDependents === false) {
		return {
			propagationPolicy:
				options.orphanDependentsFalsePolicy ?? options.defaultPropagationPolicy ?? "Background",
		};
	}
	if (propagationPolicy !== undefined) {
		if (
			propagationPolicy !== "Background" &&
			propagationPolicy !== "Foreground" &&
			propagationPolicy !== "Orphan"
		) {
			throw new Invalid(
				`DeleteOptions.meta.k8s.io "" is invalid: propagationPolicy: Unsupported value: "${propagationPolicy}": supported values: "Foreground", "Background", "Orphan", "nil"`,
			);
		}
		return { propagationPolicy };
	}
	if (existingFinalizers.includes(finalizerOrphanDependents)) {
		return { propagationPolicy: "Orphan" };
	}
	if (existingFinalizers.includes(finalizerDeleteDependents)) {
		return { propagationPolicy: "Foreground" };
	}
	return { propagationPolicy: options.defaultPropagationPolicy ?? "Background" };
}

export function removeFinalizer<T extends Storable>(resource: T, finalizer: string): T {
	const updated = structuredClone(resource);
	const finalizers = (updated.metadata?.finalizers ?? []).filter((value) => value !== finalizer);
	updated.metadata ??= {};
	updated.metadata.finalizers = finalizers.length > 0 ? finalizers : undefined;
	return updated;
}

function validateDeleteOptionsBody(body: V1DeleteOptions | undefined): void {
	if (body === undefined) {
		return;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new BadRequest("DeleteOptions body must be an object");
	}
}

function deletionFinalizers(
	existing: readonly string[],
	policy: DeletePropagationPolicy,
): string[] {
	const finalizers = existing.filter(
		(finalizer) =>
			finalizer !== finalizerDeleteDependents && finalizer !== finalizerOrphanDependents,
	);
	if (policy === "Foreground") {
		finalizers.push(finalizerDeleteDependents);
	}
	if (policy === "Orphan") {
		finalizers.push(finalizerOrphanDependents);
	}
	return finalizers;
}

function gracePeriodExpired<T extends Storable>(
	ctx: context.Context,
	resource: T,
	gracePeriodSeconds: number | undefined,
): boolean {
	const grace = effectiveGracePeriod(resource, gracePeriodSeconds);
	if (grace <= 0) {
		return true;
	}
	const deletedAt = timestampMs(resource.metadata?.deletionTimestamp);
	return deletedAt !== undefined && getClock(ctx).now().getTime() - deletedAt >= grace * 1000;
}

function effectiveGracePeriod<T extends Storable>(
	resource: T,
	gracePeriodSeconds: number | undefined,
): number {
	const current = resource.metadata?.deletionGracePeriodSeconds;
	if (current !== undefined && gracePeriodSeconds !== undefined) {
		return Math.min(current, gracePeriodSeconds);
	}
	return current ?? gracePeriodSeconds ?? 0;
}

function shortenedGracePeriod<T extends Storable>(
	resource: T,
	gracePeriodSeconds: number | undefined,
): number | undefined {
	const current = resource.metadata?.deletionGracePeriodSeconds;
	if (current === undefined || gracePeriodSeconds === undefined || gracePeriodSeconds >= current) {
		return undefined;
	}
	return gracePeriodSeconds;
}

function timestampMs(value: Date | string | undefined): number | undefined {
	if (value instanceof Date) {
		return value.getTime();
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

function firstDefined<T>(left: T | undefined, right: T | undefined): T | undefined {
	return left !== undefined ? left : right;
}

function stringSetsEqual(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) {
		return false;
	}
	const rightSet = new Set(right);
	return left.every((value) => rightSet.has(value));
}
