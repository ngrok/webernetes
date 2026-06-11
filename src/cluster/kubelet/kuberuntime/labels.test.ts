/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";
import type { V1Container, V1ContainerPort, V1Lifecycle, V1Pod } from "../../../client";
import { browser } from "../../../test/describe";
import { hashContainer, type RunContainerOptions } from "../container";
import {
	getContainerInfoFromAnnotations,
	newContainerAnnotations,
	type AnnotatedContainerInfo,
} from "./labels";

// Models kubernetes/pkg/kubelet/kuberuntime/labels_test.go TestContainerAnnotations.
browser.describe("TestContainerAnnotations", ({ ctx }) => {
	it("TestContainerAnnotations", () => {
		const restartCount = 5;
		const deletionGracePeriod = 10;
		const terminationGracePeriod = 10;
		const opts: RunContainerOptions = {
			annotations: [{ name: "Foo", value: "bar" }],
		};
		const lifecycle: V1Lifecycle = {
			// Left PostStart as nil
			preStop: {
				exec: {
					command: ["action1", "action2"],
				},
				httpGet: {
					path: "path",
					host: "host",
					port: 8080,
					scheme: "scheme",
				},
				tcpSocket: {
					port: "80",
				},
			},
		};
		const containerPorts: V1ContainerPort[] = [
			{
				name: "http",
				hostPort: 80,
				containerPort: 8080,
				protocol: "TCP",
			},
			{
				name: "https",
				hostPort: 443,
				containerPort: 6443,
				protocol: "TCP",
			},
		];
		const container: V1Container = {
			name: "test_container",
			ports: containerPorts,
			terminationMessagePath: "/somepath",
			lifecycle,
		};
		const pod: V1Pod = {
			metadata: {
				name: "test_pod",
				namespace: "test_pod_namespace",
				uid: "test_pod_uid",
				deletionGracePeriodSeconds: deletionGracePeriod,
			},
			spec: {
				containers: [container],
				terminationGracePeriodSeconds: terminationGracePeriod,
			},
		};
		const expected: AnnotatedContainerInfo = {
			containerPorts,
			podDeletionGracePeriod: pod.metadata?.deletionGracePeriodSeconds,
			podTerminationGracePeriod: pod.spec?.terminationGracePeriodSeconds,
			hash: hashContainer(container),
			restartCount,
			terminationMessagePath: container.terminationMessagePath ?? "",
			terminationMessagePolicy: container.terminationMessagePolicy ?? "",
			preStopHandler: container.lifecycle?.preStop,
		};

		let annotations = newContainerAnnotations(ctx, container, pod, restartCount, opts);
		let containerInfo = getContainerInfoFromAnnotations(ctx, annotations);
		expect(containerInfo).toEqual(expected);
		const optAnnotation = opts.annotations?.[0];
		expect(optAnnotation).toBeDefined();
		expect(annotations[optAnnotation?.name ?? ""]).toBe(optAnnotation?.value);

		container.lifecycle = undefined;
		if (pod.metadata) {
			pod.metadata.deletionGracePeriodSeconds = undefined;
		}
		if (pod.spec) {
			pod.spec.terminationGracePeriodSeconds = undefined;
		}
		expected.podDeletionGracePeriod = undefined;
		expected.podTerminationGracePeriod = undefined;
		expected.preStopHandler = undefined;
		expected.hash = hashContainer(container);
		annotations = newContainerAnnotations(ctx, container, pod, restartCount, opts);
		containerInfo = getContainerInfoFromAnnotations(ctx, annotations);
		expect(containerInfo).toEqual(expected);
		expect(annotations[optAnnotation?.name ?? ""]).toBe(optAnnotation?.value);
	});
});
