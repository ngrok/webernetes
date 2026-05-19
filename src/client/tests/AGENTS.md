This directory contains client parity tests that should run the same test body
against the real Kubernetes JavaScript client on k3s and the fake simulator
client.

Unless a task explicitly asks for a cross-resource workflow test, keep tests
organized by Kubernetes resource. Each `*.test.ts` file should represent the
parity coverage for one primary resource type, such as Pods in `pod.test.ts` or
Services in `service.test.ts`.

When adding tests, prefer asserting externally visible Kubernetes behavior over
simulator implementation details. If a test needs supporting resources, create
them locally in that resource file, but keep the main assertions scoped to the
file's primary resource.

When asserting errors in these tests:

- Match the exact upstream Kubernetes status message.
- Do not use regex assertions for error messages.
- For API errors, prefer `apiStatusMessage(error)` and `apiErrorCode(error)`
  from `src/test/harnesses/helpers.ts` so assertions read the Kubernetes
  `Status` body instead of matching escaped text in the client error wrapper.
- If using `toThrow`, use a literal string that includes the exact upstream
  Kubernetes status message, such as `namespaces "missing" not found`.
- If the exact message is unclear, verify it against the real-client side of the
  parity test before changing simulator behavior.
