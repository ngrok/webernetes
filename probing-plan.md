# Kubelet Probing Plan

## Goal

Implement kubelet probing for simulated Pods while keeping the structure close to
real Kubernetes:

- `pkg/kubelet/prober/prober_manager.go`
- `pkg/kubelet/prober/worker.go`
- `pkg/kubelet/prober/prober.go`
- `pkg/kubelet/prober/results`

The simulator should support the same high-level control flow for the subset we
implement: a kubelet-owned probe manager creates one worker per configured
container probe, workers periodically execute probe actions, results are cached
per container ID, and kubelet status generation uses cached probe results to set
`started`, `ready`, `Ready`, and `ContainersReady`.

## Upstream Behavior To Preserve

The real kubelet has these responsibilities split across three layers:

1. `Manager`
   - `AddPod` creates workers for startup, readiness, and liveness probes.
   - `RemovePod` stops all workers and clears cached results.
   - `StopLivenessAndStartup` stops those probe types during termination.
   - `UpdatePodStatus` applies startup/readiness results to container statuses.

2. `worker`
   - Owns one `(pod UID, container name, probe type)` loop.
   - Waits for the target container status and container ID to exist.
   - Seeds initial results:
     - readiness: failure
     - liveness: success
     - startup: unknown
   - Honors `initialDelaySeconds`, `periodSeconds`, `timeoutSeconds`,
     `successThreshold`, and `failureThreshold`.
   - Suppresses readiness/liveness until startup has succeeded when a startup
     probe exists.
   - Puts liveness/startup workers on hold after a thresholded failure until a
     new container ID appears.

3. `prober`
   - Executes the selected handler: `exec`, `httpGet`, `tcpSocket`, or `grpc`.
   - Retries probe execution errors up to `maxProbeRetries` in Kubernetes.
   - Converts handler outcomes into result states: success, failure, unknown.

Source checkpoints:

- `pkg/kubelet/prober/prober_manager.go`: manager API, `AddPod`, `RemovePod`,
  `StopLivenessAndStartup`, and `UpdatePodStatus`.
- `pkg/kubelet/prober/worker.go`: periodic worker loop, initial values,
  startup gating, thresholds, and liveness/startup `onHold`.
- `pkg/kubelet/prober/prober.go`: exec/HTTP/TCP/gRPC action execution and
  result conversion.
- `pkg/kubelet/kuberuntime/kuberuntime_manager.go`: `computePodActions` and
  `SyncPod` container kill/start ordering.
- Kubernetes docs use `registry.k8s.io/e2e-test-images/agnhost:2.40` for HTTP
  probe examples and document HTTP success as `200 <= status < 400`.

## Simulator Scope

Implement first:

- regular container probes only
- readiness, liveness, and startup probe workers
- `exec`, `httpGet`, and `tcpSocket`
- threshold handling
- startup gating of readiness/liveness
- readiness updates in Pod status
- liveness/startup failure feeding into kubelet sync logic so kubelet kills the
  failed container and restarts it when restart policy allows
- regular-container restart policy behavior for missing, exited, probe-failed,
  unknown, and spec-changed containers

Defer:

- gRPC probes
- probe metrics/events
- kubelet restart grace-period behavior
- probe-level `terminationGracePeriodSeconds`

Do not implement init container or ephemeral container probing in this
iteration. Keep probe workers, status mutation, and container restart actions
scoped to regular containers.

## Proposed Files

Add a new directory:

- `src/cluster/prober/index.ts`
- `src/cluster/prober/results.ts`
- `src/cluster/prober/manager.ts`
- `src/cluster/prober/worker.ts`
- `src/cluster/prober/prober.ts`

Keep the naming close to upstream. Avoid importing real Kubernetes packages.

## Data Model

Use these local concepts:

- `ProbeType = "liveness" | "readiness" | "startup"`
- `ProbeResult = "success" | "failure" | "unknown"`
- `ProbeKey = { podUid: string; containerName: string; probeType: ProbeType }`
- results keyed by simulator container ID, matching upstream’s container-ID
  result cache

