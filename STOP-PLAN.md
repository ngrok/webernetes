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

We now have a cancel-only context primitive in `src/context.ts`. This plan uses
that as the simulator equivalent of Go `context.WithCancel`.

## Kubernetes Reference Points

The relevant upstream patterns are:

- `context.Context` cancellation closes `Done`; callers do not send a value on
  it. `Err()` reports `context.Canceled` after cancellation.
- EndpointSlice and Endpoints controllers expose `Run(ctx context.Context, ...)`
  and block on `<-ctx.Done()` before returning. They shut down their workqueues
  in deferred cleanup.
- Kubelet exposes `Run(ctx context.Context, updates <-chan PodUpdate)` and
  threads that `ctx` through sync handlers, pod workers, and subsystem starts.
- Kubelet prober workers have their own buffered `stopCh`; `worker.stop()` is a
  non-blocking send, and `worker.run(ctx)` stops when that channel is selected.
- Kubelet prober results managers do not have `Close`, `closed`, or a stop
  channel. Their `Set` method mutates the cache and then sends on the updates
  channel, blocking if the buffered channel is full.
- Kubelet status manager is not a good model for closing result channels. It has
  a `Start(ctx context.Context)` API, but its internal status cache is not used
  as a shutdown signal for the kubelet sync loop.

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

## Component Plan

### Cluster

- Add a private root context and cancel function.
- `Cluster.init()` should pass the root context into servers and control-plane
  components.
- `Cluster.close()` should be idempotent and should:
  - cancel the root context;
  - ask each server to close;
  - stop remaining runtime/network listeners;
  - close etcd;
  - clear the simulator clock as the final last-resort timer cleanup.

`clock.clear()` should remain a final safety net, not the primary lifecycle
mechanism.

### Server

- Add `boot(ctx: Context)` or store a server context derived from the cluster
  context.
- Add `close()` that cancels the server context and delegates to kubelet/runtime
  cleanup.
- Keep `Runtime` process shutdown explicit; context cancellation alone should
  not silently leave simulated containers running.

### Kubelet

- Change `start()`/`syncLoop()`/`syncLoopIteration()` to accept a `Context`.
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
- Pass the context into methods that correspond to upstream `ctx` parameters:
  `handlePodUpdate`, `handleProbeSync`, `syncPod`, terminating pod paths, and
  pod worker dispatch.

Note: upstream kubelet's `syncLoopIteration` exits when the config channel is
closed, and it passes `ctx` through most work. In this simulator, adding an
explicit `ctx.done()` select case is the practical equivalent of the owning
process canceling kubelet activity while avoiding closure of internal probe
channels.

### ProbeManager

- Keep `close()` as simulator-owned lifecycle, but make it only stop workers.
- Remove `ResultsManager.close()` calls from `ProbeManager.close()`.
- Keep worker removal in the worker's `finally`, mirroring upstream
  `defer m.removeWorker(...)`.
- Consider a future `addPod(ctx, pod)` signature if we want to mirror upstream
  `AddPod(ctx context.Context, pod *v1.Pod)` exactly; worker `run(ctx)` can then
  receive the kubelet context while still honoring its own `stopCh`.

### ProbeWorker

- Keep `stopCh` and non-blocking `stop()`.
- Change `run()` to accept `Context` when the kubelet context is threaded in.
- The main select should include:
  - `stopCh`;
  - local ticker;
  - manual trigger;
  - optionally `ctx.done()`.
- Cleanup remains in `finally`, matching upstream `defer`: stop local ticker,
  remove cached result, remove worker from manager.

Upstream currently uses `stopCh` for worker termination and passes `ctx` mainly
for logging/probe calls. Including `ctx.done()` in the simulator worker loop is
acceptable once the worker is spawned under a cancelable kubelet context,
because cluster shutdown must stop all outstanding activity.

### ResultsManager

- Remove `closed` and `close()`.
- Keep `set`/`setInternal`.
- Keep `set` async and await `updatesCh.send(...)` so a full buffered channel
  applies Go-like backpressure.
- Leave `updates()` open for the lifetime of the manager, as upstream does.
- On kubelet shutdown, stop the kubelet loop instead of closing result channels.

