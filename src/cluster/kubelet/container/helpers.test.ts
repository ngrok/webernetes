import { expect, it } from "vitest";
import { browser } from "../../../test/describe";
import type { V1Container, V1Pod, V1PodCondition, V1PodStatus } from "../../../client";
import {
	expandContainerCommandOnlyStatic,
	hashContainer,
	shouldAllContainersRestart,
} from "./helpers";
import { buildContainerID, type PodStatus, type Status } from "./runtime";

browser.describe("hashContainer", () => {
	it("matches the upstream Kubernetes container hash fixture", () => {
		/*
		package main

		import (
			"fmt"

			v1 "k8s.io/api/core/v1"
			kubecontainer "k8s.io/kubernetes/pkg/kubelet/container"
		)

		func main() {
			container := v1.Container{
				Name:  "test_container",
				Image: "foo/image:v1",
				Args: []string{
					"/bin/sh",
					"-c",
					"echo abc",
				},
				Ports: []v1.ContainerPort{{ContainerPort: 8001}},
			}

			fmt.Printf("0x%08x\n", kubecontainer.HashContainer(&container))
			// 0x8e45cbd0
		}
		*/
		expect(
			hashContainer({
				name: "test_container",
				image: "foo/image:v1",
				args: ["/bin/sh", "-c", "echo abc"],
				ports: [{ containerPort: 8001 }],
			}),
		).toBe(0x8e45cbd0);
	});

	it("hashes only the fields upstream picks for running status", () => {
		/*
		package main

		import (
			"fmt"

			v1 "k8s.io/api/core/v1"
			kubecontainer "k8s.io/kubernetes/pkg/kubelet/container"
		)

		func main() {
			base := v1.Container{
				Name:  "test_container",
				Image: "foo/image:v1",
			}
			withIgnoredFields := v1.Container{
				Name:    "test_container",
				Image:   "foo/image:v1",
				Command: []string{"ignored"},
				Args:    []string{"ignored"},
				Env: []v1.EnvVar{{
					Name:  "IGNORED",
					Value: "ignored",
				}},
				Ports: []v1.ContainerPort{{
					Name:          "ignored",
					ContainerPort: 8001,
					Protocol:      v1.ProtocolUDP,
					HostIP:        "127.0.0.1",
					HostPort:      8002,
				}},
			}

			fmt.Printf("0x%08x\n0x%08x\n",
				kubecontainer.HashContainer(&base),
				kubecontainer.HashContainer(&withIgnoredFields),
			)
			// 0x8e45cbd0
			// 0x8e45cbd0
		}
		*/
		const base = hashContainer({
			name: "test_container",
			image: "foo/image:v1",
		});

		expect(
			hashContainer({
				name: "test_container",
				image: "foo/image:v1",
				command: ["ignored"],
				args: ["ignored"],
				env: [{ name: "IGNORED", value: "ignored" }],
				ports: [
					{
						name: "ignored",
						containerPort: 8001,
						protocol: "UDP",
						hostIP: "127.0.0.1",
						hostPort: 8002,
					},
				],
			}),
		).toBe(base);
	});
});

// Simulator-only test, upstream doesn't test this function.
browser.describe("expandContainerCommandOnlyStatic", () => {
	it("expands only static container env values", () => {
		expect(
			expandContainerCommandOnlyStatic(
				["some $(A) $(B) $(MISSING) $$(ESCAPED)"],
				[
					{ name: "A", value: "script" },
					{ name: "B", valueFrom: { fieldRef: { fieldPath: "metadata.name" } } },
				],
			),
		).toEqual(["some script  $(MISSING) $(ESCAPED)"]);
	});
});

