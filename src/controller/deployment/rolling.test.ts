/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import type * as k8s from "../../client";
import {
	newTestKubeClient,
	type ClientAction,
	type TestKubeClient,
	type TestKubeClientObject,
} from "../../client/test";
import * as context from "../../go/context";
import { browser } from "../../test/describe";
import { DeploymentController } from "./deployment-controller";
import { newDeployment, noTimestamp, rs } from "./test-helpers";

type ReplicaSetUpdateAction = ClientAction & {
	verb: "update";
	resource: "replicasets";
	request: {
		body: k8s.V1ReplicaSet;
	};
};

browser.describe("DeploymentController rolling", ({ ctx }) => {
	// Models kubernetes/pkg/controller/deployment/rolling_test.go TestDeploymentController_reconcileNewReplicaSet.
	it("reconciles new replica sets", async () => {
		const tests: {
			deploymentReplicas: number;
			maxSurge: k8s.IntOrString;
			oldReplicas: number;
			newReplicas: number;
			scaleExpected: boolean;
			expectedNewReplicas?: number;
		}[] = [
			{
				deploymentReplicas: 10,
				maxSurge: 0,
				oldReplicas: 10,
				newReplicas: 0,
				scaleExpected: false,
			},
			{
				deploymentReplicas: 10,
				maxSurge: 2,
				oldReplicas: 10,
				newReplicas: 0,
				scaleExpected: true,
				expectedNewReplicas: 2,
			},
			{
				deploymentReplicas: 10,
				maxSurge: 2,
				oldReplicas: 5,
				newReplicas: 0,
				scaleExpected: true,
				expectedNewReplicas: 7,
			},
			{
				deploymentReplicas: 10,
				maxSurge: 2,
				oldReplicas: 10,
				newReplicas: 2,
				scaleExpected: false,
			},
			{
				deploymentReplicas: 10,
				maxSurge: 2,
				oldReplicas: 2,
				newReplicas: 11,
				scaleExpected: true,
				expectedNewReplicas: 10,
			},
		];

		for (const [i, test] of tests.entries()) {
			const newRS = rs("foo-v2", test.newReplicas, undefined, noTimestamp);
			const oldRS = rs("foo-v2", test.oldReplicas, undefined, noTimestamp);
			const allRSs = [newRS, oldRS];
			const maxUnavailable = 0;
			const deployment = newDeployment(
				"foo",
				test.deploymentReplicas,
				undefined,
				test.maxSurge,
				maxUnavailable,
				{ foo: "bar" },
			);
			const [client, controller] = await newTestDeploymentController(ctx, [newRS]);

			const [scaled, err] = await controller.reconcileNewReplicaSet(ctx, allRSs, newRS, deployment);
			expect(err).toBeUndefined();
			expect({ scenario: i, scaled }).toEqual({
				scenario: i,
				scaled: test.scaleExpected,
			});
			const updateActions = replicaSetUpdateActions(client);
			expect(updateActions).toHaveLength(test.scaleExpected ? 1 : 0);
			if (!test.scaleExpected) {
				continue;
			}
			const updated = updateActions[0]?.request.body;
			expect(updated.spec?.replicas).toBe(test.expectedNewReplicas);
		}
	});

	it("returns reconcile new replica set errors", async () => {
		const newRS = rs("foo-v2", 0, { foo: "bar" }, noTimestamp);
		const deployment = newDeployment("foo", 3, undefined, 1, 0, { foo: "bar" });
		const [, controller] = await newTestDeploymentController(ctx);

		const [scaled, err] = await controller.reconcileNewReplicaSet(ctx, [newRS], newRS, deployment);

		expect(scaled).toBe(false);
		expect(err).toBeDefined();
	});

	// Models kubernetes/pkg/controller/deployment/rolling_test.go TestDeploymentController_reconcileOldReplicaSets.
	it("reconciles old replica sets", async () => {
		const tests: {
			deploymentReplicas: number;
			maxUnavailable: k8s.IntOrString;
			oldReplicas: number;
			newReplicas: number;
			readyPodsFromOldRS: number;
			readyPodsFromNewRS: number;
			scaleExpected: boolean;
			expectedOldReplicas?: number;
		}[] = [
			{
				deploymentReplicas: 10,
				maxUnavailable: 0,
				oldReplicas: 10,
				newReplicas: 0,
				readyPodsFromOldRS: 10,
				readyPodsFromNewRS: 0,
				scaleExpected: true,
				expectedOldReplicas: 9,
			},
			{
				deploymentReplicas: 10,
				maxUnavailable: 2,
				oldReplicas: 10,
				newReplicas: 0,
				readyPodsFromOldRS: 10,
				readyPodsFromNewRS: 0,
				scaleExpected: true,
				expectedOldReplicas: 8,
			},
			{
				deploymentReplicas: 10,
				maxUnavailable: 2,
				oldReplicas: 10,
				newReplicas: 0,
				readyPodsFromOldRS: 8,
				readyPodsFromNewRS: 0,
				scaleExpected: true,
				expectedOldReplicas: 8,
			},
			{
				deploymentReplicas: 10,
				maxUnavailable: 2,
				oldReplicas: 10,
				newReplicas: 0,
				readyPodsFromOldRS: 9,
				readyPodsFromNewRS: 0,
				scaleExpected: true,
				expectedOldReplicas: 8,
			},
			{
				deploymentReplicas: 10,
				maxUnavailable: 2,
				oldReplicas: 8,
				newReplicas: 2,
				readyPodsFromOldRS: 8,
				readyPodsFromNewRS: 0,
				scaleExpected: false,
			},
		];
		for (const [i, test] of tests.entries()) {
			const newSelector = { foo: "new" };
			const oldSelector = { foo: "old" };
			const newRS = rs("foo-new", test.newReplicas, newSelector, noTimestamp);
			newRS.status = {
				...(newRS.status ?? { replicas: 0 }),
				availableReplicas: test.readyPodsFromNewRS,
			};
			const oldRS = rs("foo-old", test.oldReplicas, oldSelector, noTimestamp);
			oldRS.status = {
				...(oldRS.status ?? { replicas: 0 }),
				availableReplicas: test.readyPodsFromOldRS,
			};
			const oldRSs = [oldRS];
			const allRSs = [oldRS, newRS];
			const maxSurge = 0;
			const deployment = newDeployment(
				"foo",
				test.deploymentReplicas,
				undefined,
				maxSurge,
				test.maxUnavailable,
				newSelector,
			);
			const [, controller] = await newTestDeploymentController(ctx, allRSs);

			const [scaled, err] = await controller.reconcileOldReplicaSets(
				ctx,
				allRSs,
				oldRSs,
				newRS,
				deployment,
			);
			expect(err).toBeUndefined();
			expect({
				scenario: i,
				scaled,
				expectedOldReplicasSet: test.expectedOldReplicas !== undefined,
			}).toEqual({
				scenario: i,
				scaled: test.scaleExpected,
				expectedOldReplicasSet: test.scaleExpected,
			});
		}
	});

	// Models kubernetes/pkg/controller/deployment/rolling_test.go TestDeploymentController_cleanupUnhealthyReplicas.
	it("cleans up unhealthy replicas", async () => {
		const tests = [
			{
				oldReplicas: 10,
				readyPods: 8,
				unHealthyPods: 2,
				maxCleanupCount: 1,
				cleanupCountExpected: 1,
			},
			{
				oldReplicas: 10,
				readyPods: 8,
				unHealthyPods: 2,
				maxCleanupCount: 3,
				cleanupCountExpected: 2,
			},
			{
				oldReplicas: 10,
				readyPods: 8,
				unHealthyPods: 2,
				maxCleanupCount: 0,
				cleanupCountExpected: 0,
			},
			{
				oldReplicas: 10,
				readyPods: 10,
				unHealthyPods: 0,
				maxCleanupCount: 3,
				cleanupCountExpected: 0,
			},
		];

		for (const [i, test] of tests.entries()) {
			const oldRS = rs("foo-v2", test.oldReplicas, undefined, noTimestamp);
			oldRS.status = {
				...(oldRS.status ?? { replicas: 0 }),
				availableReplicas: test.readyPods,
			};
			const oldRSs = [oldRS];
			const maxSurge = 2;
			const maxUnavailable = 2;
			const deployment = newDeployment("foo", 10, undefined, maxSurge, maxUnavailable, undefined);
			const [, controller] = await newTestDeploymentController(ctx, oldRSs);

			const [, cleanupCount, err] = await controller.cleanupUnhealthyReplicas(
				ctx,
				oldRSs,
				deployment,
				test.maxCleanupCount,
			);
			expect(err).toBeUndefined();
			expect({ scenario: i, cleanupCount }).toEqual({
				scenario: i,
				cleanupCount: test.cleanupCountExpected,
			});
			expect(test.unHealthyPods).toBe(test.oldReplicas - test.readyPods);
		}
	});

	// Models kubernetes/pkg/controller/deployment/rolling_test.go TestDeploymentController_scaleDownOldReplicaSetsForRollingUpdate.
	it("scales down old replica sets for rolling update", async () => {
		const tests: {
			deploymentReplicas: number;
			maxUnavailable: k8s.IntOrString;
			readyPods: number;
			oldReplicas: number;
			scaleExpected: boolean;
			expectedOldReplicas?: number;
		}[] = [
			{
				deploymentReplicas: 10,
				maxUnavailable: 0,
				readyPods: 10,
				oldReplicas: 10,
				scaleExpected: true,
				expectedOldReplicas: 9,
			},
			{
				deploymentReplicas: 10,
				maxUnavailable: 2,
				readyPods: 10,
				oldReplicas: 10,
				scaleExpected: true,
				expectedOldReplicas: 8,
			},
			{
				deploymentReplicas: 10,
				maxUnavailable: 2,
				readyPods: 8,
				oldReplicas: 10,
				scaleExpected: false,
			},
			{
				deploymentReplicas: 10,
				maxUnavailable: 2,
				readyPods: 10,
				oldReplicas: 0,
				scaleExpected: false,
			},
			{
				deploymentReplicas: 10,
				maxUnavailable: 2,
				readyPods: 1,
				oldReplicas: 10,
				scaleExpected: false,
			},
		];

		for (const [i, test] of tests.entries()) {
			const oldRS = rs("foo-v2", test.oldReplicas, undefined, noTimestamp);
			oldRS.status = {
				...(oldRS.status ?? { replicas: 0 }),
				availableReplicas: test.readyPods,
			};
			const allRSs = [oldRS];
			const oldRSs = [oldRS];
			const maxSurge = 0;
			const deployment = newDeployment(
				"foo",
				test.deploymentReplicas,
				undefined,
				maxSurge,
				test.maxUnavailable,
				{ foo: "bar" },
			);
			const [client, controller] = await newTestDeploymentController(ctx, allRSs);

			const [scaled, err] = await controller.scaleDownOldReplicaSetsForRollingUpdate(
				ctx,
				allRSs,
				oldRSs,
				deployment,
			);
			expect(err).toBeUndefined();
			expect({ scenario: i, scaled }).toEqual({
				scenario: i,
				scaled: test.scaleExpected ? test.oldReplicas - (test.expectedOldReplicas ?? 0) : 0,
			});
			const updateActions = replicaSetUpdateActions(client);
			expect(updateActions).toHaveLength(test.scaleExpected ? 1 : 0);
			if (!test.scaleExpected) {
				continue;
			}
			expect(updateActions[0]?.request.body.spec?.replicas).toBe(test.expectedOldReplicas);
		}
	});
});

async function newTestDeploymentController(
	ctx: context.Context,
	objects: TestKubeClientObject[] = [],
): Promise<[TestKubeClient, DeploymentController]> {
	const [client, kubeConfig] = await newTestKubeClient(ctx, objects);
	return [client, new DeploymentController(client, kubeConfig)];
}

function replicaSetUpdateActions(client: TestKubeClient): ReplicaSetUpdateAction[] {
	return client.actions().filter(isReplicaSetUpdateAction);
}

function isReplicaSetUpdateAction(action: ClientAction): action is ReplicaSetUpdateAction {
	return action.verb === "update" && action.resource === "replicasets";
}
