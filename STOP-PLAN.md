# Stop Signal Plan

## Goal

`Cluster.close()` must stop all ongoing simulator activity without using
Kubernetes-internal data channels as lifecycle controls. The shutdown path
should follow Kubernetes' own patterns where those patterns exist:

- long-running components receive a `context.Context`;
- cancellation is observed through the context's `Done` channel being closed;
- per-worker stop channels are used where Kubernetes has per-worker stop
  channels;
- internal result/update channels stay open unless Kubernetes itself closes
  them.

We now have a cancel-only context primitive in `src/go/context.ts`. This plan
uses that as the simulator equivalent of Go `context.WithCancel`.

## Kubernetes Reference Points

The relevant upstream patterns are:

- `context.Context` cancellation closes `Done`; callers do not send a value on
  it. `Err()` reports `context.Canceled` after cancellation.
  - Reference: Go 1.26 `src/context/context.go`, especially the `Context`
    contract and `cancelCtx.cancel`.
- EndpointSlice and Endpoints controllers expose `Run(ctx context.Context, ...)`
  and block on `<-ctx.Done()` before returning. They shut down their workqueues
  in deferred cleanup.
  - References: `kubernetes/kubernetes@v1.36.0`
    `pkg/controller/endpoint/endpoints_controller.go`,
    `pkg/controller/endpointslice/endpointslice_controller.go`, and
    `pkg/controller/endpointslicemirroring/endpointslicemirroring_controller.go`.
- Kubelet exposes `Run(ctx context.Context, updates <-chan PodUpdate)` and
  threads that `ctx` through sync handlers, pod workers, and subsystem starts.
  - References: `kubernetes/kubernetes@v1.36.0`
    `pkg/kubelet/kubelet.go` and `pkg/kubelet/pod_workers.go`.
- Kubelet prober workers have their own buffered `stopCh`; `worker.stop()` is a
  non-blocking send, and `worker.run(ctx)` stops when that channel is selected.
  - Reference: `kubernetes/kubernetes@v1.36.0`
    `pkg/kubelet/prober/worker.go`.
- Kubelet prober results managers do not have `Close`, `closed`, or a stop
  channel. Their `Set` method mutates the cache and then sends on the updates
  channel, blocking if the buffered channel is full.
  - Reference: `kubernetes/kubernetes@v1.36.0`
    `pkg/kubelet/prober/results/results_manager.go`.
- Kubelet status manager is not a good model for closing result channels. It has
  a `Start(ctx context.Context)` API, but its internal status cache is not used
  as a shutdown signal for the kubelet sync loop.
  - Reference: `kubernetes/kubernetes@v1.36.0`
    `pkg/kubelet/status/status_manager.go`.

## Design Principles

1. Use context cancellation for component lifetime.

   `Cluster` should own a root context:

   ```ts
   const [ctx, cancel] = withCancel(background());
   ```

   `Cluster.close()` should call `cancel()`. Children derive their contexts from
   that root.

2. Keep Kubernetes-like data channels Kubernetes-like.

   Do not close `ResultsManager.updates()` to make kubelet stop. Kubernetes'
   prober results manager never closes that channel. Kubelet exits because its
   owning lifecycle is canceled or its config source ends, not because probe
   result channels close.

3. Preserve dedicated worker stop channels where Kubernetes has them.

   Probe workers should keep their own `stopCh`. `ProbeManager.close()` should
   call `worker.stop()` for each worker, matching `worker.stop()` in
   `pkg/kubelet/prober/worker.go`.

4. Distinguish simulator cleanup from Kubernetes objects.

   A `close()` method on `Cluster`, `Server`, or the browser simulator runtime
   is fine. A `close()` method on a Kubernetes-shaped helper such as
   `ResultsManager` is suspect unless upstream has the equivalent.

5. Keep cancellation synchronous.

   Calling a cancel function should make `ctx.done()` immediately ready and
   should synchronously cancel children, matching Go's `WithCancel` behavior.

