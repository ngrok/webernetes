import { V1EndpointSlice } from "../../client";
import { Etcd } from "../etcd";
import { Store } from "./store";

export class EndpointSliceStore extends Store<V1EndpointSlice> {
	constructor(etcd: Etcd) {
		super(etcd, {
			apiVersion: "discovery.k8s.io/v1",
			defaultQualifiedResource: "discovery.k8s.io/endpointslices",
			kind: "EndpointSlice",
			singularQualifiedResource: "discovery.k8s.io/endpointslice",
			namespaced: true,
		});
	}

	protected async validateCreate(endpointSlice: V1EndpointSlice): Promise<void> {
		if (!endpointSlice.metadata?.name) {
			throw new Error("EndpointSlice name is required");
		}

		if (!endpointSlice.addressType) {
			throw new Error("EndpointSlice addressType is required");
		}

		if (!endpointSlice.endpoints) {
			throw new Error("EndpointSlice endpoints are required");
		}
	}

	protected async validateUpdate(
		endpointSlice: V1EndpointSlice,
		_existing: V1EndpointSlice,
	): Promise<void> {
		await this.validateCreate(endpointSlice);
	}
}
