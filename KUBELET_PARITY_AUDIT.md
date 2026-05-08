# Kubernetes Modeling Audit

This report tracks remaining parity gaps for code that is explicitly marked as
modeling Kubernetes kubelet/prober/status source. It has been pruned after the
directory refactor that moved kubelet code under `src/cluster/kubelet/` and
split low-level probes under `src/cluster/probe/`.

The goal is not literal Kubernetes completeness. Init containers, ephemeral
containers, static/mirror pods, volumes, CSI, metrics, events, and detailed
logging remain intentional simulator omissions unless a later task expands
scope. The active items below are places where the simulator can be made more
structurally comparable without taking on those omitted systems.

## Active Todo Checklist

- [ ] `src/cluster/kubelet/status/status-manager.ts`: make `updateStatusInternal`
      closer to Kubernetes' cache/update flow, especially API persistence,
      finished-pod deletion, and equality checks.
- [ ] `src/cluster/kubelet/status/status-manager.ts`: tighten
      `checkContainerStateTransition` around restart-rule feature defaults and
      all-containers-restart behavior.
- [ ] `src/cluster/kubelet/status/status-manager.ts`: make `normalizeStatus`
      truncation and status ordering closer to Kubernetes where practical.
- [ ] `src/cluster/kubelet/pod-workers.ts`: decide whether to model the
      terminal-pod first-sync runtime-cache block in `UpdatePod`.
- [ ] `src/cluster/kubelet/pod-workers.ts`: decide whether to model
      runtime-only pod updates / observed runtime state.
- [ ] `src/cluster/kubelet/pod-workers.ts`: make termination cancellation and
      grace-period shortening structurally closer to Kubernetes.
- [ ] `src/cluster/kubelet/prober/worker.ts`: make `run` own the full probe
      loop shape, including startup jitter and manual-trigger timer reset.
- [ ] `src/cluster/kubelet/prober/worker.ts`: make `doProbe` match Kubernetes'
      non-running container restart logic and kubelet-restart seeding behavior.
- [ ] `src/cluster/kubelet/prober/manager.ts`: make `isContainerStarted`
      preserve Kubernetes' startup-result semantics when a startup result exists
      but is not success.
- [ ] `src/cluster/kubelet/prober/prober.ts`: decide whether to model gRPC probe
      handling or explicitly mark it unsupported.
- [ ] `src/cluster/kubelet/kubelet.ts`: sort pod additions by creation timestamp
      like Kubernetes' `HandlePodAdditions`.
- [ ] `src/cluster/kubelet/kubelet.ts`: make terminating-pod status generation
      and runtime cleanup sequence closer to `SyncTerminatingPod` /
      `SyncTerminatedPod`.
- [ ] `src/cluster/kubelet/kubelet.ts`: move grace-period waiting semantics
      closer to the runtime kill path instead of sleeping in kubelet code.
- [ ] `src/cluster/kubelet/kubelet.ts`: make `generateAPIPodStatus` /
      `convertStatusToAPIStatus` closer to Kubernetes' phase and condition
      generation.

## Findings

### `src/cluster/kubelet/status/status-manager.ts`

#### `StatusManager` / `manager`

Reference: `kubernetes/pkg/kubelet/status/status_manager.go manager`.

Current state is close enough structurally for the simulator's single-process
model. The major omitted pieces are locks, status channels, versioned status
metadata, mirror pods, and API-server batching. Those are intentional unless the
simulator grows concurrent status processing.

No active standalone task remains here beyond the method-level findings below.

#### `setPodStatus` / `SetPodStatus`

Reference: `kubernetes/pkg/kubelet/status/status_manager.go SetPodStatus`.

This is mostly acceptable for the simulator, but it still collapses several Go
steps into a smaller flow:

- Kubernetes generates a status with observed generation helpers and queues a
  notification through `updateStatusInternal`.
- The simulator sets `status.observedGeneration` directly and immediately calls
  `updateStatusInternal`.

