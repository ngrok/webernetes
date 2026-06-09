/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { V1Container, V1Pod } from "../../../client";
import type { ContainerConfig } from "../../cri";

// Models kubernetes/pkg/kubelet/cm/internal_container_lifecycle.go InternalContainerLifecycle.
export interface InternalContainerLifecycle {
	preCreateContainer(
		pod: V1Pod,
		container: V1Container,
		containerConfig: ContainerConfig,
	): Error | undefined;
	preStartContainer(pod: V1Pod, container: V1Container, containerID: string): Error | undefined;
	postStopContainer(containerID: string): Error | undefined;
}

// Models kubernetes/pkg/kubelet/cm/fake_internal_container_lifecycle.go NewFakeInternalContainerLifecycle.
export function newFakeInternalContainerLifecycle(): InternalContainerLifecycle {
	return new FakeInternalContainerLifecycle();
}

// Models kubernetes/pkg/kubelet/cm/fake_internal_container_lifecycle.go fakeInternalContainerLifecycle.
class FakeInternalContainerLifecycle implements InternalContainerLifecycle {
	preCreateContainer(
		_pod: V1Pod,
		_container: V1Container,
		_containerConfig: ContainerConfig,
	): Error | undefined {
		return undefined;
	}

	preStartContainer(_pod: V1Pod, _container: V1Container, _containerID: string): Error | undefined {
		return undefined;
	}

	postStopContainer(_containerID: string): Error | undefined {
		return undefined;
	}
}
