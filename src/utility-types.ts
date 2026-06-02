export type DeepPartial<T> = T extends (...args: never[]) => unknown
	? T
	: T extends Date
		? T
		: T extends readonly (infer U)[]
			? Array<DeepPartial<U>>
			: T extends object
				? { [K in keyof T]?: DeepPartial<T[K]> }
				: T;
