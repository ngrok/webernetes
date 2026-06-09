/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";
import type { V1Container, V1Pod, V1ResourceRequirements } from "../../../../../../client";
import { browser } from "../../../../../../test/describe";
import { computePodQOS } from "./qos";

type ResourceList = NonNullable<V1ResourceRequirements["requests"]>;

// Models kubernetes/pkg/apis/core/v1/helper/qos/qos_test.go TestComputePodQOS.
browser.describe("computePodQOS", () => {
	const testCases: Array<{
		pod: V1Pod;
		expected: string;
		podLevelResourcesEnabled?: boolean;
	}> = [
		{
			pod: newPod("guaranteed", [
				newContainer(
					"guaranteed",
					getResourceList("100m", "100Mi"),
					getResourceList("100m", "100Mi"),
				),
			]),
			expected: "Guaranteed",
		},
		{
			pod: newPod("guaranteed-guaranteed", [
				newContainer(
					"guaranteed",
					getResourceList("100m", "100Mi"),
					getResourceList("100m", "100Mi"),
				),
				newContainer(
					"guaranteed",
					getResourceList("100m", "100Mi"),
					getResourceList("100m", "100Mi"),
				),
			]),
			expected: "Guaranteed",
		},
		{
			pod: newPod("best-effort-best-effort", [
				newContainer("best-effort", getResourceList("", ""), getResourceList("", "")),
				newContainer("best-effort", getResourceList("", ""), getResourceList("", "")),
			]),
			expected: "BestEffort",
		},
		{
			pod: newPod("best-effort", [
				newContainer("best-effort", getResourceList("", ""), getResourceList("", "")),
			]),
			expected: "BestEffort",
		},
		{
			pod: newPod("best-effort-burstable", [
				newContainer("best-effort", getResourceList("", ""), getResourceList("", "")),
				newContainer("burstable", getResourceList("1", ""), getResourceList("2", "")),
			]),
			expected: "Burstable",
		},
		{
			pod: newPod("best-effort-guaranteed", [
				newContainer("best-effort", getResourceList("", ""), getResourceList("", "")),
				newContainer(
					"guaranteed",
					getResourceList("10m", "100Mi"),
					getResourceList("10m", "100Mi"),
				),
			]),
			expected: "Burstable",
		},
		{
			pod: newPod("burstable-cpu-guaranteed-memory", [
				newContainer("burstable", getResourceList("", "100Mi"), getResourceList("", "100Mi")),
			]),
			expected: "Burstable",
		},
		{
			pod: newPod("burstable-no-limits", [
				newContainer("burstable", getResourceList("100m", "100Mi"), getResourceList("", "")),
			]),
			expected: "Burstable",
		},
		{
			pod: newPod("burstable-guaranteed", [
				newContainer("burstable", getResourceList("1", "100Mi"), getResourceList("2", "100Mi")),
				newContainer(
					"guaranteed",
					getResourceList("100m", "100Mi"),
					getResourceList("100m", "100Mi"),
				),
			]),
			expected: "Burstable",
		},
		{
			pod: newPod("burstable-unbounded-but-requests-match-limits", [
				newContainer(
					"burstable",
					getResourceList("100m", "100Mi"),
					getResourceList("200m", "200Mi"),
				),
				newContainer(
					"burstable-unbounded",
					getResourceList("100m", "100Mi"),
					getResourceList("", ""),
				),
			]),
			expected: "Burstable",
		},
		{
			pod: newPod("burstable-1", [
				newContainer(
					"burstable",
					getResourceList("10m", "100Mi"),
					getResourceList("100m", "200Mi"),
				),
			]),
			expected: "Burstable",
		},
		{
			pod: newPod("burstable-2", [
				newContainer("burstable", getResourceList("0", "0"), getResourceList("100m", "200Mi")),
			]),
			expected: "Burstable",
		},
		{
			pod: newPod("best-effort-hugepages", [
				newContainer(
					"best-effort",
					addResource("hugepages-2Mi", "1Gi", getResourceList("0", "0")),
					addResource("hugepages-2Mi", "1Gi", getResourceList("0", "0")),
				),
			]),
			expected: "BestEffort",
		},
		{
			pod: newPodWithInitContainers(
				"init-container",
				[newContainer("best-effort", getResourceList("", ""), getResourceList("", ""))],
				[
					newContainer(
						"burstable",
						getResourceList("10m", "100Mi"),
						getResourceList("100m", "200Mi"),
					),
				],
			),
			expected: "Burstable",
		},
		{
			pod: newPodWithResources(
				"guaranteed-with-pod-level-resources",
				[newContainer("best-effort", getResourceList("", ""), getResourceList("", ""))],
				getResourceRequirements(getResourceList("10m", "100Mi"), getResourceList("10m", "100Mi")),
			),
			expected: "Guaranteed",
			podLevelResourcesEnabled: true,
		},
		{
			pod: newPodWithResources(
				"guaranteed-with-pod-and-container-level-resources",
				[newContainer("burstable", getResourceList("3m", "10Mi"), getResourceList("5m", "20Mi"))],
				getResourceRequirements(getResourceList("10m", "100Mi"), getResourceList("10m", "100Mi")),
			),
			expected: "Guaranteed",
			podLevelResourcesEnabled: true,
		},
		{
			pod: newPodWithResources(
				"burstable-with-pod-level-resources",
				[newContainer("best-effort", getResourceList("", ""), getResourceList("", ""))],
				getResourceRequirements(getResourceList("10m", "10Mi"), getResourceList("20m", "50Mi")),
			),
			expected: "Burstable",
			podLevelResourcesEnabled: true,
		},
		{
			pod: newPodWithResources(
				"burstable-with-pod-and-container-level-resources",
				[newContainer("burstable", getResourceList("5m", "10Mi"), getResourceList("5m", "10Mi"))],
				getResourceRequirements(getResourceList("10m", "10Mi"), getResourceList("20m", "50Mi")),
			),
			expected: "Burstable",
			podLevelResourcesEnabled: true,
		},
		{
			pod: newPodWithResources(
				"burstable-with-pod-and-container-level-requests",
				[newContainer("burstable", getResourceList("5m", "10Mi"), getResourceList("", ""))],
				getResourceRequirements(getResourceList("10m", "10Mi"), getResourceList("", "")),
			),
			expected: "Burstable",
			podLevelResourcesEnabled: true,
		},
		{
			pod: newPodWithResources(
				"burstable-with-pod-and-container-level-resources-2",
				[
					newContainer("burstable", getResourceList("5m", "10Mi"), getResourceList("", "")),
					newContainer("guaranteed", getResourceList("5m", "10Mi"), getResourceList("5m", "10Mi")),
				],
				getResourceRequirements(getResourceList("10m", "10Mi"), getResourceList("5m", "")),
			),
			expected: "Burstable",
			podLevelResourcesEnabled: true,
		},
	];

	it.each(testCases)("$pod.metadata.name", (testCase) => {
		expect(computePodQOS(testCase.pod)).toBe(testCase.expected);
	});
});

