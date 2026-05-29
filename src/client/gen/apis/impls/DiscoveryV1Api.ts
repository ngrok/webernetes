import { EndpointSliceStore } from "../../../../cluster/storage";
import type { Etcd } from "../../../../cluster/etcd";
import { NotFound } from "../../../errors";
import { filterByLabels, parseLabelSelector } from "../../../labels";
import { V1EndpointSlice, V1EndpointSliceList, V1Status } from "../../models";
import type {
	DiscoveryV1ApiCreateNamespacedEndpointSliceRequest,
	DiscoveryV1ApiDeleteNamespacedEndpointSliceRequest,
	DiscoveryV1Api as DiscoveryV1ApiInterface,
	DiscoveryV1ApiListEndpointSliceForAllNamespacesRequest,
	DiscoveryV1ApiListNamespacedEndpointSliceRequest,
	DiscoveryV1ApiReadNamespacedEndpointSliceRequest,
	DiscoveryV1ApiReplaceNamespacedEndpointSliceRequest,
} from "../types/DiscoveryV1Api";
import { rethrowApiErrors } from "./errors";
import { listResourceVersionOptions, validateDeletePreconditions } from "./resource-version";

export interface DiscoveryV1ApiOptions {
	etcd: Etcd;
}

export class DiscoveryV1Api implements DiscoveryV1ApiInterface {
	private readonly endpointSlices: EndpointSliceStore;

	public constructor(options: DiscoveryV1ApiOptions) {
		this.endpointSlices = new EndpointSliceStore(options.etcd);
	}

	public async createNamespacedEndpointSlice(
		request: DiscoveryV1ApiCreateNamespacedEndpointSliceRequest,
	): Promise<V1EndpointSlice> {
		return await rethrowApiErrors(async () => {
			request.body.metadata ??= {};
			request.body.metadata.namespace ??= request.namespace;
			return await this.endpointSlices.create(request.body);
		});
	}

	public async deleteNamespacedEndpointSlice(
		request: DiscoveryV1ApiDeleteNamespacedEndpointSliceRequest,
	): Promise<V1Status> {
		return await rethrowApiErrors(async () => {
			const endpointSlice = await this.endpointSlices.get(request.name, request.namespace);
			if (!endpointSlice) {
				throw new NotFound(`EndpointSlice "${request.name}" not found`);
			}
			validateDeletePreconditions("EndpointSlice", request.name, request.body, endpointSlice);

			await this.endpointSlices.delete(request.name, request.namespace);
			return {
				apiVersion: "v1",
				kind: "Status",
				status: "Success",
			};
		});
	}

	public async listEndpointSliceForAllNamespaces(
		request: DiscoveryV1ApiListEndpointSliceForAllNamespacesRequest = {},
	): Promise<V1EndpointSliceList> {
		return await rethrowApiErrors(async () => {
			const selector = parseLabelSelector(request.labelSelector);
			const list = await this.endpointSlices.listWithResourceVersion(
				undefined,
				listResourceVersionOptions(request),
			);
			return {
				apiVersion: "discovery.k8s.io/v1",
				kind: "EndpointSliceList",
				metadata: { resourceVersion: list.resourceVersion },
				items: filterByLabels(list.items, selector),
			};
		});
	}

	public async listNamespacedEndpointSlice(
		request: DiscoveryV1ApiListNamespacedEndpointSliceRequest,
	): Promise<V1EndpointSliceList> {
		return await rethrowApiErrors(async () => {
			const selector = parseLabelSelector(request.labelSelector);
			const list = await this.endpointSlices.listWithResourceVersion(
				request.namespace,
				listResourceVersionOptions(request),
			);
			return {
				apiVersion: "discovery.k8s.io/v1",
				kind: "EndpointSliceList",
				metadata: { resourceVersion: list.resourceVersion },
				items: filterByLabels(list.items, selector),
			};
		});
	}

	public async readNamespacedEndpointSlice(
		request: DiscoveryV1ApiReadNamespacedEndpointSliceRequest,
	): Promise<V1EndpointSlice> {
		return await rethrowApiErrors(async () => {
			const endpointSlice = await this.endpointSlices.get(request.name, request.namespace);
			if (!endpointSlice) {
				throw new NotFound(`EndpointSlice "${request.name}" not found`);
			}

			return endpointSlice;
		});
	}

	public async replaceNamespacedEndpointSlice(
		request: DiscoveryV1ApiReplaceNamespacedEndpointSliceRequest,
	): Promise<V1EndpointSlice> {
		return await rethrowApiErrors(async () => {
			request.body.metadata ??= {};
			request.body.metadata.name = request.name;
			request.body.metadata.namespace ??= request.namespace;
			return await this.endpointSlices.update(request.name, request.body);
		});
	}
}
