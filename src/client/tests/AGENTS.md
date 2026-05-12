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