6. Make simulator shutdown awaitable.

   `close()` methods that need loop/process cleanup should return
   `Promise<void>`. Callers that do not await still initiate shutdown, but tests
   and harnesses should `await cluster.close()` so they can verify that loops,
   workers, processes, and timers have actually stopped. Cancellation itself
   should happen synchronously before the first awaited cleanup step.

## Current Simulator Gaps

The current code still uses several data-channel closures as lifecycle signals:

- `Kubelet.close()` closes `podUpdates`, which is how `syncLoopIteration`
  currently exits.
- `ProbeManager.close()` closes all three `ResultsManager` instances, and
  `ResultsManager.close()` closes the probe update channel.
- `PodWorkers.close()` closes every per-pod update channel for cluster-wide
  shutdown.
- `ProbeManager.close()` clears its worker map directly, instead of letting
  workers remove themselves in `finally`.

Those are the behaviors this plan removes or narrows.

## Component Plan

### Cluster

- Add a private root context and cancel function.
- `Cluster.init()` should pass the root context into servers and control-plane
  components.
- `Cluster.close()` should become awaitable and idempotent:
  - expose it as `close(): Promise<void>`;
  - cache and return the same shutdown promise for repeated calls;
  - call the root cancel function synchronously before awaiting server cleanup;
  - update the simulator harness to `await cluster.close()` in `afterAll`.
- `Cluster.close()` should:
  - cancel the root context;
  - ask each server to close and await completion;
  - close etcd;
  - clear the simulator clock as the final last-resort timer cleanup.

`clock.clear()` should remain a final safety net, not the primary lifecycle
mechanism.

Add a small clock inspection hook, such as `clock.pendingTaskCount()` or an
equivalent test-only helper, before writing the final shutdown assertion. Do not
make tests infer timer cleanup by reaching into private fields.

Upstream reference: Kubernetes does not have a single in-process `Cluster`
object, but long-running components are rooted in `Run(ctx)` APIs, for example
`Kubelet.Run(ctx, updates)` in
`kubernetes/kubernetes@v1.36.0 pkg/kubelet/kubelet.go` and
`Scheduler.Run(ctx)` in `pkg/scheduler/scheduler.go`.

### Server

- Add `boot(ctx: Context)` or store a server context derived from the cluster
  context.
- Add `close(): Promise<void>` that cancels the server context and delegates to
  kubelet/runtime cleanup.
- Keep `Runtime` process shutdown explicit; context cancellation alone should
  not silently leave simulated containers running.
- Add a runtime cleanup method if needed, for example
  `Runtime.close(): Promise<void>`, that removes every remaining pod sandbox and
  therefore kills all container processes and closes process-owned network
  listeners.

Upstream references: kubelet's pods API server accepts a `context.Context` and
gracefully stops on `<-ctx.Done()` in
`kubernetes/kubernetes@v1.36.0 pkg/kubelet/server/server.go`; runtime pod
shutdown remains explicit through kubelet runtime calls such as `KillPod` and
`StopPodSandbox` in `pkg/kubelet/kuberuntime/kuberuntime_manager.go`.

### Kubelet

- Change `start()`/`syncLoop()`/`syncLoopIteration()` to accept a `Context`.
  Track the running sync loop with a promise so `close()` can await it.
- The kubelet sync loop should select on:
  - pod updates;
  - liveness results;
  - readiness results;
  - startup results;
  - `ctx.done()`.
- On `ctx.done()`, return from the loop.
- Do not rely on closing `podUpdates` or probe result update channels as the
  primary sync-loop exit path.
- Keep a small local guard for idempotent simulator `close()` so callers do not
  enqueue new pod updates after cancellation.
- `Kubelet.close()` should be awaitable and should not close `podUpdates` or any
  probe result update channel. It should stop enqueueing new work, stop prober
  workers, cancel/stop pod workers, cancel the watcher, remove runtime
  sandboxes, clear local runtime bookkeeping, and await the sync-loop promise.
  If `Kubelet.close()` can be called outside `Server.close()`, it should also
  cancel the kubelet's own derived context.