// Models kubernetes/pkg/kubelet/container/helpers_test.go TestShouldAllContainersRestart.
browser.describe("shouldAllContainersRestart", () => {
	const restartPolicyNever = "Never";
	const restartPolicyAlways = "Always";
	const restartRuleRestartAllContainers: NonNullable<V1Container["restartPolicyRules"]>[number] = {
		action: "RestartAllContainers",
		exitCodes: {
			operator: "In",
			values: [42],
		},
	};
	const restartAllContainersCondition: V1PodCondition = {
		type: "AllContainersRestarting",
		status: "True",
	};

	it.each([
		{
			name: "pod marked with condition",
			pod: {
				spec: {
					containers: [
						{
							name: "regular",
							restartPolicy: restartPolicyNever,
						},
					],
				},
			},
			podStatus: podStatus([
				containerStatus({
					name: "regular",
					state: "Running",
				}),
			]),
			apiPodStatus: {
				conditions: [restartAllContainersCondition],
			},
			expected: true,
		},
		{
			name: "regular container exited with matching rules",
			pod: {
				spec: {
					containers: [
						{
							name: "regular",
							restartPolicy: restartPolicyNever,
							restartPolicyRules: [restartRuleRestartAllContainers],
						},
					],
				},
			},
			podStatus: podStatus([
				containerStatus({
					name: "regular",
					state: "Exited",
					exitCode: 42,
				}),
			]),
			expected: true,
		},
		{
			name: "init container exited with matching rules",
			pod: {
				spec: {
					containers: [],
					initContainers: [
						{
							name: "init",
							restartPolicy: restartPolicyNever,
							restartPolicyRules: [restartRuleRestartAllContainers],
						},
					],
				},
			},
			podStatus: podStatus([
				containerStatus({
					name: "init",
					state: "Exited",
					exitCode: 42,
				}),
			]),
			expected: true,
		},
		{
			name: "sidecar container exited with matching rules",
			pod: {
				spec: {
					containers: [],
					initContainers: [
						{
							name: "init",
							restartPolicy: restartPolicyAlways,
							restartPolicyRules: [restartRuleRestartAllContainers],
						},
					],
				},
			},
			podStatus: podStatus([
				containerStatus({
					name: "init",
					state: "Exited",
					exitCode: 42,
				}),
			]),
			expected: true,
		},
		{
			name: "container exited without rules",
			pod: {
				spec: {
					containers: [
						{
							name: "regular",
						},
					],
				},
			},
			podStatus: podStatus([
				containerStatus({
					name: "regular",
					state: "Exited",
					exitCode: 1,
				}),
			]),
			expected: false,
		},
		{
			name: "api pod status regular container exited with matching rules",
			pod: {
				spec: {
					containers: [
						{
							name: "regular",
							restartPolicy: restartPolicyNever,
							restartPolicyRules: [restartRuleRestartAllContainers],
						},
					],
				},
			},
			podStatus: undefined,
			apiPodStatus: {
				containerStatuses: [
					{
						name: "regular",
						image: "",
						imageID: "",
						ready: false,
						restartCount: 0,
						state: { terminated: { exitCode: 42 } },
					},
				],
			},
			expected: true,
		},
	] satisfies Array<{
		name: string;
		pod: V1Pod;
		podStatus?: PodStatus;
		apiPodStatus?: V1PodStatus;
		expected: boolean;
	}>)("$name", (test) => {
		expect(shouldAllContainersRestart(test.pod, test.podStatus, test.apiPodStatus)).toBe(
			test.expected,
		);
	});
});

function podStatus(containerStatuses: Status[]): PodStatus {
	return {
		id: "",
		name: "",
		namespace: "",
		ips: [],
		containerStatuses,
		sandboxStatuses: [],
		timestamp: new Date(0),
	};
}

function containerStatus(status: Pick<Status, "name" | "state"> & Partial<Status>): Status {
	return {
		id: buildContainerID("simulator", status.name),
		createdAt: 0,
		image: "",
		imageID: "",
		imageRef: "",
		imageRuntimeHandler: "",
		hash: 0,
		restartCount: 0,
		...status,
	};
}
