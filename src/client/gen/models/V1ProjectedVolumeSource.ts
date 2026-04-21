import { V1VolumeProjection } from "./V1VolumeProjection";
export interface V1ProjectedVolumeSource {
	defaultMode?: number;
	sources?: Array<V1VolumeProjection>;
}