`ResultsManager` should expose:

- `get(containerId): ProbeResult | undefined`
- `set(containerId, result, pod): void`
- `remove(containerId): void`
- `updates(): AsyncIterable<ProbeUpdate>`

`ProbeUpdate = { containerId: string; result: ProbeResult; podUid: string }`.
The `pod` argument is used the same way upstream uses it: the result cache is
keyed only by container ID, but result changes publish the owning pod UID so the
kubelet can queue a pod sync.

Match upstream result-manager semantics:

- `set` publishes an update only when the container ID has no cached result or
  the new result differs from the cached result.
- `remove` deletes the cached result and does not publish an update.
- A single kubelet consumer is sufficient. Use a buffered in-process async queue
  so workers are not normally blocked by result updates.

Do not add pod-wide result cleanup to `ResultsManager`. Upstream cleanup is
worker-owned: when a worker observes a new container ID, it removes the old
container ID from its result manager; when a worker exits, it removes its current
container ID. `removePod` should stop workers and let each worker perform that
cleanup.

## Kubelet Integration

Add a `ProbeManager` owned by `Kubelet`.

Lifecycle integration:

1. Construct `ProbeManager` in `Kubelet`.
2. When a pod is accepted for sync, call `probeManager.addPod(pod)` before
   container creation. Upstream calls `AddPod` before `containerRuntime.SyncPod`;
   workers wait until container status exists.
3. After sandbox creation but before containers start, publish Pending status
   with pod IP as we now do.
4. After container start, build container statuses from runtime state.
5. Call `probeManager.updatePodStatus(pod, status)` before writing Pod status to
   storage.
6. On pod delete, call `probeManager.removePod(pod)` and then remove the sandbox.
7. On kubelet close, stop all probe workers.

Kubelet sync must also consult probe result managers before deciding whether to
keep or restart an existing container. This mirrors upstream
`computePodActions`: liveness/startup probe failures are not acted on directly by
workers; they become desired actions during the next sync.

Kubelet should consume result-manager updates like upstream `syncLoopIteration`:

- liveness: if the update result is failure, queue a sync for the pod
- readiness: update status through normal kubelet status generation and queue a
  sync for the pod
- startup: update status through normal kubelet status generation and queue a
  sync for the pod

Use a kubelet-owned `queuePodSync(podUid)`/`queuePodSync(pod)` helper rather
than letting workers call `syncPod` directly. Match upstream pod-worker
coalescing: keep at most one active sync and one pending update per pod key.
When a pod is already syncing, replace/coalesce the pending update with the
latest desired pod object. When the current sync completes, immediately run the
pending update before marking the pod idle. Do not drop probe-triggered sync
requests just because the pod key is currently pending.

Status rules:

- A running container without a startup probe is `started: true`.
- A running container with a startup probe is `started: true` only after startup
  result is success.
- A container without a readiness probe is ready once it is running and started.
- A container with a readiness probe is ready only when readiness result is
  success.
- Non-running containers are not ready and not started.
- Pod `ContainersReady` and `Ready` should be derived after probe manager status
  mutation.
- `ContainersReady` is true only when all regular containers have ready
  statuses.
- `Ready` mirrors `ContainersReady` unless `spec.readinessGates` is present; if
  readiness gates are present, every referenced pod condition must exist with
  status `True`.
- Recompute container `ready`, `started`, `Ready`, and `ContainersReady` on every
  status write. Do not preserve previous readiness/condition values once probing
  owns the state.

Implementation detail from upstream `UpdatePodStatus`: if a running container is
started and there is no readiness worker for it, it is ready. If a readiness
worker exists and the readiness result is not success or has not run yet, it is
not ready, and the manager triggers an immediate readiness probe run with a
non-blocking worker signal. If a manual run is already queued, do not enqueue
another. A manual run resets the periodic schedule so the next periodic probe is
`periodSeconds` after the manual run.

## Worker Timing

Do not call global timers directly. Workers must use `cluster.clock` through a
small scheduling abstraction:

