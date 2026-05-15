export interface V1NodeAllocatableResourceClaimStatus {
	containers?: Array<string>;
	resourceClaimName: string;
	resources: { [key: string]: string };
}
