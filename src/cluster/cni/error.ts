export class NetworkError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "NetworkError";
	}
}