- one timeout for initial jitter if we choose to model it
- one interval-like loop using `clock.wait(periodMs)`
- one cancellation flag per worker
- one non-blocking manual trigger path for readiness probes

Initial implementation can skip Kubernetes’ startup jitter if tests do not need
it, but the worker loop should still be structured so jitter can be added.
Upstream probes immediately before waiting on the first ticker, except for the
optional startup jitter used after kubelet restart.

Default probe values must match Kubernetes API defaults when fields are absent:

- `initialDelaySeconds`: `0`
- `periodSeconds`: `10`
- `timeoutSeconds`: `1`
- `successThreshold`: `1`
- `failureThreshold`: `3`

Readiness probes allow `successThreshold > 1`; liveness and startup effectively
use success threshold `1` in Kubernetes validation.

## Probe Execution

`exec`

- Use `runtime.execSync(containerId, command, { timeoutMs })`.
- Success when exit code is `0`.
- Failure when exit code is non-zero or timeout returns the simulator timeout
  code.
- Expand static environment-variable references in exec commands if the fake
  client already has or adds a local helper for it; upstream expands static
  container env references before running exec probes.

`httpGet`

- Resolve the probe port like Kubernetes does:
  - numeric `port` directly
  - named `port` from `container.ports`
- Default host to pod IP when `httpGet.host` is absent.
- When `httpGet.host` is present, still route the simulator request to the pod
  IP, but set the request `Host` header to `<host>`. This keeps probes
  node/kubelet-originated while allowing tests to observe the configured host.
- Build request path, scheme, and headers from `V1HTTPGetAction`.
- Preserve duplicate `httpHeaders` by representing headers as
  `Record<string, string[]>` internally or by another structure that does not
  collapse repeated names before dispatch.
- Apply Kubernetes' default probe headers unless explicitly overridden:
  `User-Agent: kube-probe/...` and `Accept: */*`. If `Accept` is explicitly set
  to an empty value, omit it.
- Support `HTTP` only. Do not implement `HTTPS` for this project.
- Use `ClusterNetwork.fetch` directly against the routed pod-IP target.
- Success for HTTP status `200 <= status < 400`, matching Kubernetes HTTP probe
  semantics.
- Treat 3xx statuses as successful probe results for readiness/liveness
  decisions, even though upstream records them as warning results internally.
- Failure for reachable non-success status.
- Failure for malformed probe config or unsupported scheme in this simulator
  scope, without throwing out the result before threshold handling.

`tcpSocket`

- Resolve port like HTTP.
- Default host to pod IP.
- Add `ClusterNetwork.canConnect(host, port): boolean`.
- `canConnect` should check for an HTTP listener at the routed endpoint and
  return true when one exists, false otherwise.
- Success if a listener exists at the routed endpoint.
- Failure if no listener exists.

`grpc`

- Defer. Treat as a failed probe until implemented. Add tests
  only when implementing.

## Liveness And Startup Failure Handling

Real kubelet feeds liveness/startup failures into `computePodActions`, which
kills/restarts containers during the next pod sync.

Implement the upstream-shaped path:

1. Workers only write thresholded results to their result manager.
2. Workers put liveness/startup probing on hold after thresholded failure until a
   new container ID appears, matching upstream worker behavior.
3. Workers request a kubelet pod resync, but do not stop containers themselves.
4. `Kubelet.syncPod` computes actions from current runtime status plus probe
   result managers.
5. If a running container has a failed liveness probe, kubelet stops/removes that
   container and starts a replacement if the pod/container restart policy allows
   restarting.
6. If a running container has a failed startup probe, kubelet follows the same
   restart-policy-aware path. Startup success is also required before
   readiness/liveness should affect the container.

Do not recreate the whole sandbox for ordinary liveness/startup probe failures.
Upstream restarts the failed container unless sandbox state/spec changes require
pod sandbox recreation.

Restart count should follow upstream container start behavior: for a replacement
container, find the previous status for the same container name and set the new
container config attempt/restart count to `previous.restartCount + 1`. For a
container name with no previous status, use `0`.

Implement regular-container action computation close to upstream
`computePodActions`:

