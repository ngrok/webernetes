import type { Clock } from "../../../clock";
import { Channel, select } from "../../../go/channel";
import * as context from "../../../go/context";
import * as time from "../../../go/time";
import * as http from "../../cni/http";
import { NetworkError, type ClusterNetwork } from "../../cni";
import type { ProbeResult } from "../probe";

// Models kubernetes/pkg/probe/http/http.go maxRespBodyLength.
const maxRespBodyLength = (10 * 1) << 10;

export interface GetHTTPInterface {
	do(ctx: context.Context, req: http.Request): Promise<http.Response>;
}

export class HTTPProber {
	private readonly client: GetHTTPInterface;

	constructor(
		private readonly ctx: context.Context,
		private readonly clock: Clock,
		private readonly network: ClusterNetwork,
		private readonly followNonLocalRedirects = false,
	) {
		this.client = new ClusterNetworkHTTPClient(this.network, this.followNonLocalRedirects);
	}

	// Models kubernetes/pkg/probe/http/http.go Probe.
	async probe(
		req: http.Request,
		timeoutMs: number,
	): Promise<[ProbeResult, string, Error | undefined]> {
		const [ctx, cancel] = context.withCancel(this.ctx);
		const resultCh = new Channel<[ProbeResult, string, Error | undefined]>(1);
		void doHTTPProbe(ctx, req, this.client).then(
			(result) => resultCh.trySend(result),
			(error) => {
				resultCh.trySend([
					"failure",
					error instanceof Error ? error.message : String(error),
					undefined,
				]);
			},
		);
		try {
			const selected = await select()
				.case(resultCh, ({ value }) => ({ type: "result" as const, result: value }))
				.case(ctx.done(), () => ({ type: "canceled" as const }))
				.case(time.after(this.clock, timeoutMs), () => ({ type: "timeout" as const }));
			if (selected.type === "result") {
				return selected.result ?? ["failure", "HTTP probe failed", undefined];
			}
			if (selected.type === "timeout") {
				cancel();
				return ["failure", "request timed out", undefined];
			}
			return ["failure", context.cause(ctx)?.message ?? "context canceled", undefined];
		} finally {
			cancel();
		}
	}
}

// Models kubernetes/pkg/probe/http/http.go DoHTTPProbe.
export async function doHTTPProbe(
	ctx: context.Context,
	req: http.Request,
	client: GetHTTPInterface,
): Promise<[ProbeResult, string, Error | undefined]> {
	let res: http.Response;
	try {
		res = await client.do(ctx, req);
	} catch (error) {
		if (
			error instanceof NetworkError &&
			error.message.startsWith("network fetch target ") &&
			error.message.endsWith(" must be an IP address")
		) {
			throw error;
		}
		return ["failure", error instanceof Error ? error.message : String(error), undefined];
	}
	const body = res.body.slice(0, maxRespBodyLength);
	if (res.statusCode >= 200 && res.statusCode < 400) {
		if (res.statusCode >= 300) {
			return ["warning", `Probe terminated redirects, Response body: ${body}`, undefined];
		}
		return ["success", body, undefined];
	}
	return ["failure", `HTTP probe failed with statuscode: ${res.statusCode}`, undefined];
}

class ClusterNetworkHTTPClient implements GetHTTPInterface {
	constructor(
		private readonly network: ClusterNetwork,
		readonly _followNonLocalRedirects: boolean,
	) {}

	async do(ctx: context.Context, req: http.Request): Promise<http.Response> {
		return await this.network.fetch(ctx, req.url.toString(), req);
	}
}
