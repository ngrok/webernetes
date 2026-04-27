import { V1ListMeta } from "./V1ListMeta";
import { V1Service } from "./V1Service";

export interface V1ServiceList {
	apiVersion?: string;
	items: Array<V1Service>;
	kind?: string;
	metadata?: V1ListMeta;
}