- if no sandbox exists, or the existing sandbox is not ready or lacks a pod IP,
  create/recreate the sandbox;
- if sandbox recreation is required and pod restart policy is `Never` after a
  previous attempt with recorded container statuses, kill the old sandbox but do
  not create a replacement sandbox;
- when creating a fresh sandbox, start all regular containers except containers
  that already succeeded under `restartPolicy: OnFailure`;
- for a missing or non-running regular container, start it only when Kubernetes'
  restart policy rules say it should restart: `Always` restarts, `OnFailure`
  restarts non-zero exits, and `Never` does not restart exited containers;
- always start containers that have never had a status;
- always restart `Created`/`Unknown` containers and kill `Unknown` containers
  before replacement to avoid duplicate running instances;
- if a running container's spec has changed, kill and restart it regardless of
  restart policy;
- if a running container has a failed liveness or startup result, kill it and
  restart it only when restart policy allows restart;
- if no regular containers are kept and none will be started, kill the pod
  sandbox rather than leaving an empty running pod.

Keep the ordering close to upstream `SyncPod`: compute all actions first; if the
sandbox must be killed, stop/remove sandbox contents in one pod-level path;
otherwise stop/remove selected containers first, then create/start selected
containers in the existing sandbox. Do not have probe workers call runtime
stop/remove APIs.

Needed runtime support:

- find container by pod sandbox and container name
- stop/remove a single container
- create/start a replacement container with incremented attempt/restart count
- add a minimal per-container filesystem, backed by `Map<string, string>`, so
  image code and exec probes can share simple file state

## Minimal Container Filesystem

Add a deliberately small filesystem abstraction to `ContainerInstance`:

- `fs`
- `fs.read(path): string | undefined`
- `fs.write(path, contents = ""): void`
- `fs.delete(path): boolean`
- `fs.has(path): boolean`

Expose this through `ProcessContext` with small helpers so image definitions do
not reach into container internals directly.

This is enough to model the Kubernetes docs' common exec-probe pattern:

- container startup writes `/tmp/healthy`
- later startup code deletes `/tmp/healthy`
- exec liveness probe runs `cat /tmp/healthy`
- failure causes kubelet to restart the container

The filesystem should be per container attempt. When kubelet restarts a
container, the replacement gets a fresh empty `Map`, matching the practical
behavior needed for probe tests without introducing persistent filesystem state.

## Tests

Use parity tests in `src/client/tests/` where possible.

Add a new `src/client/tests/probe.test.ts` with shared k3s/simulator cases:

1. readiness probe starts false, then becomes true after HTTP endpoint succeeds
2. pod with no readiness probe becomes ready when running
3. startup probe gates readiness/liveness until it succeeds
4. failing readiness probe marks container and pod not ready
5. exec readiness probe succeeds/fails based on command exit code
6. liveness failure restarts the container and increments restart count
7. tcpSocket readiness succeeds when the container listens on the target port

Preferred real-cluster image:

- Use Kubernetes' own `registry.k8s.io/e2e-test-images/agnhost:2.40` first. The
  official probe docs use it for HTTP liveness examples, and its `netexec`
  command includes `/shell`, `/echo`, `/healthz`, and `/readyz` endpoints.
- Do not rely on `agnhost netexec` `/shell` returning a non-2xx status for failed
  commands. Upstream source for current and v1.26-v1.28-era agnhost records the
  shell error in JSON but does not set an HTTP failure status for command
  failure. Use `/healthz`, `/readyz`, `/echo?code=...`, `/redirect`, and exec
  probes for parity tests unless a specific agnhost image version is verified to
  differ.
- Mirror that behavior in the simulator with a registered
  `registry.k8s.io/e2e-test-images/agnhost:2.40` image rather than depending on
  `hashicorp/http-echo`.
- The simulator agnhost image should implement the subset used by these tests:
  `netexec` starts an HTTP listener; `/healthz` and `/readyz` return success;
  `/echo` returns a simple success body and supports a `code` query parameter;
  `/shell?cmd=...` executes a small supported command subset against the
  container filesystem and returns a JSON body with `output` and/or `error`.
  Keep these shell commands local to the simulator agnhost image for now.
  Support at least `test -f`, `touch`, `rm -f`, and `cat` for probe tests.

