import type { Clock } from "../../clock";
import { newAggregate } from "../../apimachinery/pkg/util/errors/errors";
import { RuntimeFeatures, RuntimeHandler } from "./container";
import { errNetworkUnknown } from "./errors";

// Models kubernetes/pkg/kubelet/runtime.go healthCheckFnType.
export type HealthCheckFnType = () => [ok: boolean, err: Error | undefined];

// Models kubernetes/pkg/kubelet/runtime.go healthCheck.
interface HealthCheck {
	name: string;
	fn: HealthCheckFnType;
}

// Models kubernetes/pkg/kubelet/runtime.go runtimeState.
export class RuntimeState {
	private lastBaseRuntimeSync: Date | undefined;
	private networkError: Error | undefined;
	private runtimeError: Error | undefined;
	private storageError: Error | undefined;
	private cidr = "";
	private healthChecks: HealthCheck[] = [];
	private rtHandlers: RuntimeHandler[] = [];
	private rtFeatures: RuntimeFeatures | undefined;

	constructor(
		private readonly baseRuntimeSyncThresholdMs: number,
		private readonly clock: Clock,
	) {}

	// Models kubernetes/pkg/kubelet/runtime.go runtimeState.addHealthCheck.
	addHealthCheck(name: string, f: HealthCheckFnType): void {
		this.healthChecks.push({ name, fn: f });
	}

	// Models kubernetes/pkg/kubelet/runtime.go runtimeState.setRuntimeSync.
	setRuntimeSync(t: Date): void {
		this.lastBaseRuntimeSync = t;
	}

	// Models kubernetes/pkg/kubelet/runtime.go runtimeState.setNetworkState.
	setNetworkState(err: Error | undefined): void {
		this.networkError = err;
	}

	// Models kubernetes/pkg/kubelet/runtime.go runtimeState.setRuntimeState.
	setRuntimeState(err: Error | undefined): void {
		this.runtimeError = err;
	}

	// Models kubernetes/pkg/kubelet/runtime.go runtimeState.setRuntimeHandlers.
	setRuntimeHandlers(rtHandlers: RuntimeHandler[]): void {
		this.rtHandlers = rtHandlers
			.map((rtHandler) => rtHandler.clone())
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	// Models kubernetes/pkg/kubelet/runtime.go runtimeState.runtimeHandlers.
	runtimeHandlers(): RuntimeHandler[] {
		return this.rtHandlers;
	}

	// Models kubernetes/pkg/kubelet/runtime.go runtimeState.setRuntimeFeatures.
	setRuntimeFeatures(features: RuntimeFeatures | undefined): void {
		this.rtFeatures = features;
	}

	// Models kubernetes/pkg/kubelet/runtime.go runtimeState.runtimeFeatures.
	runtimeFeatures(): RuntimeFeatures | undefined {
		return this.rtFeatures;
	}

	// Models kubernetes/pkg/kubelet/runtime.go runtimeState.setStorageState.
	setStorageState(err: Error | undefined): void {
		this.storageError = err;
	}

	// Models kubernetes/pkg/kubelet/runtime.go runtimeState.setPodCIDR.
	setPodCIDR(cidr: string): void {
		this.cidr = cidr;
	}

	// Models kubernetes/pkg/kubelet/runtime.go runtimeState.podCIDR.
	podCIDR(): string {
		return this.cidr;
	}

	// Models kubernetes/pkg/kubelet/runtime.go runtimeState.runtimeErrors.
	runtimeErrors(): Error | undefined {
		const errs: Error[] = [];
		if (this.lastBaseRuntimeSync === undefined) {
			errs.push(new Error("container runtime status check may not have completed yet"));
		} else if (
			this.lastBaseRuntimeSync.getTime() + this.baseRuntimeSyncThresholdMs <=
			this.clock.now().getTime()
		) {
			errs.push(new Error("container runtime is down"));
		}
		for (const hc of this.healthChecks) {
			const [ok, err] = hc.fn();
			if (!ok) {
				errs.push(new Error(`${hc.name} is not healthy: ${err?.message ?? String(err)}`));
			}
		}
		if (this.runtimeError) {
			errs.push(this.runtimeError);
		}

		return newAggregate(errs);
	}

	// Models kubernetes/pkg/kubelet/runtime.go runtimeState.networkErrors.
	networkErrors(): Error | undefined {
		const errs: Error[] = [];
		if (this.networkError) {
			errs.push(this.networkError);
		}
		return newAggregate(errs);
	}

	// Models kubernetes/pkg/kubelet/runtime.go runtimeState.storageErrors.
	storageErrors(): Error | undefined {
		const errs: Error[] = [];
		if (this.storageError) {
			errs.push(this.storageError);
		}
		return newAggregate(errs);
	}
}

// Models kubernetes/pkg/kubelet/runtime.go newRuntimeState.
export function newRuntimeState(runtimeSyncThresholdMs: number, clock: Clock): RuntimeState {
	const state = new RuntimeState(runtimeSyncThresholdMs, clock);
	state.setNetworkState(errNetworkUnknown);
	return state;
}
