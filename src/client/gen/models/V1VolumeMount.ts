export interface V1VolumeMount {
	mountPath: string;
	mountPropagation?: string;
	name: string;
	readOnly?: boolean;
	recursiveReadOnly?: string;
	subPath?: string;
	subPathExpr?: string;
}
