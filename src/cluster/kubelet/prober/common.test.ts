import {
	KubeConfig,
	type V1Container,
	type V1Pod,
	type V1PodStatus,
	type V1Probe,
} from "../../../client";
import { FakeRecorder } from "../../../client-go/tools/record/fake";
import { Clock } from "../../../clock";
import type { ExecProbe, ProbeResult } from "../../probe";
import { ClusterNetwork } from "../../cni";
import { Etcd } from "../../etcd";
import { KubeClient } from "../../cluster";
import { buildContainerID } from "../container";
import { PodManager } from "../pod";
import { StatusManager } from "../status";
import { ProbeManagerImpl } from "./prober-manager";
import { ResultsManager, type ProbeType } from "./results";
import { ProbeWorker } from "./worker";

// Models kubernetes/pkg/kubelet/prober/common_test.go testContainerName.
export const testContainerName = "cOnTaInEr_NaMe";
// Models kubernetes/pkg/kubelet/prober/common_test.go testPodUID.
export const testPodUID = "pOd_UiD";
// Models kubernetes/pkg/kubelet/prober/common_test.go testContainerID.
export const testContainerID = buildContainerID("test", "cOnTaInEr_Id");

// Models kubernetes/pkg/kubelet/prober/common_test.go getTestRunningStatus.
export function getTestRunningStatus(): V1PodStatus {
	return getTestRunningStatusWithStarted(true);
}

// Models kubernetes/pkg/kubelet/prober/common_test.go getTestNotRunningStatus.
export function getTestNotRunningStatus(): V1PodStatus {
	return getTestRunningStatusWithStarted(false);
}

// Models kubernetes/pkg/kubelet/prober/common_test.go getTestRunningStatusWithStarted.
export function getTestRunningStatusWithStarted(started: boolean): V1PodStatus {
	return {
		phase: "Running",
		containerStatuses: [
			{
				name: testContainerName,
				containerID: testContainerID.toString(),
				image: "",
				imageID: "",
				ready: false,
				restartCount: 0,
				state: {
					running: { startedAt: new Date() },
				},
				started,
			},
		],
	};
}

// Models kubernetes/pkg/kubelet/prober/common_test.go getTestRunningStatusWithFailedContainer.
export function getTestRunningStatusWithFailedContainer(): V1PodStatus {
	return {
		phase: "Running",
		containerStatuses: [
			{
				name: testContainerName,
				containerID: testContainerID.toString(),
				image: "",
				imageID: "",
				ready: false,
				restartCount: 0,
				state: {
					terminated: { exitCode: 1 },
				},
			},
		],
	};
}

// Models kubernetes/pkg/kubelet/prober/common_test.go getTestRunningStatusWithSucceededContainer.
export function getTestRunningStatusWithSucceededContainer(): V1PodStatus {
	return {
		phase: "Running",
		containerStatuses: [
			{
				name: testContainerName,
				containerID: testContainerID.toString(),
				image: "",
				imageID: "",
				ready: false,
				restartCount: 0,
				state: {
					terminated: { exitCode: 0 },
				},
			},
		],
	};
}

// Models kubernetes/pkg/kubelet/prober/common_test.go getTestPendingStatus.
export function getTestPendingStatus(): V1PodStatus {
	return {
		phase: "Pending",
		containerStatuses: [
			{
				name: testContainerName,
				containerID: testContainerID.toString(),
				image: "",
				imageID: "",
				ready: false,
				restartCount: 0,
				state: {
					waiting: {},
				},
			},
		],
	};
}

// Models kubernetes/pkg/kubelet/prober/common_test.go getTestPod.
export function getTestPod(): V1Pod {
	return {
		metadata: {
			name: "testPod",
			uid: testPodUID,
		},
		spec: {
			containers: [{ name: testContainerName }],
			restartPolicy: "Never",
		},
	};
}

// Models kubernetes/pkg/kubelet/prober/common_test.go setTestProbe.
export function setTestProbe(pod: V1Pod, probeType: ProbeType, probeSpec: V1Probe): void {
	probeSpec = {
		exec: {},
		timeoutSeconds: 1,
		periodSeconds: 1,
		successThreshold: 1,
		failureThreshold: 1,
		...probeSpec,
	};
	const container = pod.spec?.containers?.[0];
	if (!container) {
		throw new Error("test pod missing container");
	}
	switch (probeType) {
		case "readiness":
			container.readinessProbe = probeSpec;
			break;
		case "liveness":
			container.livenessProbe = probeSpec;
			break;
		case "startup":
			container.startupProbe = probeSpec;
			break;
	}
}

// Models kubernetes/pkg/kubelet/prober/common_test.go newTestManager.
export function newTestManager(): ProbeManagerImpl {
	const clock = new Clock();
	clock.pause();
	const kubeConfig = new KubeConfig({
		clock,
		etcd: new Etcd(clock),
		nodePortRange: { from: 30000, to: 32767 },
	});
	const podManager = new PodManager();
	podManager.addPod(getTestPod());
	const statusManager = new StatusManager({
		clock,
		kubeClient: new KubeClient(kubeConfig),
		podManager,
	});
	const manager = new ProbeManagerImpl(
		statusManager,
		new ResultsManager(),
		new ResultsManager(),
		new ResultsManager(),
		undefined,
		new FakeRecorder(),
		clock,
		new ClusterNetwork(),
	);
	manager.prober.exec = new FakeExecProber("success");
	return manager;
}

// Models kubernetes/pkg/kubelet/prober/common_test.go newTestWorker.
export function newTestWorker(
	m: ProbeManagerImpl,
	probeType: ProbeType,
	probeSpec: V1Probe,
): ProbeWorker {
	const pod = getTestPod();
	setTestProbe(pod, probeType, probeSpec);
	return new ProbeWorker(m, probeType, pod, pod.spec?.containers?.[0] as V1Container);
}

// Models kubernetes/pkg/kubelet/prober/common_test.go fakeExecProber.
export class FakeExecProber implements ExecProbe {
	constructor(
		private result: ProbeResult,
		private err?: Error,
	) {}

	set(result: ProbeResult, err?: Error): void {
		this.result = result;
		this.err = err;
	}

	async probe(): Promise<[ProbeResult, string, Error | undefined]> {
		return [this.result, "", this.err];
	}
}