- Pass the context into methods that correspond to upstream `ctx` parameters:
  `handlePodUpdate`, `handleProbeSync`, `syncPod`, terminating pod paths, and
  pod worker dispatch.
- Make shutdown cleanup direct and non-graceful: use runtime sandbox removal for
  remaining pods instead of waiting pod termination grace periods during cluster
  close.
- Any `clock.wait(...)` used in normal kubelet work, especially termination
  grace-period waits, should become context-aware so cancellation does not leave
  a pending timer as the only way for shutdown to progress.

Note: upstream kubelet's `syncLoopIteration` exits when the config channel is
closed, and it passes `ctx` through most work. In this simulator, adding an
explicit `ctx.done()` select case is the practical equivalent of the owning
process canceling kubelet activity while avoiding closure of internal probe
channels.

Upstream references: `Kubelet.Run(ctx, updates)`, `syncLoop(ctx, ...)`,
`syncLoopIteration(ctx, ...)`, `SyncHandler`, `handleProbeSync`, and the pod
handler methods are in `kubernetes/kubernetes@v1.36.0 pkg/kubelet/kubelet.go`.
The pod-worker sync callback types also take `context.Context` in
`pkg/kubelet/pod_workers.go`.

### ProbeManager

- Keep `close()` as simulator-owned lifecycle, but make it only stop workers.
- Remove `ResultsManager.close()` calls from `ProbeManager.close()`.
- Remove `ResultsManager.close()` entirely.
- Do not clear the worker map in `ProbeManager.close()`. Workers should remove
  themselves from the manager in their own `finally` path.
- Keep worker removal in the worker's `finally`, mirroring upstream
  `defer m.removeWorker(...)`.
- Change `addPod(pod)` to `addPod(ctx, pod)` so it mirrors upstream
  `AddPod(ctx context.Context, pod *v1.Pod)` and can pass the kubelet context to
  `worker.run(ctx)`.
- If tests need to assert worker cleanup, expose a narrow test helper such as
  `workerCount()` rather than inspecting private maps.

Upstream references: `AddPod(ctx, pod)` creates workers with `go w.run(ctx)`,
`RemovePod`/`CleanupPods` stop workers, and workers remove themselves through
`removeWorker` in
`kubernetes/kubernetes@v1.36.0 pkg/kubelet/prober/prober_manager.go`.

### ProbeWorker

- Keep `stopCh` and non-blocking `stop()`.
- Change `run()` to accept `Context` when the kubelet context is threaded in.
- The main select should include:
  - `stopCh`;
  - local ticker;
  - manual trigger;
  - `ctx.done()`.
- Cleanup remains in `finally`, matching upstream `defer`: stop local ticker,
  remove cached result, remove worker from manager.
- Store each worker's run promise in the manager, so `ProbeManager.close()` can
  stop workers and await normal worker cleanup.
- The initial randomized delay should be driven by the cluster `Clock` and
  should also be cancelable by `ctx.done()`/`stopCh`; otherwise shutdown can
  leave a probe worker waiting on a timer before it reaches the main loop.
- Keep `ResultsManager.set` backpressure. Do not add a `ResultsManager` close
  path to unblock sends. Shutdown tests that assert worker removal should avoid
  constructing the artificial case where a worker is deliberately blocked on a
  full result update channel after the kubelet loop has stopped.

Upstream currently uses `stopCh` for worker termination and passes `ctx` mainly
for logging/probe calls. Including `ctx.done()` in the simulator worker loop is
acceptable once the worker is spawned under a cancelable kubelet context,
because cluster shutdown must stop all outstanding activity.

Upstream reference: `kubernetes/kubernetes@v1.36.0`
`pkg/kubelet/prober/worker.go` creates buffered `stopCh` and
`manualTriggerCh`, implements non-blocking `stop()`, runs with
`run(ctx context.Context)`, stops the local ticker, removes cached results, and
removes the worker from the manager in deferred cleanup.

### ResultsManager

- Remove `closed` and `close()`.
- Keep `set`/`setInternal`.
- Keep `set` async and await `updatesCh.send(...)` so a full buffered channel
  applies Go-like backpressure.