Additional test shapes:

- Set probe `periodSeconds: 1` and explicit low thresholds in parity tests so
  k3s tests do not wait for Kubernetes' 10-second default period.
- Exec liveness can follow the Kubernetes docs pattern using the simulator's
  minimal per-container filesystem: create `/tmp/healthy`, later remove it, and
  expect kubelet to restart the container.
- HTTP liveness can use a deterministic endpoint that returns 200 for a fixed
  period and then 500. In simulator tests this can be clock-driven; in k3s tests
  prefer `agnhost` behavior or an explicit command if it keeps wall-clock runtime
  acceptable.
- TCP readiness should use a container that opens a listener after startup. The
  simulator should check raw listener presence; k3s relies on the real kubelet
  TCP probe.

## Implementation Phases

1. Add probe result manager and types.
2. Add `ProbeManager.addPod`, `removePod`, and worker lifecycle without executing
   probes yet.
3. Wire `ProbeManager.updatePodStatus` into kubelet status generation.
4. Implement exec probes.
5. Implement HTTP probes.
6. Implement `ClusterNetwork.canConnect` and TCP probes.
7. Implement regular-container action computation and restart-policy-aware
   liveness/startup restart handling.
8. Add the minimal container filesystem and simulator agnhost `netexec` subset.
9. Add parity tests and browser tests.
10. Run:

- `pnpm typecheck`
- focused probe tests in node and browser
- affected pod/service/exec/endpointslice tests

## Source-Backed Decisions

- Liveness/startup failures restart the failed container, not the whole sandbox,
  unless sandbox recreation is independently required. This follows
  `computePodActions`, which adds failed containers to `ContainersToKill` and
  conditionally to `ContainersToStart` while leaving `KillPod` false for
  ordinary probe failures. The conditional start is controlled by restart policy:
  `Always` restarts, `OnFailure` restarts non-zero exits and probe-killed
  running containers, and `Never` does not restart probe-killed containers.
- Readiness changes should be written through kubelet status generation.
  Workers store results and request resync/manual readiness probing; they do not
  directly patch Pod status.
- Probe result cache keys are container IDs. The pod UID is carried on update
  events so the kubelet can find the current pod and queue a sync. Duplicate
  result sets do not publish updates; removals do not publish updates.
- Worker cleanup removes cached results for the worker's last known container ID
  when the container ID changes or the worker exits.
- Startup success gates readiness and liveness. In status generation, a running
  container with a startup worker but no successful startup result is
  `started: false`; without a startup worker it is `started: true`.
- Restart count for a newly created replacement container is based on the prior
  status for the same container name plus one.
- `UpdatePodStatus` triggers readiness workers immediately and non-blockingly
  when a running, started container has a readiness worker but no successful
  readiness result.
- Probe workers probe once immediately, then wait for either the periodic tick,
  a manual trigger, or stop. A manual trigger resets the next periodic interval.
- Probe execution retries handler execution errors up to Kubernetes'
  `maxProbeRetries` value of 3. Success maps to `success`; warning maps to
  `success`; failure maps to `failure`; unknown without an execution error maps
  to `failure`.
- HTTP probes set `req.Host` from an explicit `Host` header. `httpGet.host`
  selects the URL host upstream; in this simulator we route to pod IP but use the
  configured host as the request `Host` header so the request remains
  kubelet-originated in the fake network.
- HTTP status `200 <= status < 400` is successful. Upstream reports 3xx as an
  internal warning but the prober manager treats warning as success.
- TCP probes are successful when a TCP connection can be opened and failures
  when connection/open times out or is refused. The simulator's first TCP support
  maps this to HTTP listener presence.
- `agnhost netexec` `/shell` should not be used as a real-cluster HTTP
  readiness endpoint unless the exact image version is verified to return
  non-2xx on command failure. Current upstream and v1.26-v1.28 source do not set
  HTTP failure status for command failure.
