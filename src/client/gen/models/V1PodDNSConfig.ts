import { V1PodDNSConfigOption } from "./V1PodDNSConfigOption";
export interface V1PodDNSConfig {
	nameservers?: Array<string>;
	options?: Array<V1PodDNSConfigOption>;
	searches?: Array<string>;
}