This is probably fine unless observed-generation edge cases become test-visible.
No active todo is currently needed.

#### `getPodStatus` / `GetPodStatus`

Reference: `kubernetes/pkg/kubelet/status/status_manager.go GetPodStatus`.

Functionally close for current scope. The simulator returns a copied status plus
boolean, which maps well to Go's `(status, ok)` shape.

#### `setContainerReadiness` / `SetContainerReadiness`

Reference: `kubernetes/pkg/kubelet/status/status_manager.go SetContainerReadiness`.

This now mirrors the important Go flow: find pod, find cached status, find
container, skip unchanged values, deep-copy status, mutate readiness, update
`Ready` and `ContainersReady`, then call `updateStatusInternal`.

No active parity item remains here.

#### `setContainerStartup` / `SetContainerStartup`

Reference: `kubernetes/pkg/kubelet/status/status_manager.go SetContainerStartup`.

This now mirrors the important Go flow for current scope: find pod/status,
skip missing or unchanged containers, deep-copy, mutate `started`, and call
`updateStatusInternal`.

No active parity item remains here.

#### `terminatePod` / `TerminatePod`

Reference: `kubernetes/pkg/kubelet/status/status_manager.go TerminatePod`.

The simulator models the core behavior: convert unknown non-terminated
containers to `ContainerStatusUnknown`, preserve existing terminal phases, and
force pending/running/unknown phases to `Failed`.

Intentional differences:

- Init container handling is omitted by repository scope.
- Kubernetes preserves more condition/status details and participates in the
  wider pod worker termination lifecycle.

No active standalone task remains here; the remaining termination gaps are
tracked under kubelet status generation and cleanup sequencing.

#### `updateStatusInternal` / `updateStatusInternal`

Reference: `kubernetes/pkg/kubelet/status/status_manager.go updateStatusInternal`.

Remaining differences:

- Kubernetes updates an internal versioned status cache and queues API updates;
  the simulator writes to `PodStore` immediately.
- Kubernetes returns a notification object; the simulator returns only a boolean.
- Kubernetes keeps deletion/finalization behavior outside the simple cache
  update path; the simulator may delete the pod directly after updating status.
- Equality uses Kubernetes-specific status comparison; the simulator uses
  `JSON.stringify`.
- Kubernetes handles mirror pods, static pod details, extensive logging,
  termination metrics, and channel notification. These are intentionally omitted.

This is still relevant because probe-driven readiness/startup updates flow
through this method, and store conflicts or pod deletion timing are user-visible.

#### `checkContainerStateTransition` / `checkContainerStateTransition`

Reference: `kubernetes/pkg/kubelet/status/status_manager.go checkContainerStateTransition`.

Remaining differences:

- Kubernetes has a top-level allowance when
  `RestartAllContainersOnContainerExits` is enabled and all containers can
  restart. The simulator only checks per-container restart policy/rules.
- Kubernetes checks init containers separately. That is an intentional omission
  under the repository's current init-container scope rule.
- Kubernetes uses typed pod spec inputs; the simulator passes the whole pod.

The restart-rule path matters because the corresponding Kubernetes feature gate
defaults are enabled in current Kubernetes versions.

#### `containerShouldRestart` / `ContainerShouldRestart`

Reference: `kubernetes/pkg/api/v1/pod/util.go ContainerShouldRestart`.

Structurally close for regular containers. The simulator handles container
restart policy, restart rules, and pod restart policy. No active item remains
except where callers still do not use the helper in all the same places as
Kubernetes.

#### `findMatchingContainerRestartRule` / `FindMatchingContainerRestartRule`

Reference: `kubernetes/pkg/api/v1/pod/util.go FindMatchingContainerRestartRule`.

Structurally close for the supported `In` and `NotIn` operators. No active item.

#### `updateLastTransitionTime` / `updateLastTransitionTime`

Reference: `kubernetes/pkg/kubelet/status/status_manager.go updateLastTransitionTime`.

