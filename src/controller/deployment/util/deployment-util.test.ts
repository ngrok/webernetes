/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
// oxlint-disable typescript/no-non-null-assertion
import { expect, it } from "vitest";

import type * as k8s from "../../../client";
import { browser } from "../../../test/describe";
import {
	defaultDeploymentUniqueLabelKey,
	deploymentComplete,
	equalIgnoreHash,
	findNewReplicaSet,
	findOldReplicaSets,
	getActualReplicaCountForReplicaSets,
	getReplicaCountForReplicaSets,
	getTerminatingReplicaCountForReplicaSets,
	maxUnavailable,
	newRSNewReplicas,
	resolveFenceposts,
} from "./deployment-util";

browser.describe("deployment util", () => {
	// Models kubernetes/pkg/controller/deployment/util/deployment_util_test.go TestEqualIgnoreHash.
	it("compares templates ignoring hash", () => {
		const tests: {
			Name: string;
			former: k8s.V1PodTemplateSpec;
			latter: k8s.V1PodTemplateSpec;
			expected: boolean;
		}[] = [
			{
				Name: "Same spec, same labels",
				former: generatePodTemplateSpec(
					"foo",
					"foo-node",
					{},
					{
						[defaultDeploymentUniqueLabelKey]: "value-1",
						something: "else",
					},
				),
				latter: generatePodTemplateSpec(
					"foo",
					"foo-node",
					{},
					{
						[defaultDeploymentUniqueLabelKey]: "value-1",
						something: "else",
					},
				),
				expected: true,
			},
			{
				Name: "Same spec, only pod-template-hash label value is different",
				former: generatePodTemplateSpec(
					"foo",
					"foo-node",
					{},
					{
						[defaultDeploymentUniqueLabelKey]: "value-1",
						something: "else",
					},
				),
				latter: generatePodTemplateSpec(
					"foo",
					"foo-node",
					{},
					{
						[defaultDeploymentUniqueLabelKey]: "value-2",
						something: "else",
					},
				),
				expected: true,
			},
			{
				Name: "Same spec, the former doesn't have pod-template-hash label",
				former: generatePodTemplateSpec("foo", "foo-node", {}, { something: "else" }),
				latter: generatePodTemplateSpec(
					"foo",
					"foo-node",
					{},
					{
						[defaultDeploymentUniqueLabelKey]: "value-2",
						something: "else",
					},
				),
				expected: true,
			},
			{
				Name: "Same spec, the label is different, the former doesn't have pod-template-hash label, same number of labels",
				former: generatePodTemplateSpec("foo", "foo-node", {}, { something: "else" }),
				latter: generatePodTemplateSpec(
					"foo",
					"foo-node",
					{},
					{
						[defaultDeploymentUniqueLabelKey]: "value-2",
					},
				),
				expected: false,
			},
			{
				Name: "Same spec, the label is different, the latter doesn't have pod-template-hash label, same number of labels",
				former: generatePodTemplateSpec(
					"foo",
					"foo-node",
					{},
					{
						[defaultDeploymentUniqueLabelKey]: "value-1",
					},
				),
				latter: generatePodTemplateSpec("foo", "foo-node", {}, { something: "else" }),
				expected: false,
			},
			{
				Name: "Same spec, the label is different, and the pod-template-hash label value is the same",
				former: generatePodTemplateSpec(
					"foo",
					"foo-node",
					{},
					{
						[defaultDeploymentUniqueLabelKey]: "value-1",
					},
				),
				latter: generatePodTemplateSpec(
					"foo",
					"foo-node",
					{},
					{
						[defaultDeploymentUniqueLabelKey]: "value-1",
						something: "else",
					},
				),
				expected: false,
			},
			{
				Name: "Different spec, same labels",
				former: generatePodTemplateSpec(
					"foo",
					"foo-node",
					{ former: "value" },
					{
						[defaultDeploymentUniqueLabelKey]: "value-1",
						something: "else",
					},
				),
				latter: generatePodTemplateSpec(
					"foo",
					"foo-node",
					{ latter: "value" },
					{
						[defaultDeploymentUniqueLabelKey]: "value-1",
						something: "else",
					},
				),
				expected: false,
			},
			{
				Name: "Different spec, different pod-template-hash label value",
				former: generatePodTemplateSpec(
					"foo-1",
					"foo-node",
					{},
					{
						[defaultDeploymentUniqueLabelKey]: "value-1",
						something: "else",
					},
				),
				latter: generatePodTemplateSpec(
					"foo-2",
					"foo-node",
					{},
					{
						[defaultDeploymentUniqueLabelKey]: "value-2",
						something: "else",
					},
				),
				expected: false,
			},
			{
				Name: "Different spec, the former doesn't have pod-template-hash label",
				former: generatePodTemplateSpec("foo-1", "foo-node-1", {}, { something: "else" }),
				latter: generatePodTemplateSpec(
					"foo-2",
					"foo-node-2",
					{},
					{
						[defaultDeploymentUniqueLabelKey]: "value-2",
						something: "else",
					},
				),
				expected: false,
			},
			{
				Name: "Different spec, different labels",
				former: generatePodTemplateSpec("foo", "foo-node-1", {}, { something: "else" }),
				latter: generatePodTemplateSpec("foo", "foo-node-2", {}, { nothing: "else" }),
				expected: false,
			},
		];

		for (const test of tests) {
			for (const reversed of [false, true]) {
				const first = reversed ? test.latter : test.former;
				const second = reversed ? test.former : test.latter;
				expect({ Name: test.Name, reversed, equal: equalIgnoreHash(first, second) }).toEqual({
					Name: test.Name,
					reversed,
					equal: test.expected,
				});
				expect(first.metadata?.labels).not.toBeUndefined();
				expect(second.metadata?.labels).not.toBeUndefined();
			}
		}
	});

	// Models kubernetes/pkg/controller/deployment/util/deployment_util_test.go TestFindNewReplicaSet.
	it("finds new replica sets", () => {
		const now = new Date();
		const later = new Date(now.getTime() + 60_000);

		const deployment = generateDeployment("nginx");
		const newRS = generateRS(deployment);
		newRS.metadata!.labels![defaultDeploymentUniqueLabelKey] = "hash";
		newRS.metadata!.creationTimestamp = later;

		const newRSDup = generateRS(deployment);
		newRSDup.metadata!.labels![defaultDeploymentUniqueLabelKey] = "different-hash";
		newRSDup.metadata!.creationTimestamp = now;

		const oldDeployment = generateDeployment("nginx");
		oldDeployment.spec!.template!.spec!.containers![0]!.name = "nginx-old-1";
		const oldRS = generateRS(oldDeployment);
		oldRS.status!.fullyLabeledReplicas = oldRS.spec!.replicas;

		const tests: {
			Name: string;
			deployment: k8s.V1Deployment;
			rsList: k8s.V1ReplicaSet[];
			expected?: k8s.V1ReplicaSet;
		}[] = [
			{
				Name: "Get new ReplicaSet with the same template as Deployment spec but different pod-template-hash value",
				deployment,
				rsList: [newRS, oldRS],
				expected: newRS,
			},
			{
				Name: "Get the oldest new ReplicaSet when there are more than one ReplicaSet with the same template",
				deployment,
				rsList: [newRS, oldRS, newRSDup],
				expected: newRSDup,
			},
			{
				Name: "Get nil new ReplicaSet",
				deployment,
				rsList: [oldRS],
				expected: undefined,
			},
		];

		for (const test of tests) {
			expect({ Name: test.Name, rs: findNewReplicaSet(test.deployment, test.rsList) }).toEqual({
				Name: test.Name,
				rs: test.expected,
			});
		}
	});

	// Models kubernetes/pkg/controller/deployment/util/deployment_util_test.go TestFindOldReplicaSets.
	it("finds old replica sets", () => {
		const now = new Date();
		const later = new Date(now.getTime() + 60_000);
		const before = new Date(now.getTime() - 60_000);

		const deployment = generateDeployment("nginx");
		const newRS = generateRS(deployment);
		newRS.spec!.replicas = 1;
		newRS.metadata!.labels![defaultDeploymentUniqueLabelKey] = "hash";
		newRS.metadata!.creationTimestamp = later;

		const newRSDup = generateRS(deployment);
		newRSDup.metadata!.labels![defaultDeploymentUniqueLabelKey] = "different-hash";
		newRSDup.metadata!.creationTimestamp = now;

		const oldDeployment = generateDeployment("nginx");
		oldDeployment.spec!.template!.spec!.containers![0]!.name = "nginx-old-1";
		const oldRS = generateRS(oldDeployment);
		oldRS.status!.fullyLabeledReplicas = oldRS.spec!.replicas;
		oldRS.metadata!.creationTimestamp = before;

		const tests: {
			Name: string;
			deployment: k8s.V1Deployment;
			rsList: k8s.V1ReplicaSet[];
			expected: k8s.V1ReplicaSet[];
			expectedRequire: k8s.V1ReplicaSet[];
		}[] = [
			{
				Name: "Get old ReplicaSets",
				deployment,
				rsList: [newRS, oldRS],
				expected: [oldRS],
				expectedRequire: [],
			},
			{
				Name: "Get old ReplicaSets with no new ReplicaSet",
				deployment,
				rsList: [oldRS],
				expected: [oldRS],
				expectedRequire: [],
			},
			{
				Name: "Get old ReplicaSets with two new ReplicaSets, only the oldest new ReplicaSet is seen as new ReplicaSet",
				deployment,
				rsList: [oldRS, newRS, newRSDup],
				expected: [oldRS, newRS],
				expectedRequire: [newRS],
			},
			{
				Name: "Get empty old ReplicaSets",
				deployment,
				rsList: [newRS],
				expected: [],
				expectedRequire: [],
			},
		];

		for (const test of tests) {
			const [requireRS, allRS] = findOldReplicaSets(test.deployment, test.rsList);
			allRS.sort(compareReplicaSetsByCreationTimestamp);
			test.expected.sort(compareReplicaSetsByCreationTimestamp);
			expect({ Name: test.Name, allRS }).toEqual({ Name: test.Name, allRS: test.expected });
			expect({ Name: test.Name, requireRS }).toEqual({
				Name: test.Name,
				requireRS: test.expectedRequire,
			});
		}
	});

	// Models kubernetes/pkg/controller/deployment/util/deployment_util_test.go TestGetReplicaCountForReplicaSets.
	it("gets replica count for replica sets", () => {
		const rs1 = generateRS(generateDeployment("foo-rs"));
		rs1.status!.observedGeneration = 1;
		rs1.spec!.replicas = 1;
		rs1.status!.replicas = 2;
		rs1.status!.terminatingReplicas = 3;

		const rs2 = generateRS(generateDeployment("bar-rs"));
		rs1.status!.observedGeneration = 1;
		rs2.spec!.replicas = 2;
		rs2.status!.replicas = 3;
		rs2.status!.terminatingReplicas = 1;

		const rs3 = generateRS(generateDeployment("unsynced-rs"));
		rs3.spec!.replicas = 3;
		rs3.status!.replicas = 0;
		rs3.status!.terminatingReplicas = undefined;

		const rs4 = generateRS(generateDeployment("dropped-rs"));
		rs4.status!.observedGeneration = 1;
		rs4.spec!.replicas = 1;
		rs4.status!.replicas = 1;
		rs4.status!.terminatingReplicas = undefined;

		const tests: {
			name: string;
			sets: k8s.V1ReplicaSet[];
			expectedCount: number;
			expectedActual: number;
			expectedTerminating: number | undefined;
		}[] = [
			{
				name: "scaling down rs1",
				sets: [rs1],
				expectedCount: 1,
				expectedActual: 2,
				expectedTerminating: 3,
			},
			{
				name: "scaling down rs1 and rs2",
				sets: [rs1, rs2],
				expectedCount: 3,
				expectedActual: 5,
				expectedTerminating: 4,
			},
			{
				name: "scaling up rs3",
				sets: [rs3],
				expectedCount: 3,
				expectedActual: 0,
				expectedTerminating: 0,
			},
			{
				name: "scaling down rs1 and rs2 and scaling up rs3",
				sets: [rs1, rs2, rs3],
				expectedCount: 6,
				expectedActual: 5,
				expectedTerminating: 4,
			},
			{
				name: "invalid/unknown terminating status for rs4",
				sets: [rs4],
				expectedCount: 1,
				expectedActual: 1,
				expectedTerminating: undefined,
			},
			{
				name: "invalid/unknown terminating status for rs4 with rs1, rs2 and rs3",
				sets: [rs1, rs2, rs3, rs4],
				expectedCount: 7,
				expectedActual: 6,
				expectedTerminating: undefined,
			},
		];

		for (const test of tests) {
			expect(getReplicaCountForReplicaSets(test.sets)).toBe(test.expectedCount);
			expect(getActualReplicaCountForReplicaSets(test.sets)).toBe(test.expectedActual);
			expect(getTerminatingReplicaCountForReplicaSets(test.sets)).toBe(test.expectedTerminating);
		}
	});

	// Models kubernetes/pkg/controller/deployment/util/deployment_util_test.go TestResolveFenceposts.
	it("resolves fenceposts", () => {
		const tests: {
			maxSurge?: string;
			maxUnavailable?: string;
			desired: number;
			expectSurge: number;
			expectUnavailable: number;
			expectError: boolean;
		}[] = [
			{
				maxSurge: "0%",
				maxUnavailable: "0%",
				desired: 0,
				expectSurge: 0,
				expectUnavailable: 1,
				expectError: false,
			},
			{
				maxSurge: "39%",
				maxUnavailable: "39%",
				desired: 10,
				expectSurge: 4,
				expectUnavailable: 3,
				expectError: false,
			},
			{
				maxSurge: "oops",
				maxUnavailable: "39%",
				desired: 10,
				expectSurge: 0,
				expectUnavailable: 0,
				expectError: true,
			},
			{
				maxSurge: "55%",
				maxUnavailable: "urg",
				desired: 10,
				expectSurge: 0,
				expectUnavailable: 0,
				expectError: true,
			},
			{
				maxUnavailable: "39%",
				desired: 10,
				expectSurge: 0,
				expectUnavailable: 3,
				expectError: false,
			},
			{
				maxSurge: "39%",
				desired: 10,
				expectSurge: 4,
				expectUnavailable: 0,
				expectError: false,
			},
			{
				desired: 10,
				expectSurge: 0,
				expectUnavailable: 1,
				expectError: false,
			},
		];

		for (const [num, test] of tests.entries()) {
			const [surge, unavail, err] = resolveFenceposts(
				test.maxSurge,
				test.maxUnavailable,
				test.desired,
			);
			expect({ num, gotError: err !== undefined }).toEqual({
				num,
				gotError: test.expectError,
			});
			expect({ num, surge, unavail }).toEqual({
				num,
				surge: test.expectSurge,
				unavail: test.expectUnavailable,
			});
		}
	});

	// Models kubernetes/pkg/controller/deployment/util/deployment_util_test.go TestNewRSNewReplicas.
	it("calculates new replica set replicas", () => {
		const tests: {
			Name: string;
			strategyType: string;
			depReplicas: number;
			newRSReplicas: number;
			maxSurge: number;
			expected: number;
		}[] = [
			{
				Name: "can not scale up - to newRSReplicas",
				strategyType: "RollingUpdate",
				depReplicas: 1,
				newRSReplicas: 5,
				maxSurge: 1,
				expected: 5,
			},
			{
				Name: "scale up - to depReplicas",
				strategyType: "RollingUpdate",
				depReplicas: 6,
				newRSReplicas: 2,
				maxSurge: 10,
				expected: 6,
			},
			{
				Name: "recreate - to depReplicas",
				strategyType: "Recreate",
				depReplicas: 3,
				newRSReplicas: 1,
				maxSurge: 1,
				expected: 3,
			},
		];
		const deployment = generateDeployment("nginx");
		const newRC = generateRS(deployment);
		const rs5 = generateRS(deployment);
		rs5.spec!.replicas = 5;

		for (const test of tests) {
			deployment.spec!.replicas = test.depReplicas;
			deployment.spec!.strategy = {
				type: test.strategyType,
				rollingUpdate: {
					maxUnavailable: 1,
					maxSurge: test.maxSurge,
				},
			};
			newRC.spec!.replicas = test.newRSReplicas;
			expect({ Name: test.Name, replicas: newRSNewReplicas(deployment, [rs5], newRC) }).toEqual({
				Name: test.Name,
				replicas: test.expected,
			});
		}
	});

	// Models kubernetes/pkg/controller/deployment/util/deployment_util_test.go TestDeploymentComplete.
	it("detects deployment complete", () => {
		const deployment = (
			desired: number,
			current: number,
			updated: number,
			available: number,
			maxUnavailableValue: number,
			maxSurgeValue: number,
		): k8s.V1Deployment => ({
			spec: {
				replicas: desired,
				strategy: {
					rollingUpdate: {
						maxUnavailable: maxUnavailableValue,
						maxSurge: maxSurgeValue,
					},
					type: "RollingUpdate",
				},
				selector: { matchLabels: {} },
				template: {},
			},
			status: {
				replicas: current,
				updatedReplicas: updated,
				availableReplicas: available,
			},
		});

		const tests: {
			name: string;
			d: k8s.V1Deployment;
			expected: boolean;
		}[] = [
			{
				name: "not complete: min but not all pods become available",
				d: deployment(5, 5, 5, 4, 1, 0),
				expected: false,
			},
			{
				name: "not complete: min availability is not honored",
				d: deployment(5, 5, 5, 3, 1, 0),
				expected: false,
			},
			{
				name: "complete",
				d: deployment(5, 5, 5, 5, 0, 0),
				expected: true,
			},
			{
				name: "not complete: all pods are available but not updated",
				d: deployment(5, 5, 4, 5, 0, 0),
				expected: false,
			},
			{
				name: "not complete: still running old pods",
				d: deployment(1, 2, 1, 1, 0, 1),
				expected: false,
			},
			{
				name: "not complete: one replica deployment never comes up",
				d: deployment(1, 1, 1, 0, 1, 1),
				expected: false,
			},
		];

		for (const test of tests) {
			expect({
				name: test.name,
				complete: deploymentComplete(test.d, test.d.status ?? {}),
			}).toEqual({
				name: test.name,
				complete: test.expected,
			});
		}
	});

	// Models kubernetes/pkg/controller/deployment/util/deployment_util_test.go TestMaxUnavailable.
	it("calculates max unavailable", () => {
		const deployment = (
			replicas: number,
			maxUnavailableValue: k8s.IntOrString,
		): k8s.V1Deployment => ({
			spec: {
				replicas,
				strategy: {
					rollingUpdate: {
						maxSurge: 1,
						maxUnavailable: maxUnavailableValue,
					},
					type: "RollingUpdate",
				},
				selector: { matchLabels: {} },
				template: {},
			},
		});
		const tests: {
			name: string;
			deployment: k8s.V1Deployment;
			expected: number;
		}[] = [
			{
				name: "maxUnavailable less than replicas",
				deployment: deployment(10, 5),
				expected: 5,
			},
			{
				name: "maxUnavailable equal replicas",
				deployment: deployment(10, 10),
				expected: 10,
			},
			{
				name: "maxUnavailable greater than replicas",
				deployment: deployment(5, 10),
				expected: 5,
			},
			{
				name: "maxUnavailable with replicas is 0",
				deployment: deployment(0, 10),
				expected: 0,
			},
			{
				name: "maxUnavailable with Recreate deployment strategy",
				deployment: {
					spec: {
						strategy: {
							type: "Recreate",
						},
						selector: { matchLabels: {} },
						template: {},
					},
				},
				expected: 0,
			},
			{
				name: "maxUnavailable less than replicas with percents",
				deployment: deployment(10, "50%"),
				expected: 5,
			},
			{
				name: "maxUnavailable equal replicas with percents",
				deployment: deployment(10, "100%"),
				expected: 10,
			},
			{
				name: "maxUnavailable greater than replicas with percents",
				deployment: deployment(5, "100%"),
				expected: 5,
			},
		];

		for (const test of tests) {
			expect({ name: test.name, maxUnavailable: maxUnavailable(test.deployment) }).toEqual({
				name: test.name,
				maxUnavailable: test.expected,
			});
		}
	});
});

