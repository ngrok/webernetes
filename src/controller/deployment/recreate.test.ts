/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import type * as k8s from "../../client";
import { newTestKubeClient, type TestKubeClient } from "../../client/test";
import * as context from "../../go/context";
import { browser } from "../../test/describe";
import { DeploymentController } from "./deployment-controller";
import { oldPodsRunning } from "./recreate";
import { newDeployment, newReplicaSet, noTimestamp, rs } from "./test-helpers";

browser.describe("DeploymentController recreate", ({ ctx }) => {
	// Models kubernetes/pkg/controller/deployment/recreate_test.go TestScaleDownOldReplicaSets.
	it("scales down old replica sets", async () => {
		const tests: { oldRSSizes: number[]; d: k8s.V1Deployment }[] = [
			{
				oldRSSizes: [3],
				d: newDeployment("foo", 3, undefined, undefined, undefined, { foo: "bar" }),
			},
		];

		for (const [i, test] of tests.entries()) {
			const oldRSs: k8s.V1ReplicaSet[] = [];
			const expected: k8s.V1ReplicaSet[] = [];

			for (const [n, size] of test.oldRSSizes.entries()) {
				const replicaSet = newReplicaSet(test.d, `${test.d.metadata?.name}-${n}`, size);
				oldRSs.push(replicaSet);

				const rsCopy = structuredClone(replicaSet);
				if (!rsCopy.spec) {
					throw new Error("replicaSetCopy.Spec is nil");
				}
				rsCopy.spec.replicas = 0;
				expected.push(rsCopy);

				expect(oldRSs[n]?.spec?.replicas).not.toBe(expected[n]?.spec?.replicas);
			}

			const [, c] = await newTestDeploymentController(ctx, expected);

			await c.scaleDownOldReplicaSetsForRecreate(ctx, oldRSs, test.d);
			for (const replicaSet of oldRSs) {
				expect({
					scenario: i,
					name: replicaSet.metadata?.name,
					replicas: replicaSet.spec?.replicas,
				}).toEqual({
					scenario: i,
					name: replicaSet.metadata?.name,
					replicas: 0,
				});
			}
		}
	});

	// Models kubernetes/pkg/controller/deployment/recreate_test.go TestOldPodsRunning.
	it("detects old pods running", () => {
		const tests: {
			name: string;
			newRS?: k8s.V1ReplicaSet;
			oldRSs?: k8s.V1ReplicaSet[];
			podMap?: Map<string, k8s.V1Pod[]>;
			hasOldPodsRunning: boolean;
		}[] = [
			{
				name: "no old RSs",
				hasOldPodsRunning: false,
			},
			{
				name: "old RSs with running pods",
				oldRSs: [rsWithUID("some-uid"), rsWithUID("other-uid")],
				podMap: podMapWithUIDs(["some-uid", "other-uid"]),
				hasOldPodsRunning: true,
			},
			{
				name: "old RSs without pods but with non-zero status replicas",
				oldRSs: [newRSWithStatus("rs-1", 0, 1, undefined)],
				hasOldPodsRunning: true,
			},
			{
				name: "old RSs without pods or non-zero status replicas",
				oldRSs: [newRSWithStatus("rs-1", 0, 0, undefined)],
				hasOldPodsRunning: false,
			},
			{
				name: "old RSs with zero status replicas but pods in terminal state are present",
				oldRSs: [newRSWithStatus("rs-1", 0, 0, undefined)],
				podMap: new Map([
					[
						"uid-1",
						[
							{
								status: {
									phase: "Failed",
								},
							},
							{
								status: {
									phase: "Succeeded",
								},
							},
						],
					],
				]),
				hasOldPodsRunning: false,
			},
			{
				name: "old RSs with zero status replicas but pod in unknown phase present",
				oldRSs: [newRSWithStatus("rs-1", 0, 0, undefined)],
				podMap: new Map([
					[
						"uid-1",
						[
							{
								status: {
									phase: "Unknown",
								},
							},
						],
					],
				]),
				hasOldPodsRunning: true,
			},
			{
				name: "old RSs with zero status replicas with pending pod present",
				oldRSs: [newRSWithStatus("rs-1", 0, 0, undefined)],
				podMap: new Map([
					[
						"uid-1",
						[
							{
								status: {
									phase: "Pending",
								},
							},
						],
					],
				]),
				hasOldPodsRunning: true,
			},
			{
				name: "old RSs with zero status replicas with running pod present",
				oldRSs: [newRSWithStatus("rs-1", 0, 0, undefined)],
				podMap: new Map([
					[
						"uid-1",
						[
							{
								status: {
									phase: "Running",
								},
							},
						],
					],
				]),
				hasOldPodsRunning: true,
			},
			{
				name: "old RSs with zero status replicas but pods in terminal state and pending are present",
				oldRSs: [newRSWithStatus("rs-1", 0, 0, undefined)],
				podMap: new Map([
					[
						"uid-1",
						[
							{
								status: {
									phase: "Failed",
								},
							},
							{
								status: {
									phase: "Succeeded",
								},
							},
						],
					],
					["uid-2", []],
					[
						"uid-3",
						[
							{
								status: {
									phase: "Pending",
								},
							},
						],
					],
				]),
				hasOldPodsRunning: true,
			},
		];

		for (const test of tests) {
			expect(oldPodsRunning(test.newRS, test.oldRSs ?? [], test.podMap ?? new Map())).toBe(
				test.hasOldPodsRunning,
			);
		}
	});
});

async function newTestDeploymentController(
	ctx: context.Context,
	objects: k8s.V1ReplicaSet[] = [],
): Promise<[TestKubeClient, DeploymentController]> {
	const [client, kubeConfig] = await newTestKubeClient(ctx, objects);
	return [client, new DeploymentController(client, kubeConfig)];
}

// Models kubernetes/pkg/controller/deployment/recreate_test.go newRSWithStatus.
function newRSWithStatus(
	name: string,
	specReplicas: number,
	statusReplicas: number,
	selector: Record<string, string> | undefined,
): k8s.V1ReplicaSet {
	const replicaSet = rs(name, specReplicas, selector, noTimestamp);
	replicaSet.status = {
		replicas: statusReplicas,
	};
	return replicaSet;
}

// Models kubernetes/pkg/controller/deployment/recreate_test.go rsWithUID.
function rsWithUID(uid: string): k8s.V1ReplicaSet {
	const deployment = newDeployment("foo", 1, undefined, undefined, undefined, { foo: "bar" });
	const replicaSet = newReplicaSet(deployment, `foo-${uid}`, 0);
	replicaSet.metadata ??= {};
	replicaSet.metadata.uid = uid;
	return replicaSet;
}

// Models kubernetes/pkg/controller/deployment/recreate_test.go podMapWithUIDs.
function podMapWithUIDs(uids: string[]): Map<string, k8s.V1Pod[]> {
	const podMap = new Map<string, k8s.V1Pod[]>();
	for (const uid of uids) {
		podMap.set(uid, [{}, {}]);
	}
	return podMap;
}
