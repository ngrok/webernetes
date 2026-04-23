export interface V1LinuxContainerUser {
	gid: number;
	supplementalGroups?: Array<number>;
	uid: number;
}
