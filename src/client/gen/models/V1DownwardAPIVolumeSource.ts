import { V1DownwardAPIVolumeFile } from "./V1DownwardAPIVolumeFile";
export interface V1DownwardAPIVolumeSource {
	defaultMode?: number;
	items?: Array<V1DownwardAPIVolumeFile>;
}
