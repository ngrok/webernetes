# Examples

Run an individual example with `pnpm example:single-pod`, or run all of them
with `pnpm test:examples`.

Each script is standalone and can also be run directly with `pnpm tsx`, for
example:

```bash
pnpm tsx examples/04-deployment-service-replicas.ts
```

- `01-single-pod.ts` starts one pod and fetches its pod IP directly.
- `02-node-port-service.ts` exposes a pod through a NodePort service.
- `03-two-pods-service-dns.ts` starts two pods and has them call each other
  through service DNS.
- `04-deployment-service-replicas.ts` uses a Deployment with multiple replicas
  behind a Service.
- `05-cross-namespace-service-dns.ts` sends traffic across namespaces with
  fully-qualified service DNS.
- `06-network-events-and-latency.ts` logs request and response events while a
  small latency provider spaces out the output.