Structurally close. Minor difference: if the old condition has the same status
but no `lastTransitionTime`, the simulator can preserve `undefined`; Kubernetes'
typed `metav1.Time` path always assigns a time value. Low practical risk unless
tests assert exact timestamp presence.

No active item for now.

#### `normalizeStatus` / `normalizeStatus`

Reference: `kubernetes/pkg/kubelet/status/status_manager.go normalizeStatus`.

Remaining differences:

- Kubernetes truncates termination messages by byte length; the simulator uses
  JavaScript string length.
- Kubernetes has specialized init-container ordering; the simulator sorts by
  name and init containers are currently out of scope.
- Kubernetes normalizes typed `metav1.Time`; the simulator clones `Date`
  instances through ISO strings.

This is lower priority but still relevant for parity tests around long
termination messages or status ordering.

### `src/cluster/kubelet/status/generate.ts`

#### `generatePodReadyCondition` / `GeneratePodReadyCondition`

Reference: `kubernetes/pkg/kubelet/status/generate.go GeneratePodReadyCondition`.

Now structurally close: it delegates to `generateContainersReadyCondition`,
copies non-true status/reason/message, evaluates readiness gates, and sets
`ReadinessGatesNotReady` when needed.

No active item remains.

#### `generateContainersReadyCondition` / `GenerateContainersReadyCondition`

Reference: `kubernetes/pkg/kubelet/status/generate.go GenerateContainersReadyCondition`.

Structurally close for regular containers. Intentional omissions are init and
ephemeral containers. No active item remains.

#### `calculatePodConditionObservedGeneration` / `CalculatePodConditionObservedGeneration`

Reference: `kubernetes/pkg/api/v1/pod/util.go CalculatePodConditionObservedGeneration`.

The simulator intentionally follows the current default feature-gate behavior
and returns pod generation when status exists. No active item remains.

### `src/cluster/kubelet/pod-workers.ts`

#### `PodWorkers` / `podWorkers`

Reference: `kubernetes/pkg/kubelet/pod_workers.go podWorkers`.

Remaining differences are structural:

- Kubernetes has per-UID channels, lock-protected sync state, active and pending
  updates, termination state, runtime-observed state, static pod ordering, and
  cancellation.
- The simulator keeps a compact async loop per pod key and stores less state.

This may remain acceptable, but the methods below still have concrete parity
gaps.

#### `updatePod` / `UpdatePod`

Reference: `kubernetes/pkg/kubelet/pod_workers.go UpdatePod`.

Remaining differences:

- The terminal-pod first-sync block that consults runtime cache is not modeled.
  This may be safe if the simulator can never restart with runtime pods already
  present, but the audit should keep it visible until that invariant is
  documented or tested.
- Runtime-only pod updates are not represented. If the simulator CRI can ever
  contain pods not present in the API server, this becomes a real correctness
  gap.
- Kubernetes records `observedRuntime`, `restartRequested`, `evicted`,
  `gracePeriod`, and cancellation state. The simulator models only a subset.
- Kubernetes shortens grace periods and cancels active syncs. The simulator has
  grace-period support but not the same cancellation shape.

This is still one of the larger remaining structural mismatches.

#### `calculateEffectiveGracePeriod` / `calculateEffectiveGracePeriod`

Reference: `kubernetes/pkg/kubelet/pod_workers.go calculateEffectiveGracePeriod`.

The simulator now has a comparable helper, but it is still tied to a simplified
`KillPodOptions` surface. Recheck once `updatePod` cancellation and shortening
behavior is made closer to Go.

### `src/cluster/kubelet/prober/worker.ts`

#### `run` / `run`

Reference: `kubernetes/pkg/kubelet/prober/worker.go run`.

Remaining differences:

- Kubernetes' `run` owns the ticker loop directly and selects between stop,
  periodic tick, and manual trigger.
- The simulator delegates scheduling to `Ticker`, which is reasonable for the
  browser-friendly clock model, but the shape is not directly comparable.
