This directory contains TypeScript implementations of selected Go primitives.
The goal is behavioral parity for the primitives this simulator depends on,
not a complete TypeScript port of Go's standard library or runtime.

When adding or changing Go-inspired primitives:

- Start from the real Go behavior. Prefer upstream Go source, standard-library
  documentation, and runnable Go programs over assumptions about how a feature
  probably works.
- Keep the TypeScript API small and idiomatic for this codebase, but preserve
  the Go names and concepts where that makes behavior easier to compare.
- Do not implement broad runtime machinery unless the primitive actually needs
  it. Model the observable behavior used by this repository.
- In cluster simulation code, continue to route time through the simulator
  `Clock`; do not introduce direct global timer or current-time calls.
- Document any deliberate omissions near the tests or implementation, especially
  when upstream Go supports runtime modes, reflection behavior, or platform
  details that this project does not model.

Testing rules:

- Prefer copying or closely mirroring real Go tests when useful upstream tests
  exist. Cite the source file, version or commit, and line range in comments
  above the mirrored tests.
- If only part of an upstream Go test applies, say which subset is mirrored and
  list the omitted parts with the reason.
- When writing our own tests, derive each behavior from a real example Go
  program. Include that Go program as a comment immediately above the test,
  followed by its expected output.
- Keep those example programs small enough to paste into `go run` without extra
  setup. They should demonstrate the exact behavior the TypeScript assertion is
  checking.
- Prefer observable Go behavior over testing private TypeScript implementation
  state. If Go's upstream test inspects unexported runtime or package internals,
  adapt the check to the closest externally visible behavior.
- For concurrency-like behavior, make tests deterministic where possible. Use
  the local `Channel`, `select`, and simulator `Clock` helpers rather than
  sleeping on wall-clock time.

Reference workflow:

1. Find the closest Go package, source file, docs page, or small runnable Go
   program that defines the behavior.
2. Decide whether the implementation should mirror an upstream test or use a
   local example program.
3. Put the Go reference directly above the TypeScript test as either a source
   citation or a commented `package main` program with output.
4. Implement the smallest TypeScript behavior needed to make that referenced
   behavior pass.