function generateRS(deployment: k8s.V1Deployment): k8s.V1ReplicaSet {
	const template = structuredClone(deployment.spec?.template ?? {});
	return {
		metadata: {
			uid: randomUID(),
			name: `${deployment.metadata?.name}-`,
			labels: template.metadata?.labels,
			ownerReferences: [newDControllerRef(deployment)],
		},
		spec: {
			replicas: 0,
			template,
			selector: { matchLabels: template.metadata?.labels },
		},
		status: {
			replicas: 0,
		},
	};
}

function randomUID(): string {
	return String(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
}

function generateDeployment(image: string): k8s.V1Deployment {
	const podLabels = { name: image };
	return {
		metadata: {
			name: image,
			annotations: {},
		},
		spec: {
			replicas: 1,
			selector: { matchLabels: podLabels },
			template: {
				metadata: {
					labels: podLabels,
				},
				spec: {
					containers: [
						{
							name: image,
							image,
							imagePullPolicy: "Always",
							terminationMessagePath: "/dev/termination-log",
						},
					],
					dnsPolicy: "ClusterFirst",
					terminationGracePeriodSeconds: 30,
					restartPolicy: "Always",
					securityContext: {},
					enableServiceLinks: true,
				},
			},
		},
	};
}

function generatePodTemplateSpec(
	name: string,
	nodeName: string,
	annotations: Record<string, string>,
	labels: Record<string, string>,
): k8s.V1PodTemplateSpec {
	return {
		metadata: {
			name,
			annotations,
			labels,
		},
		spec: {
			nodeName,
			containers: [],
		},
	};
}

function newDControllerRef(deployment: k8s.V1Deployment): k8s.V1OwnerReference {
	return {
		apiVersion: "apps/v1",
		kind: "Deployment",
		name: deployment.metadata?.name ?? "",
		uid: deployment.metadata?.uid ?? "",
		controller: true,
	};
}

function compareReplicaSetsByCreationTimestamp(
	left: k8s.V1ReplicaSet,
	right: k8s.V1ReplicaSet,
): number {
	const leftTime = left.metadata?.creationTimestamp?.getTime() ?? 0;
	const rightTime = right.metadata?.creationTimestamp?.getTime() ?? 0;
	if (leftTime !== rightTime) {
		return leftTime - rightTime;
	}
	return (left.metadata?.name ?? "").localeCompare(right.metadata?.name ?? "");
}