- Kubernetes delays initial probing with random startup jitter if kubelet
  restarted recently. The simulator currently performs an immediate manual tick.

The browser clock abstraction is intentional, but startup jitter/manual-trigger
semantics should be checked against probe parity tests.

#### `doProbe` / `doProbe`

Reference: `kubernetes/pkg/kubelet/prober/worker.go doProbe`.

Remaining differences:

- Kubernetes handles the `ChangeContainerStatusOnKubeletRestart` false path by
  avoiding initial failure seeding for containers that predate kubelet restart.
  The simulator still appears to seed initial values more directly.
- Kubernetes has detailed restart decisions for non-running containers,
  including container restart rules and all-containers-restarting. The simulator
  has a simpler restart-policy check.
- Kubernetes falls back to init container status lookup. That is intentionally
  omitted.
- Kubernetes records metrics and detailed logs. These are intentionally omitted.

This remains relevant because it can affect readiness/liveness/startup behavior
after restarts and after containers exit.

### `src/cluster/kubelet/prober/manager.ts`

#### `addPod` / `AddPod`

Reference: `kubernetes/pkg/kubelet/prober/prober_manager.go AddPod`.

Now structurally close for regular containers: it creates workers for configured
readiness, liveness, and startup probes. Intentional omission: restartable init
containers.

No active item remains.

#### `removePod` / `RemovePod`

Reference: `kubernetes/pkg/kubelet/prober/prober_manager.go RemovePod`.

Now structurally close for regular containers: it iterates the pod spec and
stops workers for readiness, liveness, and startup probes. Intentional omission:
restartable init containers.

No active item remains.

#### `stopLivenessAndStartup` / `StopLivenessAndStartup`

Reference: `kubernetes/pkg/kubelet/prober/prober_manager.go StopLivenessAndStartup`.

Now structurally close for regular containers: it iterates pod containers and
stops liveness/startup workers only. No active item remains.

#### `cleanupPods` / `CleanupPods`

Reference: `kubernetes/pkg/kubelet/prober/prober_manager.go CleanupPods`.

Now present and structurally close. No active item remains unless desired-pod
set maintenance becomes test-visible.

#### `updatePodStatus` / `UpdatePodStatus`

Reference: `kubernetes/pkg/kubelet/prober/prober_manager.go UpdatePodStatus`.

Now closer after moving to full `ContainerID` keys and adding kubelet-restart
ready-state handling. The remaining known behavior gap is delegated to
`isContainerStarted`.

#### `isContainerStarted` / `isContainerStarted`

Reference: `kubernetes/pkg/kubelet/prober/prober_manager.go isContainerStarted`.

Remaining difference:

- Kubernetes returns false when a startup result exists and is not success.
  The simulator should preserve that exact shape rather than treating only
  worker presence as the false case.

This matters for readiness during startup probe failure/unknown states.

#### `setReadyStateOnKubeletRestart` / `setReadyStateOnKubeletRestart`

Reference:
`kubernetes/pkg/kubelet/prober/prober_manager.go setReadyStateOnKubeletRestart`.

This is now modeled in the manager. No active item remains unless restart-time
tests expose a behavioral mismatch.

### `src/cluster/kubelet/prober/results/results-manager.ts`

#### `ProberResult` / `Result`

Reference:
`kubernetes/pkg/kubelet/prober/results/results_manager.go Result`.

Now modeled as the probe-manager cache result type, with `success`, `failure`,
and `unknown`. No active item remains.

#### `ResultsManager` / `manager`

Reference:
`kubernetes/pkg/kubelet/prober/results/results_manager.go manager`.

Structurally close for the simulator: cache keyed by `ContainerID`, update
emission only on change, and removal support. EventEmitter replaces Go's single
updates channel, which is an acceptable JavaScript implementation difference.

No active item remains.

### `src/cluster/kubelet/prober/prober.ts`

#### `probe` / `probe`

Reference: `kubernetes/pkg/kubelet/prober/prober.go probe`.

