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
- liveness/startup failure feeding into kubelet sync logic so kubelet restarts
  the failed container

Defer:

- gRPC probes
- all init container probing, including restartable init containers
- all ephemeral container probing
- probe metrics/events
- container restart policy edge cases beyond the current simulator subset
- kubelet restart grace-period behavior
- probe-level `terminationGracePeriodSeconds`

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

The `pod` argument is mostly for parity with upstream and future event hooks.

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

## Worker Timing

Do not call global timers directly. Workers must use `cluster.clock` through a
small scheduling abstraction:

- one timeout for initial jitter if we choose to model it
- one interval-like loop using `clock.wait(periodMs)`
- one cancellation signal per worker

Initial implementation can skip Kubernetes’ startup jitter if tests do not need
it, but the worker loop should still be structured so jitter can be added.

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

`httpGet`

- Resolve the probe port like Kubernetes does:
  - numeric `port` directly
  - named `port` from `container.ports`
- Default host to pod IP when `httpGet.host` is absent.
- Build request path, scheme, and headers from `V1HTTPGetAction`.
- Support `HTTP` only. Do not implement `HTTPS` for this project.
- Use `ClusterNetwork.fetch` directly for pod-IP targets.
- Success for HTTP status `200 <= status < 400`, matching Kubernetes HTTP probe
  semantics.
- Failure for reachable non-success status.
- Unknown for malformed probe config or unsupported scheme.

`tcpSocket`

- Resolve port like HTTP.
- Default host to pod IP.
- Inspect raw listener presence in `ClusterNetwork`; do not expose a new
  protocol-neutral listener abstraction.
- Success if a listener exists at the routed endpoint.
- Failure if no listener exists.

`grpc`

- Defer. Return unknown or reject unsupported config until implemented. Add tests
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
   container and starts a replacement.
6. If a running container has a failed startup probe, kubelet follows the same
   restart path. Startup success is also required before readiness/liveness
   should affect the container.

Do not recreate the whole sandbox for ordinary liveness/startup probe failures.
Upstream restarts the failed container unless sandbox state/spec changes require
pod sandbox recreation.

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
behavior needed for probe tests without introducing volumes yet.

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
- For dynamically controlled HTTP readiness, use `agnhost netexec` with an HTTP
  readiness probe against `/shell?cmd=test%20-f%20/tmp/ready`. The endpoint
  returns success when the command succeeds and a non-2xx status when it fails.
  Tests can flip readiness by execing `touch /tmp/ready` or `rm -f /tmp/ready`
  in the running container.
- Mirror that behavior in the simulator with a registered agnhost-like test
  image rather than depending on `hashicorp/http-echo`.

Additional test shapes:

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
6. Implement TCP probes and any needed network helper.
7. Implement liveness/startup restart handling.
8. Add parity tests and browser tests.
9. Run:
   - `pnpm typecheck`
   - focused probe tests in node and browser
   - affected pod/service/exec/endpointslice tests

## Open Questions

Source-backed decisions:

- Liveness/startup failures restart the failed container, not the whole sandbox,
  unless sandbox recreation is independently required. This follows
  `computePodActions`, which adds failed containers to `ContainersToKill` and
  `ContainersToStart` while leaving `KillPod` false for ordinary probe failures.
- Readiness changes should be written through kubelet status generation.
  Workers store results and request resync/manual readiness probing; they do not
  directly patch Pod status.
- TCP probes inspect raw listener presence in the simulator network.
