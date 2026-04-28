export type DnsRecordType = "A" | "AAAA" | "CNAME" | "SRV";

export interface DnsRequest {
	name: string;
	type: DnsRecordType;
}

export interface DnsResponse {
	rcode: "NOERROR" | "NXDOMAIN" | "SERVFAIL";
	answers: DnsAnswer[];
}

export type DnsAnswer =
	| { type: "A" | "AAAA"; name: string; address: string; ttl: number }
	| { type: "CNAME"; name: string; target: string; ttl: number }
	| { type: "SRV"; name: string; target: string; port: number; ttl: number };

export type DnsHandler = (request: DnsRequest) => Promise<DnsResponse>;

export class DnsListener {
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