// Models kubernetes/pkg/apis/core/v1/helper/qos/qos_test.go getResourceList.
function getResourceList(cpu: string, memory: string): ResourceList {
	const res: ResourceList = {};
	if (cpu !== "") {
		res.cpu = cpu;
	}
	if (memory !== "") {
		res.memory = memory;
	}
	return res;
}

// Models kubernetes/pkg/apis/core/v1/helper/qos/qos_test.go addResource.
function addResource(rName: string, value: string, rl: ResourceList): ResourceList {
	rl[rName] = value;
	return rl;
}

// Models kubernetes/pkg/apis/core/v1/helper/qos/qos_test.go getResourceRequirements.
function getResourceRequirements(
	requests: ResourceList,
	limits: ResourceList,
): V1ResourceRequirements {
	return {
		requests,
		limits,
	};
}

// Models kubernetes/pkg/apis/core/v1/helper/qos/qos_test.go newContainer.
function newContainer(name: string, requests: ResourceList, limits: ResourceList): V1Container {
	return {
		name,
		resources: getResourceRequirements(requests, limits),
	};
}

// Models kubernetes/pkg/apis/core/v1/helper/qos/qos_test.go newPod.
function newPod(name: string, containers: V1Container[]): V1Pod {
	return {
		metadata: {
			name,
		},
		spec: {
			containers,
		},
	};
}

// Models kubernetes/pkg/apis/core/v1/helper/qos/qos_test.go newPodWithResources.
function newPodWithResources(
	name: string,
	containers: V1Container[],
	podResources: V1ResourceRequirements | undefined,
): V1Pod {
	const pod = newPod(name, containers);
	if (podResources !== undefined) {
		pod.spec = {
			...pod.spec,
			containers: pod.spec?.containers ?? [],
			resources: podResources,
		};
	}
	return pod;
}

// Models kubernetes/pkg/apis/core/v1/helper/qos/qos_test.go newPodWithInitContainers.
function newPodWithInitContainers(
	name: string,
	containers: V1Container[],
	initContainers: V1Container[],
): V1Pod {
	return {
		metadata: {
			name,
		},
		spec: {
			containers,
			initContainers,
		},
	};
}
