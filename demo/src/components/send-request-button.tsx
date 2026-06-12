import { Button } from "@ngrok/mantle/button";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react";
import type { MouseEvent } from "react";
import * as w8s from "webernetes";

import {
	demoRequestIdHeader,
	demoRequestOriginHeader,
	demoRequestTypeButtonClick,
	demoRequestTypeHeader,
	getNodePort,
	sendRequestButtonId,
} from "../helpers";

export function SendRequestButton({ cluster }: { cluster: w8s.Cluster }) {
	async function sendRequest(event: MouseEvent<HTMLButtonElement>) {
		const requestId = crypto.randomUUID();
		const nodePort = await getNodePort(cluster, "default", "api");
		await cluster.fetch(`http://node-1:${nodePort}/checkout`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				[demoRequestIdHeader]: requestId,
				[demoRequestOriginHeader]: `${event.clientX},${event.clientY}`,
				[demoRequestTypeHeader]: demoRequestTypeButtonClick,
			},
			body: JSON.stringify({ cartId: "demo-cart" }),
		});
	}

	return (
		<Button id={sendRequestButtonId} type="button" onClick={sendRequest}>
			<PaperPlaneTiltIcon aria-hidden weight="bold" />
			Send request
		</Button>
	);
}
