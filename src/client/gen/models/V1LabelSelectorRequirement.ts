export interface V1LabelSelectorRequirement {
	key: string;
	operator: string;
	values?: Array<string>;
}