Now closer after aligning arguments around probe type, pod, pod status,
container, and container ID. Remaining differences:

- Kubernetes supports exec, HTTP, TCP, and gRPC probe handlers. The simulator
  currently has exec, HTTP, and TCP only.
- Kubernetes records events/logging for warning/unknown/default cases. The
  simulator maps unsupported probe results to failure without the logging/event
  side effects.

The gRPC omission should either be modeled or explicitly recorded as unsupported.

#### `runProbeWithRetries` / `runProbeWithRetries`

Reference: `kubernetes/pkg/kubelet/prober/prober.go runProbeWithRetries`.

Structurally close: it retries probe execution up to the Kubernetes retry count.
No active item remains unless exact warning/error return semantics become
test-visible.

#### `runProbe` / `runProbe`

Reference: `kubernetes/pkg/kubelet/prober/prober.go runProbe`.

Mostly close for supported handlers. The same gRPC/default-handler gap from
`probe` applies here.

### `src/cluster/probe/`

#### `src/cluster/probe/probe.ts` / `kubernetes/pkg/probe/probe.go`

Reference: `kubernetes/pkg/probe/probe.go Result`.

The low-level probe result type now mirrors Kubernetes' separate probe package
result vocabulary, including `warning`. No active item remains.

#### `src/cluster/probe/exec/exec.ts` / `kubernetes/pkg/probe/exec/exec.go`

Reference: `kubernetes/pkg/probe/exec/exec.go Probe`.

Structurally close for simulator exec support. Environment/downward-API behavior
remains governed by the kubelet prober call site.

#### `src/cluster/probe/http/http.ts` / `kubernetes/pkg/probe/http/http.go`

Reference: `kubernetes/pkg/probe/http/http.go Probe`.

Structurally close for basic HTTP GET probing. Further parity may be needed if
tests cover redirect behavior, HTTPS/TLS behavior, host header handling, or
exact error classification.

#### `src/cluster/probe/tcp/tcp.ts` / `kubernetes/pkg/probe/tcp/tcp.go`

Reference: `kubernetes/pkg/probe/tcp/tcp.go Probe`.

Structurally close for simulator networking. No active item remains.

### `src/cluster/kubelet/container/container-id.ts`

#### `buildContainerID` / `BuildContainerID`

Reference: `kubernetes/pkg/kubelet/container/runtime.go BuildContainerID`.

Now structurally aligned enough for cache keys and status fields. No active
item remains.

#### `parseContainerID` / `ParseContainerID`

Reference: `kubernetes/pkg/kubelet/container/runtime.go ParseContainerID`.

Now structurally aligned enough for using the full parsed `ContainerID` as the
probe-results cache key. No active item remains.

### `src/cluster/kubelet/kubelet.ts`

#### `handleProbeSync` / `handleProbeSync`

Reference: `kubernetes/pkg/kubelet/kubelet.go handleProbeSync`.

Structurally close for simulator scope: probe updates result in pod sync
dispatch. Kubernetes has richer logging and sync handler plumbing.

No active item remains.

#### `handlePodAdditions` / `HandlePodAdditions`

Reference: `kubernetes/pkg/kubelet/kubelet.go HandlePodAdditions`.

Remaining difference:

- Kubernetes sorts pod additions by creation timestamp before dispatch. The
  simulator currently dispatches directly.

This can affect deterministic behavior when multiple pods are added together.

#### `handlePodUpdates` / `HandlePodUpdates`

Reference: `kubernetes/pkg/kubelet/kubelet.go HandlePodUpdates`.

Close enough for current scope: updated pods are dispatched to pod workers.
Kubernetes also manages mirror pod lookups and source-specific update types.

No active item remains.

#### `handlePodSyncs` / `HandlePodSyncs`

Reference: `kubernetes/pkg/kubelet/kubelet.go HandlePodSyncs`.

Close enough for current scope: sync requests are dispatched to pod workers.
Kubernetes also resolves mirror pods and passes context/start time through the
full pod worker interface.

