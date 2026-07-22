# @ngrok/webernetes

## 0.5.0

### Minor Changes

- [`e997c80`](https://github.com/ngrok/webernetes/commit/e997c8016c9288f7379c9e5a96f27b03a23c4bbd) Thanks [@samwho](https://github.com/samwho)! - Change simulated HTTP connection establishment to occur when a request reaches
  its already-selected destination, after configured request latency, rather than
  when `ClusterNetwork.fetch()` sends the request. This is a public behavioral
  change for users of `ClusterNetwork` and its `"request"` / `"response"` events.

  Previously, Webernetes checked whether the destination HTTP listener was bound
  immediately after route selection. A request sent at simulated time `T0` to an
  unbound endpoint therefore failed with `ECONNREFUSED` immediately, even when a
  non-zero request latency meant that the request would not reach the endpoint
  until a later simulated time. The emitted request event carried the refusal and
  there was no corresponding response event.

  For example, with 100 ms of request latency, this sequence previously failed:

  ```text
  T0:   send HTTP request; destination has no listener
  T0:   request event contains ECONNREFUSED
  T50:  destination binds its HTTP listener
  T100: fetch rejects with ECONNREFUSED
  ```

  Now the request event means that the request departed and is in transit. After
  request latency elapses, Webernetes looks up the listener and dispatches the
  request. The same sequence now succeeds:

  ```text
  T0:   send HTTP request; request event has no error
  T50:  destination binds its HTTP listener
  T100: request arrives; handler is invoked and a successful response event is emitted
  T100 + response latency: fetch resolves
  ```

  The inverse is also now modeled accurately. If a listener exists when the
  request is sent but closes before the request arrives, the request is refused
  at arrival time. The request event still has no error, and the response event
  contains the Node-style `ECONNREFUSED` cause:

  ```text
  T0:   send HTTP request; listener is bound; request event has no error
  T50:  listener closes
  T100: request arrives; response event contains ECONNREFUSED; fetch rejects
  ```

  This changes the event lifecycle for listener failures from a request-only
  failure to `request event -> request latency -> errored response event ->
response latency`. Existing public `fetch()` rejection mapping remains the
  same: a refused connection still rejects with `TypeError("fetch failed")` whose
  cause identifies `ECONNREFUSED`. With zero request latency, listener-present
  and listener-absent requests retain their immediate success/failure behavior;
  no extra scheduling turn is introduced.

  Route selection is intentionally unchanged. Service endpoint selection and
  other routing decisions still occur before request latency; only availability
  of the already-selected destination HTTP listener is evaluated at arrival.

## 0.4.2

### Patch Changes

- [`2ae6a97`](https://github.com/ngrok/webernetes/commit/2ae6a97bc1f2fb8a54ef922790f91e9a93f39b64) Thanks [@samwho](https://github.com/samwho)! - Fix crash-loop retry-deadline annotation publishing so `webernetes.ngrok.com/crash-loop-backoff` is present while a regular container is in `CrashLoopBackOff`. The annotation now uses the runtime's precise retry deadline and is removed when the container restarts.

- [`226821f`](https://github.com/ngrok/webernetes/commit/226821f682f7e9025a2571dbbc02ba7dca80ea16) Thanks [@samwho](https://github.com/samwho)! - Refresh project, test, and demo dependencies, including pnpm. Update the demo to remain compatible with the latest Mantle button API while preserving its existing outlined controls.

## 0.4.1

### Patch Changes

- [`e429938`](https://github.com/ngrok/webernetes/commit/e429938cd2566b853ff8b58358ecf0c9a2539815) Thanks [@samwho](https://github.com/samwho)! - Publish the Webernetes-specific `webernetes.ngrok.com/crash-loop-backoff` Pod annotation while regular containers are held in CrashLoopBackOff. Its JSON value maps each backing-off container name to its scheduled RFC3339 restart time, and is cleared as soon as no container remains in crash-loop backoff. For example:

  ```yaml
  metadata:
    annotations:
      webernetes.ngrok.com/crash-loop-backoff: >-
        {"api":"2026-07-21T10:20:30.000Z","worker":"2026-07-21T10:20:45.000Z"}
  ```

## 0.4.0

### Minor Changes

- [#34](https://github.com/ngrok/webernetes/pull/34) [`8852c3f`](https://github.com/ngrok/webernetes/commit/8852c3f4d28aae99beb6ef10877d60a1c9888b2a) Thanks [@samwho](https://github.com/samwho)! - The Webernetes library now works in Node.js as well as in the browser.

## 0.3.5

### Patch Changes

- [`82f052f`](https://github.com/ngrok/webernetes/commit/82f052f6d512caf82a5148b9e2d420972ded46ca) Thanks [@samwho](https://github.com/samwho)! - Preserve Kubernetes resource UIDs across full-object updates and reject attempts to change an existing UID. EndpointSlice reconciliation now retains generated slice UIDs in replace responses, lists, and watch events.

## 0.3.4

### Patch Changes

- [`8dc99e3`](https://github.com/ngrok/webernetes/commit/8dc99e3cc51605403e0314af3ea56e71a13d249e) Thanks [@samwho](https://github.com/samwho)! - Report built-in simulator nodes as ready by default, until we build in proper node readiness checking. Before this, they had no readiness status.

## 0.3.3

### Patch Changes

- [`8228f05`](https://github.com/ngrok/webernetes/commit/8228f0517a676432743b6be216e9bb60419f5565) Thanks [@samwho](https://github.com/samwho)! - Match Kubernetes event timestamp behavior by using `eventTime` for scheduler events with null legacy timestamps and preserving event timestamps as `Date` values through storage reads.

## 0.3.2

### Patch Changes

- [`d1ece45`](https://github.com/ngrok/webernetes/commit/d1ece45f7a05256e8449a9cac042e426febe4670) Thanks [@samwho](https://github.com/samwho)! - Set creation timestamps on newly created Kubernetes resources using the cluster clock and preserve them as `Date` values through storage reads and watches.

## 0.3.1

### Patch Changes

- [`6e71a2b`](https://github.com/ngrok/webernetes/commit/6e71a2b03e3d06b37132f6b1203f73bddf97840a) Thanks [@samwho](https://github.com/samwho)! - Ensure every network request event without an initial error is followed by
  exactly one correlated response event. Requests canceled during simulated
  request latency now emit a response with a socket-closed error instead of
  leaving event consumers waiting indefinitely.

## 0.3.0

### Minor Changes

- [`d3c4860`](https://github.com/ngrok/webernetes/commit/d3c48602e3cd2ec4511d6e10c7c9982cdc7c4655) Thanks [@samwho](https://github.com/samwho)! - Expose `setTimeout`, `setInterval`, `queueMicrotask`, and their timer-clearing
  counterparts on `ProcessContext` for process-owned simulated work. Process
  context operations now consistently reject work after a container has been
  killed, preventing late listener registration and other post-termination work
  from causing unhandled exceptions.

## 0.2.2

### Patch Changes

- [`e486403`](https://github.com/ngrok/webernetes/commit/e4864035235190c3ccadf9dea3472ecaff4107df) Thanks [@samwho](https://github.com/samwho)! - Model network event errors after the corresponding Node.js network failures. Request events for
  targets unavailable before dispatch carry Node-style connection-refused errors, for example
  `Error("connect ECONNREFUSED <service-ip>:80")` with code `ECONNREFUSED` when a Service has no
  ready targets, or `Error("connect ECONNREFUSED <pod-ip>:8080")` when a selected pod has not
  bound its target port. Those failures have no response event.

  For example, a request event for an unavailable Service target has this shape:

  ```ts
  {
    error: Object.assign(new Error("connect ECONNREFUSED 10.96.0.10:80"), {
      address: "10.96.0.10",
      code: "ECONNREFUSED",
      errno: -61,
      port: 80,
      syscall: "connect",
    }),
  }
  ```

  The corresponding `fetch()` rejection wraps the same Node-style cause:

  ```ts
  new TypeError("fetch failed", {
  	cause: Object.assign(new Error("connect ECONNREFUSED 10.96.0.10:80"), {
  		address: "10.96.0.10",
  		code: "ECONNREFUSED",
  		errno: -61,
  		port: 80,
  		syscall: "connect",
  	}),
  });
  ```

  Model pod removal during an in-flight HTTP request as Node's `SocketError` with code
  `UND_ERR_SOCKET` and message `other side closed`. Because the request was already dispatched,
  that failure is attached to the response event rather than the request event:

  ```ts
  {
    error: Object.assign(new Error("other side closed"), {
      name: "SocketError",
      code: "UND_ERR_SOCKET",
    }),
  }
  ```

## 0.2.1

### Patch Changes

- [`85ab76c`](https://github.com/ngrok/webernetes/commit/85ab76c9cb2cd1140f6159d0f9795f1bc5873b17) Thanks [@samwho](https://github.com/samwho)! - Expose the `Context` type.

## 0.2.0

### Minor Changes

- [#22](https://github.com/ngrok/webernetes/pull/22) [`4e8682d`](https://github.com/ngrok/webernetes/commit/4e8682ddc200bf108a1cf2d7150f95d859f744e1) Thanks [@samwho](https://github.com/samwho)! - Pass the simulation context to latency provider callbacks and expose `getCluster` for resolving the owning cluster. This changes the `LatencyProvider` callback signatures and will break existing implementations.

  Update each callback to accept `ctx` as its first argument:

  ```ts
  // Before
  newLatencyProvider({
  	clusterNetworkRequestLatency: (event) => event.chain.length * 10,
  });

  // After
  newLatencyProvider({
  	clusterNetworkRequestLatency: (ctx, event) => {
  		const cluster = getCluster(ctx);
  		return event.chain.length * 10;
  	},
  });
  ```

  Callbacks that do not need cluster state should still accept the new argument, conventionally as `_ctx`.

## 0.1.6

### Patch Changes

- [`e446c95`](https://github.com/ngrok/webernetes/commit/e446c95908f24c09b74e40db9d5c5526cff17082) Thanks [@samwho](https://github.com/samwho)! - Assign each simulated cluster a unique, read-only ID within the current page.

## 0.1.5

### Patch Changes

- [`56791d2`](https://github.com/ngrok/webernetes/commit/56791d281e9b62e99d730e3842fc1686c49c9080) Thanks [@samwho](https://github.com/samwho)! - Allow clusters to be created with a configurable number of initial nodes while keeping the default cluster size at three nodes.

## 0.1.4

### Patch Changes

- [`49733e2`](https://github.com/ngrok/webernetes/commit/49733e2b6cc2fba1424ed5024b3f58d8e30e7cc8) Thanks [@samwho](https://github.com/samwho)! - Keep temporary workload scheduling balanced during bursts by serializing node selection with in-flight reservations, and ignore terminating Pods when counting node workload.

## 0.1.3

### Patch Changes

- [`c355517`](https://github.com/ngrok/webernetes/commit/c355517ef5baf65eb6673a3792ec7b275789119d) Thanks [@samwho](https://github.com/samwho)! - Temporarily schedule new workload Pods onto the node with the fewest active non-system Pods, ignoring kube-system control-plane components until the simulator has a proper scheduler implementation.

## 0.1.2

### Patch Changes

- [`b03b8d2`](https://github.com/ngrok/webernetes/commit/b03b8d26e832fbb7b6e60c9e3d1b3c66c061896a) Thanks [@samwho](https://github.com/samwho)! - Preserve service targets when re-registering an existing Service so endpoint reconciliation cannot briefly or permanently leave routable Services without ready targets.

## 0.1.1

### Patch Changes

- [`607b4e7`](https://github.com/ngrok/webernetes/commit/607b4e77b7349689031dc50bb6953b1eb0b11a9a) Thanks [@samwho](https://github.com/samwho)! - Publish the built `dist` artifacts so package exports resolve correctly for consumers.
