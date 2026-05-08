import { CoreV1Event } from "./CoreV1Event";
import { V1ListMeta } from "./V1ListMeta";

export interface CoreV1EventList {
	apiVersion?: string;
	items: CoreV1Event[];
	kind?: string;
	metadata?: V1ListMeta;
}