- Leave `updates()` open for the lifetime of the manager, as upstream does.
- On kubelet shutdown, stop the kubelet loop instead of closing result channels.
- Keep `setInternal` independent of shutdown state. It should only compare and
  mutate cached result values.

Upstream reference: `kubernetes/kubernetes@v1.36.0`
`pkg/kubelet/prober/results/results_manager.go` exposes only `Get`, `Set`,
`Remove`, and `Updates`; `NewManager` creates a buffered updates channel, and
`Set` sends to that channel only when `setInternal` reports a changed result.

### PodWorkers

- Thread `Context` through `updatePod`, `podWorkerLoop`, and sync callbacks.
- Store a per-active-sync cancel function in each pod sync status, matching
  upstream's `status.cancelFn`, and call it when termination starts or a grace
  period is shortened.
- Prefer context cancellation for worker lifetime, but be careful with current
  per-pod update channels:
  - upstream pod workers range over a per-pod `podUpdates` channel;
  - local `close()` currently closes those channels as simulator cleanup.
- Align method signatures with upstream names and `ctx` parameters as part of
  this plan. Keep per-pod channel closure only for removing a specific pod
  worker, not for cluster-wide shutdown.
- Track pod-worker loop promises, so `PodWorkers.close(ctx)` can cancel workers
  and await loop exit during `Kubelet.close()`.
- Keep per-pod update channel closure for `removePod`/finished pod cleanup,
  where it models removing a specific worker. Do not use it as the cluster-wide
  shutdown mechanism.
- Treat `context.Canceled`-equivalent errors from sync callbacks as expected
  cancellation rather than normal sync failures.

Upstream references: `kubernetes/kubernetes@v1.36.0`
`pkg/kubelet/pod_workers.go` has `UpdatePod(ctx, options)`, derives per-sync
contexts in `startPodSync`, passes context into `SyncPod`,
`SyncTerminatingPod`, `SyncTerminatingRuntimePod`, and `SyncTerminatedPod`, and
currently drives `podWorkerLoop` by ranging over the per-pod update channel.

### StatusManager

- Do not use status-manager cache clearing as a stop signal.
- Model upstream `Start(ctx)` as part of this plan. Add
  `StatusManager.start(ctx): Promise<void>` or an equivalent awaitable loop
  lifecycle, and have `Kubelet.start(ctx)` start it.
- Any status-manager periodic work should be driven by the cluster `Clock` and
  should stop via context cancellation rather than global timers.
- `StatusManager.close()` should remain simulator-owned memory cleanup only; it
  must not be used as a kubelet loop stop signal. `Kubelet.close()` should await
  the status-manager loop after canceling the kubelet context.
- If the implementation keeps status writes synchronous for now, `Start(ctx)`
  may be a minimal lifecycle loop. Do not introduce global timers or status
  cache clearing as part of shutdown.

Upstream reference: `kubernetes/kubernetes@v1.36.0`
`pkg/kubelet/status/status_manager.go` has `Start(ctx context.Context)` and a
private `podStatusChannel`/status cache, but those are not kubelet lifecycle
signals.

### Runtime Processes And Control Plane Images

- `ProcessContext` already implements the local `Context` interface and exposes
  `waitUntilKilled()`. That is the container-process-level cancellation
  mechanism.
- `Scheduler`, `KubeProxy`, `EndpointSliceController`, and `CoreDNS` currently
  run until the simulated process is killed, then stop informers in `finally`.
- Keep that process-level behavior for pods. Cluster shutdown should remove or
  kill pod sandboxes/containers through kubelet/runtime cleanup so these
  processes observe their existing kill signal.
- Ensure runtime cleanup covers every sandbox in `Runtime`, not only kubelet's
  `runningPods` map, so shutdown cannot leave a simulated process alive because
  local kubelet bookkeeping was already cleared.
- If we add controller instances that run outside pods, model them with
  `Run(ctx)` and `<-ctx.done()` like upstream controllers.

