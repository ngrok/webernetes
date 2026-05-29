import type { V1Pod } from "../../../client";
import { Clock } from "../../../clock";
import { select, type SendChannel } from "../../../go/channel";
import * as context from "../../../go/context";
import * as time from "../../../go/time";
import { oneTermEqualSelector } from "../../../apimachinery/pkg/fields/selector";
import {
	newListWatchFromClient,
	type ListerWatcher,
	type ListWatchClient,
} from "../../../client-go/tools/cache/listwatch";
import { newReflectorWithOptions } from "../../../client-go/tools/cache/reflector";
import { metaNamespaceKeyFunc } from "../../../client-go/tools/cache/store";
import { newUndeltaStore } from "../../../client-go/tools/cache/undelta_store";
import type { SourceUpdate } from "./config";

// Models kubernetes/pkg/kubelet/config/apiserver.go WaitForAPIServerSyncPeriod.
export const waitForAPIServerSyncPeriodMs = 1000;

// Models kubernetes/pkg/kubelet/config/apiserver.go NewSourceApiserver.
export function newSourceApiserver(
	ctx: context.Context,
	client: ListWatchClient<V1Pod>,
	nodeName: string,
	nodeHasSynced: () => boolean,
	updates: SendChannel<SourceUpdate>,
	clock = new Clock(),
): void {
	const lw = newListWatchFromClient(
		client,
		"pods",
		"",
		oneTermEqualSelector("spec.nodeName", nodeName),
	);

	void (async () => {
		for (;;) {
			if (ctx.err()) {
				return;
			}
			if (nodeHasSynced()) {
				break;
			}
			const selected = await select()
				.case(ctx.done(), () => "done" as const)
				.case(time.after(clock, waitForAPIServerSyncPeriodMs), () => "timer" as const);
			if (selected === "done") {
				return;
			}
		}
		newSourceApiserverFromLW(ctx, lw, updates, clock);
	})();
}

// Models kubernetes/pkg/kubelet/config/apiserver.go newSourceApiserverFromLW.
export function newSourceApiserverFromLW(
	ctx: context.Context,
	lw: ListerWatcher<V1Pod>,
	updates: SendChannel<SourceUpdate>,
	clock = new Clock(),
): void {
	const send = async (objs: V1Pod[]) => {
		const pods: V1Pod[] = [];
		for (const obj of objs) {
			pods.push(obj);
		}
		await updates.send({ pods });
	};
	const store = newUndeltaStore(send, metaNamespaceKeyFunc);
	const r = newReflectorWithOptions(lw, emptyPod(), store, {
		resyncPeriodMs: 0,
		clock,
	});
	void r.runWithContext(ctx);
}

function emptyPod(): V1Pod {
	return {
		apiVersion: "v1",
		kind: "Pod",
		metadata: {},
	};
}
