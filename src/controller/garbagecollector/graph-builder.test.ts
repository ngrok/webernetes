/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import { browser } from "../../test/describe";
import { makeID, makeNode, withOwners } from "./garbage-collector-test-helpers";
import { getAlternateOwnerIdentity } from "./graph-builder";
import type { Node, ObjectReference } from "./graph";

browser.describe("garbagecollector GraphBuilder", () => {
	// Models kubernetes/pkg/controller/garbagecollector/graph_builder_test.go TestGetAlternateOwnerIdentity.
	it("GetAlternateOwnerIdentity", () => {
		const ns1child1 = makeID("v1", "Child", "ns1", "child1", "childuid11");
		const ns1child2 = makeID("v1", "Child", "ns1", "child2", "childuid12");
		const ns2child1 = makeID("v1", "Child", "ns2", "child1", "childuid21");
		const clusterchild1 = makeID("v1", "Child", "", "child1", "childuidc1");

		const nsabsentparentns1 = makeID("v1", "NSParent", "ns1", "parentname", "parentuid");
		const nsabsentparentns2 = makeID("v1", "NSParent", "ns2", "parentname", "parentuid");
		const nsabsentparentVersion = makeID("xx", "NSParent", "ns1", "parentname", "parentuid");
		const nsabsentparentKind = makeID("v1", "xxxxxxxx", "ns1", "parentname", "parentuid");
		const nsabsentparentName = makeID("v1", "NSParent", "ns1", "xxxxxxxxxx", "parentuid");

		const clusterabsentparent = makeID("v1", "ClusterParent", "", "parentname", "parentuid");
		const clusterabsentparentVersion = makeID("xx", "ClusterParent", "", "parentname", "parentuid");
		const clusterabsentparentKind = makeID("v1", "xxxxxxxxxxxxx", "", "parentname", "parentuid");
		const clusterabsentparentName = makeID("v1", "ClusterParent", "", "xxxxxxxxxx", "parentuid");
		const clusterabsentparentNs1Version = makeID(
			"xx",
			"ClusterParent",
			"ns1",
			"parentname",
			"parentuid",
		);
		const clusterabsentparentNs1Kind = makeID(
			"v1",
			"xxxxxxxxxxxxx",
			"ns1",
			"parentname",
			"parentuid",
		);

		const orderedNamespacedReferences = ["v1", "v2", "v3", "v4", "v5"].map((version) =>
			makeID(version, "kind", "ns1", "name", "uid"),
		);
		const orderedClusterReferences = ["v1", "v2", "v3", "v4", "v5"].map((version) =>
			makeID(version, "kind", "", "name", "uid"),
		);
		const firstNamespacedReference = orderedNamespacedReferences[0];
		const nextToLastNamespacedReference =
			orderedNamespacedReferences[orderedNamespacedReferences.length - 2];
		const lastNamespacedReference =
			orderedNamespacedReferences[orderedNamespacedReferences.length - 1];
		const firstClusterReference = orderedClusterReferences[0];
		const nextToLastClusterReference =
			orderedClusterReferences[orderedClusterReferences.length - 2];
		const lastClusterReference = orderedClusterReferences[orderedClusterReferences.length - 1];
		if (
			!firstNamespacedReference ||
			!nextToLastNamespacedReference ||
			!lastNamespacedReference ||
			!firstClusterReference ||
			!nextToLastClusterReference ||
			!lastClusterReference
		) {
			throw new Error("expected ordered references");
		}

		const testcases: Array<{
			name: string;
			deps: Node[];
			verifiedAbsent: ObjectReference;
			expectedAlternate: ObjectReference | undefined;
		}> = [
			{
				name: "namespaced alternate version",
				deps: [
					makeNode(ns1child1, withOwners(nsabsentparentns1)),
					makeNode(ns1child2, withOwners(nsabsentparentVersion)),
				],
				verifiedAbsent: nsabsentparentns1,
				expectedAlternate: nsabsentparentVersion,
			},
			{
				name: "namespaced alternate kind",
				deps: [
					makeNode(ns1child1, withOwners(nsabsentparentns1)),
					makeNode(ns1child2, withOwners(nsabsentparentKind)),
				],
				verifiedAbsent: nsabsentparentns1,
				expectedAlternate: nsabsentparentKind,
			},
			{
				name: "namespaced alternate namespace",
				deps: [
					makeNode(ns1child1, withOwners(nsabsentparentns1)),
					makeNode(ns2child1, withOwners(nsabsentparentns2)),
				],
				verifiedAbsent: nsabsentparentns1,
				expectedAlternate: nsabsentparentns2,
			},
			{
				name: "namespaced alternate name",
				deps: [
					makeNode(ns1child1, withOwners(nsabsentparentns1)),
					makeNode(ns1child1, withOwners(nsabsentparentName)),
				],
				verifiedAbsent: nsabsentparentns1,
				expectedAlternate: nsabsentparentName,
			},
			{
				name: "cluster alternate version",
				deps: [
					makeNode(ns1child1, withOwners(clusterabsentparent)),
					makeNode(ns1child2, withOwners(clusterabsentparentVersion)),
				],
				verifiedAbsent: clusterabsentparent,
				expectedAlternate: clusterabsentparentNs1Version,
			},
			{
				name: "cluster alternate kind",
				deps: [
					makeNode(ns1child1, withOwners(clusterabsentparent)),
					makeNode(ns1child2, withOwners(clusterabsentparentKind)),
				],
				verifiedAbsent: clusterabsentparent,
				expectedAlternate: clusterabsentparentNs1Kind,
			},
			{
				name: "cluster alternate namespace",
				deps: [
					makeNode(ns1child1, withOwners(clusterabsentparent)),
					makeNode(ns2child1, withOwners(clusterabsentparent)),
				],
				verifiedAbsent: clusterabsentparent,
				expectedAlternate: undefined,
			},
			{
				name: "cluster alternate name",
				deps: [
					makeNode(ns1child1, withOwners(clusterabsentparent)),
					makeNode(ns1child1, withOwners(clusterabsentparentName)),
				],
				verifiedAbsent: clusterabsentparent,
				expectedAlternate: clusterabsentparentName,
			},
			{
				name: "namespaced ref from namespaced child returns first if absent is sorted last",
				deps: [makeNode(ns1child1, withOwners(...orderedNamespacedReferences))],
				verifiedAbsent: lastNamespacedReference,
				expectedAlternate: firstNamespacedReference,
			},
			{
				name: "namespaced ref from namespaced child returns next after absent",
				deps: [makeNode(ns1child1, withOwners(...orderedNamespacedReferences))],
				verifiedAbsent: nextToLastNamespacedReference,
				expectedAlternate: lastNamespacedReference,
			},
			{
				name: "cluster ref from cluster child returns first if absent is sorted last",
				deps: [makeNode(clusterchild1, withOwners(...orderedClusterReferences))],
				verifiedAbsent: lastClusterReference,
				expectedAlternate: firstClusterReference,
			},
			{
				name: "cluster ref from cluster child returns next after absent",
				deps: [makeNode(clusterchild1, withOwners(...orderedClusterReferences))],
				verifiedAbsent: nextToLastClusterReference,
				expectedAlternate: lastClusterReference,
			},
			{
				name: "ignore unrelated",
				deps: [
					makeNode(
						ns1child1,
						withOwners(clusterabsentparent, makeID("v1", "Parent", "ns1", "name", "anotheruid")),
					),
				],
				verifiedAbsent: clusterabsentparent,
				expectedAlternate: undefined,
			},
			{
				name: "ignore matches",
				deps: [makeNode(ns1child1, withOwners(clusterabsentparent, clusterabsentparent))],
				verifiedAbsent: clusterabsentparent,
				expectedAlternate: undefined,
			},
			{
				name: "collapse duplicates",
				deps: [
					makeNode(
						clusterchild1,
						withOwners(clusterabsentparent, clusterabsentparentKind, clusterabsentparentKind),
					),
				],
				verifiedAbsent: clusterabsentparent,
				expectedAlternate: clusterabsentparentKind,
			},
		];

		for (const testcase of testcases) {
			expect({
				alternate: getAlternateOwnerIdentity(testcase.deps, testcase.verifiedAbsent),
				name: testcase.name,
			}).toEqual({ alternate: testcase.expectedAlternate, name: testcase.name });
		}
	});
});