Upstream references: scheduler and EndpointSlice/Endpoints controllers use
`Run(ctx)` and stop or shut down internal queues after cancellation in
`kubernetes/kubernetes@v1.36.0 pkg/scheduler/scheduler.go`,
`pkg/controller/endpoint/endpoints_controller.go`,
`pkg/controller/endpointslice/endpointslice_controller.go`, and
`pkg/controller/endpointslicemirroring/endpointslicemirroring_controller.go`.
Kubelet runtime pod termination is explicit through `KillPod` and
`StopPodSandbox` in `pkg/kubelet/kuberuntime/kuberuntime_manager.go`; sandbox
removal is handled by GC in `pkg/kubelet/kuberuntime/kuberuntime_gc.go`.

## Implementation Sequence

1. Make context available to cluster lifecycle.

   Add root context/cancel to `Cluster`, derive server/kubelet contexts, make
   `Cluster.close()` cancel first, make it return a shutdown promise, and update
   the simulator harness to await it.

2. Stop kubelet by context.

   Thread context through `Server.boot`, `Kubelet.start`, `syncLoop`, and
   `syncLoopIteration`. Add a `ctx.done()` select case. Track and await the sync
   loop promise. Keep existing stopped guards only for idempotence and enqueue
   prevention.

3. Remove result-manager lifecycle closure.

   Delete `ResultsManager.close()` and `closed`. Remove calls from
   `ProbeManager.close()`. Verify probe result sends still backpressure.

4. Stop prober workers explicitly.

   Keep `ProbeManager.close()` stopping workers without clearing the worker map.
   Pass kubelet context into `ProbeManager.addPod(ctx, pod)` and
   `ProbeWorker.run(ctx)`. Make the worker's initial delay and main loop
   cancellation-aware. Store and await worker promises during close.

5. Thread context through pod workers.

   Update pod-worker loop signatures and sync callback types to accept context.
   Align method names/signatures with the upstream pod-worker surface as part of
   this work. Add per-sync cancellation, cancellation checks around per-pod
   update waits, cancellation checks before starting new sync work, and await
   pod-worker loop promises during close.

6. Model status-manager start lifecycle.

   Add `StatusManager.start(ctx)` and start it from kubelet. Drive any periodic
   work with the cluster `Clock`, stop on context cancellation, and await loop
   exit from `Kubelet.close()`.

7. Revisit simulator process shutdown.

   Add or use runtime-level cleanup so `Cluster.close()` reliably kills/removes
   all pod sandboxes and container processes, including any sandbox not present
   in kubelet's `runningPods` map. In-pod control-plane components should stop
   through their existing `ProcessContext.waitUntilKilled()` path.

8. Add shutdown observability needed by tests.

   Add narrow helpers or state needed to assert loop exit, probe worker cleanup,
   and pending clock timer count without exposing broad mutable internals.

## Tests To Add Or Update

- Context tests already cover basic cancel-only semantics from Go, including
  multiple pending receives/selects on the same `ctx.done()` channel all
  unblocking after one cancel.
- Add a cluster shutdown test:
  - create a cluster;
  - start pods with probes/control-plane informers active;
  - call `cluster.close()`;
  - assert kubelet sync loops exit without closing probe result channels;
  - assert probe workers stop and remove themselves;
  - assert no clock timers remain after final `clock.clear()`.
- Add a runtime shutdown assertion:
  - after `await cluster.close()`, no runtime sandboxes, containers, or running
    process-owned network listeners remain.
- Add a focused `ResultsManager` test:
  - `set` sends only on changed result;
  - a full updates channel blocks `set` until a receiver consumes;
  - there is no `close()` behavior.
- Add a kubelet loop test:
  - canceling context exits the loop even if pod/probe channels are otherwise
    idle.
- Keep probe parity tests in `src/client/tests/probe.test.ts` running after each
  phase.
- Run at least `pnpm run typecheck` plus the focused node/browser tests touched
  by the phase. Before considering the whole plan done, run `pnpm run
vibe-check`.

## Open Questions

- Should local `Context` grow `deadline`, `value`, or `cause` later? Not needed
  for this shutdown work.