No active item remains beyond pod-worker implementation gaps.

#### `syncTerminatingPod` / `SyncTerminatingPod`

Reference: `kubernetes/pkg/kubelet/kubelet.go SyncTerminatingPod`.

Remaining differences:

- Kubernetes computes and sets API pod status before killing the pod, then
  again after containers have stopped. The simulator does this now, but status
  generation is still simplified.
- Kubernetes gets stopped runtime status through container runtime APIs and
  validates there are no running containers. The simulator has moved closer but
  should continue matching this sequence.
- Kubernetes does not delete the API pod here; deletion/cleanup happens through
  later status manager and pod worker lifecycle paths.
- Kubernetes has dynamic resource cleanup between container stop and final
  status update. That is intentionally omitted.

This remains active because status/deletion order is visible in graceful
deletion tests.

#### `syncTerminatedPod` / `SyncTerminatedPod`

Reference: `kubernetes/pkg/kubelet/kubelet.go SyncTerminatedPod`.

Remaining differences:

- Kubernetes performs final status manager updates and cleanup after
  `SyncTerminatingPod`.
- The simulator performs a simplified cleanup path and relies on the status
  manager to delete finished pods.

This should be rechecked together with graceful deletion behavior.

#### `killPod` / `killPod`

Reference: `kubernetes/pkg/kubelet/kubelet.go killPod`.

Remaining difference:

- Kubernetes passes grace-period information into the runtime kill path. The
  simulator still has kubelet-level waiting semantics in places, which does not
  match where Kubernetes spends the grace period.

This is relevant to deletion timing and probe shutdown behavior.

#### `preserveDataFromBeforeStopping` / `preserveDataFromBeforeStopping`

Reference:
`kubernetes/pkg/kubelet/kubelet.go preserveDataFromBeforeStopping`.

Structurally close for regular containers. Intentional omissions are init and
ephemeral container statuses.

No active item remains.

#### `generateAPIPodStatus` / `generateAPIPodStatus`

Reference: `kubernetes/pkg/kubelet/kubelet_pods.go generateAPIPodStatus`.

Remaining differences:

- Kubernetes computes phase through `getPhase` with restart policy,
  initialization, container states, and terminal-pod inputs.
- The simulator's phase logic is still coarse.
- Kubernetes preserves and regenerates a broader set of pod conditions.
- Terminal status generation can currently be too eager to force `Failed`.

This is a high-value next parity target because it affects many observable pod
status tests.

#### `convertStatusToAPIStatus` / `convertStatusToAPIStatus`

Reference: `kubernetes/pkg/kubelet/kubelet_pods.go convertStatusToAPIStatus`.

Remaining differences:

- Kubernetes converts the runtime status shape into full API status and then
  derives phase/conditions through helper functions.
- The simulator converts only the subset it models and uses simplified phase
  derivation.

This should be addressed with `generateAPIPodStatus`, not independently.

## Removed From Active Audit

These items were in the previous report but are now either completed or covered
by the current sections above:

- Status manager references now live under
  `src/cluster/kubelet/status/status-manager.ts`.
- Status condition generation references now live under
  `src/cluster/kubelet/status/generate.ts`.
- Pod worker references now live under `src/cluster/kubelet/pod-workers.ts`.
- Kubelet prober references now live under `src/cluster/kubelet/prober/`.
- Probe results now live under
  `src/cluster/kubelet/prober/results/results-manager.ts`.
- Low-level probe implementations now live under `src/cluster/probe/`.
- Container ID parsing/building now lives under
  `src/cluster/kubelet/container/container-id.ts`.
- Completed active findings for `setContainerReadiness`,
  `setContainerStartup`, readiness gate condition generation, full `ContainerID`
  probe result keys, `addPod`, `removePod`, `stopLivenessAndStartup`,
  `cleanupPods`, `setReadyStateOnKubeletRestart`, and the split between
  kubelet-level prober results and low-level probe results.