### PodWorkers

- Thread `Context` through `updatePod`, `podWorkerLoop`, and sync callbacks.
- Prefer context cancellation for worker lifetime, but be careful with current
  per-pod update channels:
  - upstream pod workers range over a per-pod `podUpdates` channel;
  - local `close()` currently closes those channels as simulator cleanup.
- Short term: select/race each worker loop against `ctx.done()` so workers exit
  on cluster shutdown.
- Longer term: align method signatures with upstream names and `ctx`
  parameters, then keep channel closure only for removing a specific pod worker,
  not for cluster-wide shutdown.

### StatusManager

- Do not use status-manager cache clearing as a stop signal.
- Current local status manager has no active loop, so `close()` is only memory
  cleanup. It can remain simulator-owned for now.
- If we later model upstream `Start(ctx)`, its periodic work should be driven by
  the cluster `Clock` and should stop via context cancellation rather than
  global timers.

### Runtime Processes And Control Plane Images

- `ProcessContext` already has an `AbortSignal` and `waitUntilKilled()`. That is
  the container-process-level cancellation mechanism.
- `Scheduler`, `KubeProxy`, `EndpointSliceController`, and `CoreDNS` currently
  run until the simulated process is killed, then stop informers in `finally`.
- Keep that process-level behavior for pods. Cluster shutdown should remove or
  kill pod sandboxes/containers through kubelet/runtime cleanup so these
  processes observe their existing kill signal.
- If we add controller instances that run outside pods, model them with
  `Run(ctx)` and `<-ctx.done()` like upstream controllers.

## Implementation Sequence

1. Make context available to cluster lifecycle.

   Add root context/cancel to `Cluster`, derive server/kubelet contexts, and
   make `Cluster.close()` cancel first.

2. Stop kubelet by context.

   Thread context through `Server.boot`, `Kubelet.start`, `syncLoop`, and
   `syncLoopIteration`. Add a `ctx.done()` select case. Keep existing stopped
   guards only for idempotence and enqueue prevention.

3. Remove result-manager lifecycle closure.

   Delete `ResultsManager.close()` and `closed`. Remove calls from
   `ProbeManager.close()`. Verify probe result sends still backpressure.

4. Stop prober workers explicitly.

   Keep `ProbeManager.close()` stopping workers. Optionally pass kubelet context
   into `ProbeWorker.run(ctx)` after the kubelet context has been threaded in.

5. Thread context through pod workers.

   Update pod-worker loop signatures and sync callback types to accept context.
   Add cancellation checks around per-pod update waits and before starting new
   sync work.

6. Revisit simulator process shutdown.

   Ensure `Cluster.close()` reliably kills/removes all pod sandboxes and
   container processes, so in-pod control-plane components stop through their
   existing `ProcessContext.waitUntilKilled()` path.

## Tests To Add Or Update

- Context tests already cover cancel-only semantics from Go.
- Add a cluster shutdown test:
  - create a cluster;
  - start pods with probes/control-plane informers active;
  - call `cluster.close()`;
  - assert kubelet sync loops exit without closing probe result channels;
  - assert probe workers stop and remove themselves;
  - assert no clock timers remain after final `clock.clear()`.
- Add a focused `ResultsManager` test:
  - `set` sends only on changed result;
  - a full updates channel blocks `set` until a receiver consumes;
  - there is no `close()` behavior.
- Add a kubelet loop test:
  - canceling context exits the loop even if pod/probe channels are otherwise
    idle.
- Keep probe parity tests in `src/client/tests/probe.test.ts` running after each
  phase.

## Open Questions

- Should `Cluster.close()` be async and wait for component loops to exit?
  Kubernetes `Run(ctx)` methods return after cancellation, so an async close
  that awaits loop completion would be more testable. If we keep a synchronous
  `close()`, we should still expose enough state or promises to verify shutdown.
- Should local `Context` grow `deadline`, `value`, or `cause` later? Not needed
  for this shutdown work.
- Should `ProcessContext` eventually wrap the new `Context` instead of using
  `AbortSignal` directly? This is not required for kubelet parity, but could
  reduce the number of cancellation mechanisms in the simulator.
