import * as context from "../../../../go/context";
import type { Cache, PodStatusResult, Runtime } from "../index";

// Models kubernetes/pkg/kubelet/container/testing/fake_cache.go fakeCache.
class FakeCache implements Cache {
	constructor(private readonly runtime: Runtime) {}

	// Models kubernetes/pkg/kubelet/container/testing/fake_cache.go Get.
	async get(id: string): Promise<PodStatusResult> {
		const [pod, err] = await this.runtime.getPod(context.background(), id);
		const runtimePod =
			err || !pod
				? {
						id,
						name: "",
						namespace: "",
						createdAt: 0,
						timestamp: new Date(0),
						containers: [],
						sandboxes: [],
					}
				: pod;
		const [status, statusErr] = await this.runtime.getPodStatus(context.background(), runtimePod);
		return [status ?? this.getDefaultStatus(id), statusErr];
	}

	// Models kubernetes/pkg/kubelet/container/testing/fake_cache.go GetNewerThan.
	async getNewerThan(_ctx: context.Context, id: string, _minTime: Date): Promise<PodStatusResult> {
		return this.get(id);
	}

	// Models kubernetes/pkg/kubelet/container/testing/fake_cache.go Set.
	set(
		_id: string,
		_status: PodStatusResult[0] | undefined,
		_err: Error | undefined,
		_timestamp: Date,
	): boolean {
		return true;
	}

	// Models kubernetes/pkg/kubelet/container/testing/fake_cache.go Delete.
	delete(_id: string): void {}

	// Models kubernetes/pkg/kubelet/container/testing/fake_cache.go UpdateTime.
	updateTime(_timestamp: Date): void {}

	// Models kubernetes/pkg/kubelet/container/testing/fake_cache.go SetObservedTime.
	setObservedTime(_id: string, _timestamp: Date): void {}

	private getDefaultStatus(id: string): PodStatusResult[0] {
		return {
			id,
			name: "",
			namespace: "",
			ips: [],
			containerStatuses: [],
			sandboxStatuses: [],
			timestamp: new Date(0),
		};
	}
}

// Models kubernetes/pkg/kubelet/container/testing/fake_cache.go NewFakeCache.
export function newFakeCache(runtime: Runtime): Cache {
	return new FakeCache(runtime);
}
