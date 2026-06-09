# Node Self-Registration, Heartbeats, and Lifecycle Plan

This plan targets Kubernetes 1.36 parity using the local upstream checkout at
`~/Developer/github.com/kubernetes/kubernetes` commit
`ecf6decece6a6de25a57aad9ba90b6ce580f6f78`.

The goal is to model node startup and liveness as Kubernetes does:

- kubelets self-register their own `Node` objects
- kubelets update `Node.status`
- kubelets renew `Lease` heartbeats in `kube-node-lease`
- a node lifecycle controller observes Nodes and Leases and marks stale nodes
  unhealthy
- `Cluster.addNode()` creates a server and boots its kubelet; it does not create
  the `Node` object directly

For now, the node lifecycle controller should be modeled as a cluster workload
image, matching this simulator's current controller style. This intentionally
differs from upstream, where node lifecycle runs in-process inside
`kube-controller-manager`.

## Upstream Reference Map

Kubelet node registration and status:

- `pkg/kubelet/kubelet_node_status.go`
  - `registerWithAPIServer`
  - `tryRegisterWithAPIServer`
  - `initialNode`
  - `syncNodeStatus`
  - `updateNodeStatus`
  - `tryUpdateNodeStatus`
- `pkg/kubelet/kubelet.go`
  - `nodeLeaseRenewIntervalFraction`
  - `NewMainKubelet` node lease controller wiring
  - `Run` startup of `syncNodeStatus` and `nodeLeaseController.Run`
- `pkg/kubelet/apis/config/types.go`
  - `NodeStatusUpdateFrequency`
  - `NodeStatusReportFrequency`
  - `NodeLeaseDurationSeconds`
  - `RegisterNode`
- `pkg/kubelet/apis/config/v1beta1/defaults.go`
  - `NodeStatusUpdateFrequency = 10s`
  - `NodeLeaseDurationSeconds = 40`
  - `RegisterNode = true`

Lease controller:

- `staging/src/k8s.io/component-helpers/apimachinery/lease/controller.go`
  - `NewController`
  - `Run`
  - `sync`
  - `ensureLease`
  - `retryUpdateLease`
  - `newLease`
- `pkg/kubelet/util/nodelease.go`
  - `SetNodeOwnerFunc`

Node lifecycle controller:

- `cmd/kube-controller-manager/names/controller_names.go`
  - `NodeLifecycleController = "node-lifecycle-controller"`
- `cmd/kube-controller-manager/app/controller_descriptor.go`
  - registers `newNodeLifecycleControllerDescriptor`
- `cmd/kube-controller-manager/app/core.go`
  - `newNodeLifecycleController`
- `pkg/controller/nodelifecycle/node_lifecycle_controller.go`
  - `NewNodeLifecycleController`
  - `monitorNodeHealth`
  - `tryUpdateNodeHealth`
  - taint and eviction queues
- `pkg/controller/nodelifecycle/config/types.go`
- `pkg/controller/nodelifecycle/config/v1alpha1/defaults.go`
  - `NodeMonitorGracePeriod = 50s`
  - `NodeStartupGracePeriod = 60s`

Upstream process placement:

- Node lifecycle is not its own pod image upstream. It is one controller loop
  inside the `kube-controller-manager` binary.
- Simulator placement for now: keep it as a separate image, similar to the
  existing scheduler, namespace controller, and endpoint slice controller
  images. The image should contain a close TypeScript transliteration of
  upstream node lifecycle code where possible.

## Phase 1: Coordination Lease API and Storage

Add the minimal public API surface needed for kubelet node leases.

Files and types to add:

- `src/client/gen/models/V1Lease.ts`
- `src/client/gen/models/V1LeaseSpec.ts`
- `src/client/gen/models/V1LeaseList.ts`
- any generated-index exports needed by the fake client
- `src/client/gen/apis/types/CoordinationV1Api.ts`
- `src/client/gen/apis/impls/CoordinationV1Api.ts`
- `src/cluster/storage/lease.ts`

The model shape should mirror `coordination.k8s.io/v1`:

- `metadata`
- `spec.holderIdentity`
- `spec.leaseDurationSeconds`
- `spec.acquireTime`
- `spec.renewTime`
- `spec.leaseTransitions`
- `spec.strategy`
- `spec.preferredHolder`

Only `holderIdentity`, `leaseDurationSeconds`, and `renewTime` are required for
node heartbeat behavior, but the exported type should match the real client
surface closely enough for shared tests later.

API behavior needed:

- create namespaced lease
- read namespaced lease
- replace namespaced lease
- patch namespaced lease
- delete namespaced lease
- list namespaced leases
- watch support if existing storage/watch patterns make this straightforward

Cluster initialization must create `kube-node-lease` namespace before kubelets
try to create leases. Upstream constant is `v1.NamespaceNodeLease`.

Tests:

- Add client parity-style tests if the harness supports `CoordinationV1Api`.
- At minimum add simulator browser tests for CRUD/list/watch equivalent to
  existing node/service storage tests.

