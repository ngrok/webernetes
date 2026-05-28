import type { V1Pod } from "../../../client";
import { Clock } from "../../../clock";
import type { SendChannel } from "../../../go/channel";
import * as context from "../../../go/context";
import type { ListerWatcher } from "../../../client-go/tools/cache/listwatch";
import { newReflectorWithOptions } from "../../../client-go/tools/cache/reflector";
import { metaNamespaceKeyFunc } from "../../../client-go/tools/cache/store";
import { newUndeltaStore } from "../../../client-go/tools/cache/undelta_store";
import type { SourceUpdate } from "./config";

// Models kubernetes/pkg/kubelet/config/apiserver.go WaitForAPIServerSyncPeriod.
export const waitForAPIServerSyncPeriodMs = 1000;

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
