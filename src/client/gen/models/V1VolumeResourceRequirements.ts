export interface V1VolumeResourceRequirements {
	limits?: {
		[key: string]: string;
	};
	requests?: {
		[key: string]: string;
	};
}