## Phase 2: Kubelet Self-Registration

Move node creation out of `Cluster.init()` and into kubelet startup.

New or expanded kubelet state:

- `registerNode: boolean`
- `registrationCompleted: boolean`
- `nodeStatusUpdateFrequencyMs`
- `nodeStatusReportFrequencyMs`
- `nodeLeaseDurationSeconds`
- `lastStatusReportTime`
- `nodeLeaseController`

Defaults should mirror upstream:

- `registerNode = true`
- `nodeStatusUpdateFrequencyMs = 10_000`
- `nodeStatusReportFrequencyMs = nodeStatusUpdateFrequencyMs` unless explicitly
  configured
- `nodeLeaseDurationSeconds = 40`
- `nodeLeaseRenewIntervalFraction = 0.25`

Port as closely as possible:

- `registerWithAPIServer(ctx)` from
  `pkg/kubelet/kubelet_node_status.go`
- `tryRegisterWithAPIServer(ctx, node)` from the same file
- `initialNode(ctx)` from the same file

Local constraints and explicit deviations:

- Use the simulator `Clock` for backoff timing instead of `time.Sleep`.
- Keep unsupported upstream fields explicit. Do not add fake resource
  allocation/cadvisor/volume behavior just to populate capacity.
- Preserve upstream return/control-flow shape where possible. Since local code
  mirrors Go `(value, error)` using tuples, use tuple returns rather than
  throwing inside mirrored helpers.

Expected behavior:

- `Cluster.addNode()` constructs a `Server`, pushes it into `cluster.servers`,
  boots it, and returns it.
- `Server` constructs local node intent from `name`, `podCIDR`, and
  `ipAddresses`, but passes it to kubelet as input for `initialNode`.
- The kubelet calls `corev1.createNode`.
- `AlreadyExists` should follow upstream's reconciliation path rather than
  failing. Start with the supported subset: fetch existing node, reconcile the
  fields we own, and treat success as registered.

Tests:

- `Cluster.init()` still creates the default nodes, but by kubelet
  self-registration.
- `cluster.addNode({ name, podCIDR, ipAddresses })` returns a `Server`, and the
  Node appears through `corev1.readNode/listNode`.
- The kubelet's `getNode(ctx)` returns the registered node.
- Existing-node registration is tolerated.

## Phase 3: Kubelet Node Status Sync

Port the upstream shape from `pkg/kubelet/kubelet_node_status.go`.

Core methods:

- `syncNodeStatus(ctx)`
- `updateNodeStatus(ctx)`
- `tryUpdateNodeStatus(ctx, tryNumber)`
- `isUpdateStatusPeriodExpired`
- `calculateDelay` if status report jitter is modeled
- `updateNode(ctx, originalNode)` as the supported subset of upstream setters

The control flow should remain close to upstream:

```text
syncNodeStatus
  if no kube client / heartbeat client: return
  if registerNode: registerWithAPIServer
  updateNodeStatus

updateNodeStatus
  retry nodeStatusUpdateRetry times
  call tryUpdateNodeStatus
  call onRepeatedHeartbeatFailure after repeated failures
```

Status fields to support first:

- `status.addresses`
- `status.conditions`
  - `Ready`
  - `MemoryPressure`
  - `DiskPressure`
  - `PIDPressure`
- `status.nodeInfo` if the generated type supports a faithful static value
- preserve unknown existing status fields when patching/replacing

`Ready` should reflect the simulator's actual runtime/network readiness:

- `True` when runtime and network are ready
- `False` when kubelet is running but knows runtime/network are not ready
- `Unknown` is owned by node lifecycle controller when heartbeats stop

Timing:

- Start the loop from `Kubelet.run()`, matching upstream's `Run` behavior.
- Use `Clock` intervals, not global timers.
- Ensure shutdown cancels the loop and leaves no pending clock tasks.

Tests:

- Kubelet registers and posts initial `Ready=True`.
- Changing runtime/network readiness causes `Ready=False` on next sync.
- `Ready` condition last heartbeat time updates on sync.
- `NodeReady` remains last among node conditions, matching upstream tests where
  applicable.

## Phase 4: Kubelet Node Lease Controller

Port `staging/src/k8s.io/component-helpers/apimachinery/lease/controller.go`
into TypeScript, ideally under a component-helper path such as:

- `src/component-helpers/apimachinery/lease/controller.ts`

Then wire it from kubelet as upstream does in `pkg/kubelet/kubelet.go`.

Required behavior:

- renew interval is `nodeLeaseDurationSeconds * 0.25`
- create lease if missing
- update existing lease if present
- set:
  - `metadata.name = nodeName`
  - `metadata.namespace = "kube-node-lease"`
  - `spec.holderIdentity = nodeName`
  - `spec.leaseDurationSeconds = nodeLeaseDurationSeconds`
  - `spec.renewTime = clock.now()`
