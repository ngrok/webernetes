This directory contains the in-browser simulation of Kubernetes CRI-facing
runtime behavior.

The goal is not to clone every CRI field or every operating-system concern.
The goal is to keep the API surface close enough to the Kubernetes kubelet and
kuberuntime source that this project can implement a TypeScript kubelet with
control flow that is easy to compare against the real kubelet.

When changing files in this directory:

- Prefer method names and lifecycle boundaries that match kubelet/CRI source:
  `runPodSandbox`, `stopPodSandbox`, `removePodSandbox`, `createContainer`,
  `startContainer`, `stopContainer`, `removeContainer`, and status/list methods.
- Keep sandbox lifecycle separate from container lifecycle. In Kubernetes, the
  pod sandbox owns the pod network namespace and pod IP; containers are created
  inside a sandbox.
- Allow multiple sandbox attempts for the same pod UID. The real kubelet may
  create a new sandbox for the same pod when the sandbox changes or must be
  recreated.
- Mirror only fields that are used by the simulator or that are needed for
  kubelet control-flow parity. Do not keep CRI fields as inert placeholders just
  because they exist upstream.
- Prefer concrete classes for owned simulator lifecycle objects. Use interfaces
  for passive configs, status snapshots, request/response payloads, and callback
  shapes.
- Keep fake process cancellation cooperative and browser-friendly. Long-running
  image code should use `ProcessContext.signal` or
  `ProcessContext.waitUntilKilled()` rather than promises that never settle.
- Do not add global timer/time calls in this directory. Use the runtime `Clock`
  path so simulator time remains deterministic.

Important Kubernetes source references:

- Kubelet container runtime interface:
  `kubernetes/pkg/kubelet/container/runtime.go`
  - `Runtime`
  - `Pod`
  - `ContainerID`
  - `Container`
  - `PodStatus`
  - `Status`
- Kubelet high-level pod sync flow:
  `kubernetes/pkg/kubelet/kubelet.go`
  - `Kubelet.SyncPod`
- Kuberuntime pod sync implementation:
  `kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go`
  - `kubeGenericRuntimeManager.SyncPod`
  - `computePodActions`
  - `KillPod`
- Kuberuntime sandbox creation:
  `kubernetes/pkg/kubelet/kuberuntime/kuberuntime_sandbox.go`
  - `createPodSandbox`
  - `generatePodSandboxConfig`
- Kuberuntime container creation/start/stop/remove:
  `kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go`
  - `startContainer`
  - `killContainer`
  - `removeContainer`
- CRI API shapes:
  `kubernetes/cri-api/pkg/apis/runtime/v1/api.proto`
  - `RunPodSandboxRequest`
  - `RunPodSandboxResponse`
  - `PodSandboxConfig`
  - `PodSandboxMetadata`
  - `PodSandboxStatus`
  - `CreateContainerRequest`
  - `ContainerConfig`
  - `ContainerMetadata`
  - `StartContainerRequest`
  - `StopContainerRequest`
  - `RemoveContainerRequest`

For local reference, inspect these upstream files from GitHub rather than
guessing at kubelet behavior. The implementation here can intentionally omit
real-node concerns such as cgroups, log symlinks, filesystem cleanup, and
garbage collection, because fake browser processes are fully controlled by the
simulator.
