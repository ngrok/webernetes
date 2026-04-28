export interface HttpRequest {
	method?: string;
	path?: string;
	headers?: Record<string, string>;
	body?: string;
}

export interface HttpResponse {
	status: number;
	headers?: Record<string, string>;
	body?: string;
}

export type HttpHandler = (request: HttpRequest) => Promise<HttpResponse>;

export class HttpListener {
	private closed = false;

	constructor(
		readonly ip: string,
		readonly port: number,
		private readonly onClose: () => void,
	) {}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.onClose();
	}
}