- set owner reference to the Node once node UID is available, mirroring
  `pkg/kubelet/util/nodelease.go SetNodeOwnerFunc`
- retry update conflicts in the same structure as upstream where local API
  semantics support it

Local deviation:

- Upstream intentionally runs the lease controller on `context.Background()` so
  lease renewal can continue during graceful shutdown. In this simulator,
  cancellation behavior should be explicit and tested. If we keep it renewing
  during graceful kubelet shutdown, use a separate context and close it in
  `Kubelet.close()` so no clock tasks remain.

Tests:

- lease is created in `kube-node-lease`
- `renewTime` advances after fake clock ticks
- owner reference is added after Node exists
- lease renewal stops on kubelet close

## Phase 5: Node Lifecycle Controller Image

Create a workload image, for now, even though upstream runs this inside
`kube-controller-manager`.

Likely file:

- `src/cluster/images/node-lifecycle-controller.ts`

Register in `Cluster`:

- image name: `webernetes/node-lifecycle-controller:latest`
- control plane pod in `kube-system`

The TypeScript implementation inside the image should be a close port of:

- `pkg/controller/nodelifecycle/node_lifecycle_controller.go`

Constructor inputs should mirror upstream conceptually:

- lease lister/client
- pod lister/client
- node lister/client
- daemonset lister can be a placeholder only if daemonset-specific behavior is
  not yet modeled
- kube client
- node monitor period
- node startup grace period
- node monitor grace period
- eviction rates and zone thresholds

Defaults:

- `NodeMonitorGracePeriod = 50s`
- `NodeStartupGracePeriod = 60s`
- `NodeMonitorPeriod = 10s` based on kube-controller-manager defaults observed
  in upstream option tests

First implementation scope:

- monitor Node and Lease freshness
- maintain `nodeHealthMap`
- if Lease renews, update probe timestamp
- if Node Ready heartbeat changes, update probe timestamp and transition
  timestamp
- if neither status nor lease updates before grace period, set conditions to
  `Unknown`

Port closely:

- `tryUpdateNodeHealth`
- the condition transition logic around saved/current Ready condition
- the logic that treats renewed Lease as a health signal
- the stale node branch that sets conditions to:
  - `NodeStatusNeverUpdated` / `Kubelet never posted node status.`
  - `NodeStatusUnknown` / `Kubelet stopped posting node status.`

Defer unless needed for immediate tests:

- full zone disruption state
- rate-limited pod eviction queues
- taint manager integration
- daemonset-specific pod handling

Do not silently omit these. Add explicit placeholders or TODOs with upstream
source comments where code is intentionally not yet modeled.

Tests:

- recently created node with no status remains tolerated during startup grace
  period
- node with renewed lease remains healthy even if status is old
- node with stale status and stale/missing lease becomes `Ready=Unknown`
- controller uses `kube-node-lease/<nodeName>` renew time
- controller-created condition reason/message match upstream

## Phase 6: Cluster API and Scheduling Integration

Add:

```ts
async addNode(options: {
  name: string;
  podCIDR: string;
  ipAddresses: string[];
  kubeletConfiguration?: KubeletConfiguration;
}): Promise<Server>
```

Behavior:

- create `Server`
- push to `this.servers`
- boot server
- return server
- do not directly create the `Node` object

Update `Cluster.init()`:

- create namespaces:
  - `default`
  - `kube-system`
  - `kube-node-lease`
- use `addNode()` for the initial nodes
- start/register the node lifecycle controller image with other control plane
  images

Scheduler integration:

- current scheduler gets node names from `this.servers.map(...)` at image
  construction time. That will not see nodes added later.
- Change scheduler to list/watch `Node` objects from the API, closer to
  upstream. This is required for `addNode()` to affect new scheduling decisions.

Tests:

- a pod created after `addNode()` can schedule to the new node
- scheduler does not schedule to nodes marked `Ready=Unknown` once that behavior
  is implemented

## Audit Requirements Before Finishing Implementation

For each upstream-parity file or test:

- include `// Models <upstream path> <name>` breadcrumbs
- port tests before implementation where practical
- keep table names, helper names, and control-flow distinctions close to
  upstream
- report intentional deviations with concrete reasons
- use simulator `Clock` for all timing
- do not introduce resource allocation, volume, static pod, RuntimeClass, or
  image credential behavior beyond current simulator scope unless explicitly
  required

## Current Known Gaps in the Repository

- No CoordinationV1/Lease API surface yet.
- Kubelet does not yet self-register; `Cluster.init()` currently creates Nodes.
- Kubelet does not yet run a node status sync loop.
- Kubelet does not yet renew node leases.
- Scheduler currently receives a static list of node names, so dynamic
  `addNode()` requires scheduler changes.
- Existing controller images are simulator-specific wrappers; node lifecycle
  should use such a wrapper for now, but the core logic inside should mirror
  upstream `pkg/controller/nodelifecycle` closely.
