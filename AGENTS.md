This repository implements a browser-friendly simulation of key Kubernetes
components, with an emphasis on:

- an in-process apiserver/storage model
- etcd-like primitives
- a fake client library under `src/client/` that is meant to be type-compatible
  enough with `@kubernetes/client-node` for shared tests to run against both
  the real client and the fake client

The fake client is not a wrapper around the real client and should not depend on
`@kubernetes/client-node` at runtime or in its exported source types. That
package is available as a dev dependency for reference, comparison, and tests
only.

General rules for this repository:

- Prefer preserving the broad structure of the real
  `kubernetes-client/javascript` repository where that helps compatibility, but
  keep the fake implementation human-readable and editable.
- In cluster simulation code, do not call global timer/time APIs such as
  `setTimeout`, `setInterval`, or `Date.now` directly. Route timeout, interval,
  and current-time behavior through the cluster `Clock` instance so the
  simulator can be paused and controlled deterministically.
- Shared tests should exercise the same calling code against the real client and
  the fake client. Favor changes that make the fake's public exported types line
  up with the real client's public exported types closely enough that unions and
  shared tests work naturally.
- Unless it is literally impossible to do so, test Kubernetes behavior through
  the parity tests in `src/client/tests/` so the simulated cluster is checked
  against real Kubernetes behavior.
- Do not introduce adapter-only type shims just to paper over mismatches between
  the real and fake clients.
- Do not introduce interfaces or types with names ending in `Like`.
- Do not use `any` as a shortcut around compatibility problems.
- When matching the real client, care most about the public exported surface and
  the specific generated types reachable from that surface. Internal generator
  structure does not need to be mirrored unless it materially helps
  compatibility or maintainability.
- It is acceptable to inspect the real client in `node_modules/` to understand
  shapes and signatures, but do not import from it in the fake client source.
- In this repo the package is installed at `node_modules/@kubernetes/client-node`
  and may be a pnpm symlink. For generated API and request shapes, prefer the
  `.d.ts` files under `node_modules/@kubernetes/client-node/dist/gen/`, notably
  `dist/gen/apis/*.d.ts` and `dist/gen/types/ObjectParamAPI.d.ts`.

Client-specific rules:

- Read `src/client/AGENTS.md` before changing files under `src/client/`.
- Read `src/client/gen/models/AGENTS.md` before adding or editing files under
  `src/client/gen/models/`.
- If adding API files under `src/client/gen/apis/`, keep them aligned with the
  real client's public API class names and method signatures as much as
  possible.

When making compatibility changes, prefer the following order:

1. Fix the fake exported types so they better match the real client.
2. Fix the fake implementation so behavior matches the shared tests.
3. Only change shared tests when the test itself is wrong or is asserting an
   unnecessary implementation detail.
