# Probing and Kubelet Channel Parity TODO

This note tracks the recent channel migration work in kubelet/prober code and
the remaining gaps against the Kubernetes source. The goal in these areas is to
match Kubernetes as closely as the simulator scope allows, preferably with code
that can be compared side-by-side with the upstream Go implementation.

Upstream references:

- `pkg/kubelet/prober/results/results_manager.go`
- `pkg/kubelet/kubelet.go`
- `pkg/kubelet/config/config.go`
- `pkg/kubelet/pod_workers.go`

## What Now Matches Well

- `src/cluster/kubelet/prober/results/results-manager.ts`
  - Uses a buffered updates channel with capacity `20`, matching Kubernetes'
    `updates: make(chan Update, 20)`.
  - `set()` only sends an update when the cached result changes.
  - `remove()` clears cached state without sending an update.
  - `updates()` exposes the receive side of the channel.

- `src/cluster/kubelet/kubelet.ts`
  - Probe update handling now uses a channel `select()` shape instead of
    EventEmitter subscriptions.
  - Liveness only triggers pod sync on failure.
  - Readiness updates container readiness, then syncs the pod.
  - Startup updates container startup, then syncs the pod.
  - `handleProbeSync()` fetches the latest pod instead of using the stale pod
    known to the prober manager.

- `src/cluster/kubelet/pod-workers.ts`
  - Per-pod worker notifications already use one buffered channel per pod UID,
    capacity `1`, matching Kubernetes' `podUpdates map[types.UID]chan struct{}`.
  - Kill completion now uses `completedCh` instead of a callback, closer to
    Kubernetes' `KillPodOptions.CompletedCh chan<- struct{}`.
  - Completion channels are stored in `notifyPostTerminating` and closed when
    `completeTerminating()` runs.
  - Already-terminated and non-terminating paths close the completion channel
    immediately, matching the upstream control flow.

## Remaining Parity Work

- Expand local `PodUpdate` in `src/cluster/kubelet/kubelet.ts`.
  - The simulator currently has only `{ op, pods }`.
  - Kubernetes `kubetypes.PodUpdate` carries source information and supports
    `ADD`, `UPDATE`, `DELETE`, `REMOVE`, `RECONCILE`, plus source normalization
    through `PodConfig`.

- Revisit DELETE handling in `src/cluster/kubelet/kubelet.ts`.
  - Kubernetes treats `DELETE` as an update because graceful deletion is encoded
    in pod state.
  - `REMOVE` is the more direct cleanup/removal path.
  - The simulator currently routes delete events to immediate local cleanup via
    `deletePodStatus()`.

- Split local kubelet sync loop shape to better mirror Kubernetes.
  - Kubernetes has an outer `syncLoop()` that repeatedly calls
    `syncLoopIteration(...) bool`.
  - The simulator currently has `syncLoopIteration()` as the full async loop.
  - Splitting this would make side-by-side comparison easier.

- Add or explicitly scope out the missing Kubernetes `syncLoopIteration` cases.
  - Periodic sync ticker.
  - Housekeeping ticker.
  - PLEG updates.
  - Container-manager updates.
  - Any implemented timers should route through the cluster `Clock`.

- Decide whether `ResultsManager.set()` should apply backpressure.
  - Kubernetes blocks on `m.updates <- Update` when the buffered channel is full.
  - The simulator currently starts `updatesCh.send(...)` and returns because
    `set()` is synchronous.
  - This preserves delivery intent but does not block the caller.

- Add `statusPostTerminating` behavior to `src/cluster/kubelet/pod-workers.ts`.
  - Kubernetes stores `PodStatusFunc` values during termination and clears them
    after `completeTerminating()`.
  - The simulator only carries `podStatusFunc` through the active update.

- Copy `activeUpdate` in `requeueLastPodUpdate()`.
  - Kubernetes copies the active update before assigning it to pending update.
  - The simulator currently reuses the same object reference.
  - Copying would reduce aliasing risk and match the upstream implementation
    more closely.

- Implement a Clock-backed worker queue for pod worker retries/resync.
  - Kubernetes `completeWork()` requeues via `workQueue` with immediate retry,
    normal resync interval, or backoff.
  - The simulator currently only wakes the worker when a pending update already
    exists.
