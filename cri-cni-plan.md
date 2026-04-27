# CRI/CNI Simulation Plan

This document describes the planned runtime and networking model for this
project. It intentionally does not model full Kubernetes CRI, full CNI, TCP,
UDP, Linux namespaces, or real container execution. The goal is to provide just
enough structure for a simulated kubelet to run fake container images, route
HTTP and DNS requests between pods, run a fake CoreDNS pod, and support
Kubernetes Services.

## Goals

- Model Kubernetes pod/container/process lifecycle clearly enough for kubelet
  behavior.
- Support fake image definitions that can start processes and register HTTP
  handlers.
- Support HTTP and DNS networking through in-memory lookups.
- Run a fake CoreDNS pod that answers cluster DNS requests.
- Support Service DNS, pod IPs, and Service routing without simulating packets.
- Keep the API small, testable, browser-friendly, and easy to reason about.

## Non-goals

- Do not implement full CRI protobuf request/response types.
- Do not implement CNI plugin chains.
- Do not simulate TCP, UDP packets, sockets, NAT, iptables, conntrack, or
  kube-proxy.
- Do not simulate Linux process isolation, filesystems, cgroups, or namespaces.
- Do not parse shell commands unless a later feature explicitly needs it.
- Do not make fake client code depend on `@kubernetes/client-node` at runtime.

## Core Concepts

The simulator should use instance-oriented names instead of CRI-specific names:

- `PodInstance`: the running pod-level environment.
- `ContainerInstance`: one running container definition inside a pod.
- `ProcessInstance`: one running invocation inside a container.
- `ImageDefinition`: a fake image implementation.
- `ImageRegistry`: a fake image registry, similar to a minimal Docker Hub.
- `ClusterNetwork`: the in-memory HTTP/DNS network and routing table.

The Kubernetes/CRI concept of a pod sandbox maps to `PodInstance`. We should
avoid exposing `PodSandbox` as a primary concept unless later CRI compatibility
requires it.

## Code Layout

The implementation should live under the existing `src/cluster/` tree. Keep
runtime code, network code, kubelet orchestration, apiserver storage, and test
helpers separate.

Planned ownership:

- `src/cluster/cri/`: fake container runtime implementation.
- `src/cluster/cni/`: fake network, DNS, Service routing, and NodePort
  implementation.
- `src/cluster/kubelet.ts`: kubelet orchestration that watches/starts pods on a
  `Server`.
- `src/cluster/server.ts`: simulated node/server wiring.
- `src/cluster/cluster.ts`: cluster-wide construction and bootstrap.
- `src/cluster/storage/`: apiserver storage model for Kubernetes resources.
- `src/client/`: Kubernetes client-compatible public API used by shared tests
  and in-cluster controllers.

Recommended `src/cluster/cri/` files:

- `image.ts`: `ImageDefinition`, `ImageRegistry`, and image lookup errors.
- `process.ts`: `ProcessInstance`, `ProcessContext`, process lifecycle, and
  process-owned listener cleanup.
- `container.ts`: `ContainerInstance`, container status, command/argv
  resolution, and exec handling.
- `pod.ts`: `PodInstance` and pod-level lifecycle state.
- `runtime.ts`: kubelet-facing `Runtime` implementation that owns pod/container
  maps and delegates networking to `src/cluster/cni/`.
- `index.ts`: public exports for the runtime package.

Recommended `src/cluster/cni/` files:

- `http.ts`: project-owned `HttpRequest`, `HttpResponse`, `HttpHandler`, and
  `HttpListener` types.
- `dns.ts`: `DnsRequest`, `DnsResponse`, `DnsHandler`, Service DNS resolution,
  and fake CoreDNS image helpers if they fit cleanly here.
- `service.ts`: `ServiceInstance`, `ServicePort`, endpoint selection, and
  Service routing types. ClusterIP and NodePort allocation belongs in
  apiserver Service storage, not here.
- `network.ts`: `ClusterNetwork` map-backed dataplane for pod registration,
  listener binding, HTTP fetch, DNS resolution, and NodePort ingress.
- `index.ts`: public exports for the network package.

Existing `src/cluster/network.ts` should move to `src/cluster/cni/network.ts`
once imports are updated. Avoid maintaining two independent network
implementations.

Recommended controller/runtime-adjacent files:

- `src/cluster/scheduler.ts`: minimal scheduler that assigns unscheduled pods to
  a `Server` by setting `spec.nodeName`.
- `src/cluster/controllers/proxy.ts`: kube-proxy-style reconciler that watches
  Services and EndpointSlices and registers routing state in `ClusterNetwork`.
- `src/cluster/controllers/endpointslice.ts`: minimal EndpointSlice reconciler
  that mirrors Kubernetes' EndpointSlice controller: watch Services and Pods,
  select matching ready pods, and write EndpointSlice objects.
- `src/cluster/controllers/deployment.ts` and
  `src/cluster/controllers/replicaset.ts`: eventual workload controllers if the
  shared tests create Deployments rather than raw Pods.
- `src/cluster/controllers/serviceaccount.ts`: eventual default ServiceAccount
  and token/identity wiring if in-cluster controllers need ServiceAccount-like
  behavior.

Additional pieces likely needed:

- An `EndpointSliceController` equivalent that watches Services and Pods and
  writes EndpointSlices.
- A kube-proxy-style controller that watches Services and EndpointSlices and
  registers/unregisters routing state in `ClusterNetwork`. This is not the
  Kubernetes Service controller; the real Service controller is mostly about
  cloud LoadBalancer lifecycle.
- A scheduler or simple scheduling hook that assigns pods to `Server`s. The
  kubelet should only run pods assigned to its server.
- Service ClusterIP and NodePort allocation should happen on Service
  create/update, matching Kubernetes apiserver storage behavior. Do not defer
  allocation to request time.
- A cluster bootstrap path that creates `kube-system`, the `kube-dns` Service,
  and the fake CoreDNS pod/image.
- NodePort ingress should use the same fetch-style boundary as in-cluster HTTP:
  `fetchNodePort(nodePort, request)` should accept `HttpRequest` and return
  `Promise<HttpResponse>`.
- Image registry configuration on `Cluster`, so tests can register fake behavior
  for real image references such as `crccheck/hello-world`.
- Shared test harness helpers that choose between real-cluster NodePort access
  and simulator NodePort access without changing test logic.

## Kubernetes Source Review

Reviewing the local Kubernetes source at
`~/Developer/github.com/kubernetes/kubernetes` confirms the main shape of this
plan: kubelet should see a runtime-like boundary, networking should be modeled
as pod-level state plus Service routing, and DNS should be a CoreDNS-like
workload that observes the API rather than a hard-coded name lookup table.

Important responsibilities to model:

- Kubelet watches desired pods, admits/starts only pods assigned to its node,
  delegates pod/container lifecycle to the runtime, and writes pod status back
  to the apiserver.
- Kubelet creates pod runtime state only after network readiness and pod setup
  prerequisites; this simulator can simplify volumes/cgroups/resources, but it
  should preserve the desired-state-to-runtime-to-status flow.
- Kubelet configures pod DNS from cluster DNS settings. The simulator should
  give processes DNS behavior through the fake CoreDNS Service, not by bypassing
  DNS resolution in `fetch()`.
- Kubelet probes eventually update container readiness/startup/liveness and
  trigger resyncs. Probes can remain deferred, but readiness shortcuts should be
  marked with `TODO(probes)`.
- For containers without readiness probes, kubelet marks a running/started
  container ready. The first simulator slice should mirror that default instead
  of inventing listener-based readiness.
- Scheduling is not a kubelet responsibility. A separate scheduler binds pods to
  nodes by setting `spec.nodeName`; kubelets then run only their assigned pods.
- Service ClusterIP and NodePort allocation happens during Service
  create/update in apiserver storage, before kube-proxy/CoreDNS consume the
  Service.
- EndpointSlice controller watches Services and Pods, selects pods using the
  Service selector, and writes EndpointSlices. CoreDNS watches EndpointSlices;
  kube-proxy also consumes EndpointSlices for routing.
- Deployment and ReplicaSet controllers are responsible for creating lower-level
  objects. If tests create Deployments, the simulator needs at least a minimal
  Deployment-to-ReplicaSet-to-Pod path or a deliberate shortcut that still
  preserves observable client behavior.

What this plan intentionally simplifies:

- No cgroups, volume mounting, resource admission, eviction, pod certificates,
  static pods, mirror pods, PLEG, metrics, logs, or real streaming APIs in the
  first increment.
- No real kube-proxy packet programming. `ClusterNetwork` directly implements
  the observable Service routing behavior.
- No real CRI or CNI protobuf/plugin implementation. `PodInstance`,
  `ContainerInstance`, `ProcessInstance`, and `ClusterNetwork` are sufficient
  for the browser-friendly simulator.

Additional gaps to track:

- Pod status updates: kubelet should update Pod status so EndpointSlice/CoreDNS
  and client tests see running/ready pods.
- EndpointSlice objects: for realistic kube-proxy and CoreDNS paths, the first
  NodePort milestone should include a minimal EndpointSlice reconciler and
  storage model.
- Service apiserver storage: `src/cluster/storage/service.ts` should
  allocate/release ClusterIPs and NodePorts on Service create/update/delete.
- Workload controllers: the first shared NodePort test can use a raw Pod, but
  Deployment tests require Deployment and ReplicaSet controllers.
- ServiceAccounts: in-cluster controllers will likely need default namespace
  ServiceAccount behavior and a `KubeConfig` that can construct fake clients.
- Environment variables: Kubernetes normally injects Service environment
  variables into containers unless disabled. This can be deferred if tests use
  DNS, but note it as a compatibility gap.
- Downward API, ConfigMaps, Secrets, and volumes: defer until a fake image or
  controller test actually needs them.

## Why PodInstance Exists

A pod-level object is still useful even though this simulator is not modeling
real namespaces. In Kubernetes, pod-level state survives individual container
restarts and is shared by every container in the pod. That same separation keeps
the simulator coherent.

Put state on `PodInstance` when it belongs to the pod:

- pod UID, name, namespace, and labels
- pod IP
- pod IP and namespace identity
- HTTP listeners bound to the pod IP
- readiness state used by Services
- cleanup of all containers/listeners when the pod is deleted

Put state on `ContainerInstance` when it belongs to a container:

- container name
- image reference
- command, args, env, and ports from the pod spec
- restart count
- container status
- main process handle
- exec target for user commands and later probes

Put state on `ProcessInstance` when it belongs to one running execution:

- process ID
- argv
- start/finish timestamps
- exit code
- stdout/stderr logs
- HTTP handlers registered by that execution

This separation matters for Services because Services route to pods, not to
individual processes. A Service endpoint should ultimately resolve to a pod IP
and target port.

## High-level Flow

Expected pod startup flow:

1. Kubelet observes a scheduled pod.
2. Runtime creates a `PodInstance`.
3. `ClusterNetwork` allocates/registers a pod IP.
4. Runtime resolves image refs through `ImageRegistry`.
5. Runtime creates one `ContainerInstance` per pod container.
6. Runtime starts each container's main `ProcessInstance`.
7. Processes can call `listenHttp()` to bind handlers on the pod IP.
8. Fake CoreDNS can call `listenDns()` to bind DNS on the DNS Service path.
9. Service routing includes only matching ready pods.

Expected request flow from a process:

1. `ProcessInstance.fetch("http://api.default:80/users")` is called.
2. The process resolves the host through the fake CoreDNS Service.
3. The process delegates to `ClusterNetwork.fetch()`.
4. For Service ClusterIPs, `ClusterNetwork` selects an endpoint pod and maps
   Service port to target port.
5. `ClusterNetwork` dispatches directly to the registered HTTP handler.
6. The handler returns a synthetic HTTP response object.

## Image Registry

`ImageRegistry` is the fake image lookup layer. It maps image references to
image definitions.

Use `ImageRegistry`, not `ContainerRegistry`, because it stores definitions for
images rather than live container instances.

```ts
export interface ImageRegistry {
	register(imageRef: string, image: ImageDefinition): void;
	resolve(imageRef: string): ImageDefinition | undefined;
}
```

An `ImageDefinition` describes behavior when a container starts or when a
command is executed inside that image.

```ts
export interface ImageDefinition {
	defaultCommand?: string[];
	start(context: ProcessContext, argv: readonly string[]): Promise<number>;
	exec(context: ProcessContext, argv: readonly string[]): Promise<number>;
}
```

Recommended behavior:

- `start()` runs the main process and always returns an exit code.
- `exec()` runs an explicit command for probes, debugging, or tests.
- `start()` receives the container start argv. By default this should be the
  image's `defaultCommand`, overridden by the pod/container command and args.
- `exec()` always receives the argv passed by the caller.
- If an argv is unknown to the image, the image should return a non-zero exit
  code such as `127`.
- Avoid shell parsing by default. Image code should inspect argv directly if it
  needs command-specific behavior.

## Runtime Interfaces

The runtime is the kubelet-facing API. It should expose Kubernetes-ish lifecycle
operations while hiding implementation details of images, processes, and the
network.

```ts
export interface Runtime {
	createPod(pod: PodRuntimeSpec): Promise<PodInstance>;
	deletePod(podUid: string): Promise<void>;
	getPod(podUid: string): PodInstance | undefined;
	listPods(): PodInstance[];

	pullImage(imageRef: string): Promise<void>;
	createContainer(podUid: string, spec: ContainerRuntimeSpec): Promise<ContainerInstance>;
	startContainer(containerId: string): Promise<ProcessInstance>;
	stopContainer(containerId: string, gracePeriodMs?: number): Promise<void>;
	removeContainer(containerId: string): Promise<void>;
	getContainer(containerId: string): ContainerInstance | undefined;
	containerStatus(containerId: string): ContainerStatus;

	execSync(containerId: string, argv: string[], options?: ExecOptions): Promise<ExecResult>;
}
```

The runtime owns live pod and container maps. It should use `ImageRegistry` to
resolve fake images and `ClusterNetwork` to register pods and dispatch HTTP.

```ts
export interface PodRuntimeSpec {
	uid: string;
	name: string;
	namespace: string;
	labels?: Record<string, string>;
	annotations?: Record<string, string>;
}

export interface ContainerRuntimeSpec {
	name: string;
	image: string;
	command?: string[];
	args?: string[];
	env?: Record<string, string>;
	ports?: ContainerPort[];
}

export interface ContainerPort {
	name?: string;
	containerPort: number;
	protocol?: "TCP" | "UDP" | "SCTP";
}

export interface ExecOptions {
	stdin?: Uint8Array;
	timeoutMs?: number;
	tty?: boolean;
}

export interface ExecResult {
	stdout: Uint8Array;
	stderr: Uint8Array;
	exitCode: number;
}
```

`PodRuntimeSpec.uid` comes from Kubernetes object metadata. Real pods are
created by the apiserver with `metadata.uid`; the simulator should preserve that
UID when the kubelet/runtime creates the corresponding `PodInstance`. Tests that
construct pods directly should assign stable synthetic UIDs.

Even though `ContainerPort.protocol` allows Kubernetes protocol names, the
initial implementation should only dispatch application-level HTTP and DNS. The
protocol field is retained because Kubernetes pod and Service specs include it.
TCP/UDP packet semantics are still out of scope.

## PodInstance

`PodInstance` is the running pod-level environment. It is the simulator's
equivalent of a CRI pod sandbox, but should be named for the project rather than
for CRI.

```ts
export interface PodInstance {
	readonly uid: string;
	readonly name: string;
	readonly namespace: string;
	readonly labels: ReadonlyMap<string, string>;
	readonly annotations: ReadonlyMap<string, string>;
	readonly ip: string;
	readonly phase: PodInstancePhase;
	readonly containers: ReadonlyMap<string, ContainerInstance>;

	isReady(): boolean;
	setReady(ready: boolean): void;
	networkPeer(): NetworkPeer;
}

export type PodInstancePhase = "Pending" | "Running" | "Succeeded" | "Failed";
```

Implementation notes:

- The pod receives an IP when it is registered with `ClusterNetwork`.
- The pod IP remains stable across container restarts.
- All containers in the pod share the same pod IP and listener namespace.
- Deleting the pod should close all listeners and remove network registrations.
- Readiness can be a simple explicit boolean until probing is implemented.
- Add `TODO(probes)` comments anywhere readiness is manually set or defaulted so
  those shortcuts are easy to replace with real readiness/liveness behavior.

## ContainerInstance

`ContainerInstance` is the runtime object for one container inside a pod. It
connects pod spec details to fake image behavior.

```ts
export interface ContainerInstance {
	readonly id: string;
	readonly name: string;
	readonly imageRef: string;
	readonly pod: PodInstance;
	readonly command: readonly string[];
	readonly args: readonly string[];
	readonly env: ReadonlyMap<string, string>;
	readonly ports: readonly ContainerPort[];
	readonly restartCount: number;
	readonly state: ContainerState;

	start(): ProcessInstance;
	exec(argv: string[], options?: ExecOptions): ProcessInstance;
	stop(gracePeriodMs?: number): Promise<void>;
	status(): ContainerStatus;
}

export type ContainerState = "Created" | "Running" | "Exited";

export interface ContainerStatus {
	id: string;
	name: string;
	imageRef: string;
	state: ContainerState;
	restartCount: number;
	startedAt?: number;
	finishedAt?: number;
	exitCode?: number;
	reason?: string;
	message?: string;
	ready: boolean;
}
```

Implementation notes:

- `start()` should create the main process for the container.
- `exec()` should create a separate process associated with the same container.
- Container readiness is not identical to listener availability. Until probes
  exist, containers without readiness probes can become ready when their main
  process is running/started. Add `TODO(probes)` comments where that shortcut
  should later be replaced.
- Restarting a container should create a new main `ProcessInstance` but keep the
  same `PodInstance` and pod IP.

## ProcessInstance

`ProcessInstance` is the fake running process. It is the object exposed to image
code through `ProcessContext`.

```ts
export interface ProcessInstance {
	readonly pid: number;
	readonly argv: readonly string[];
	readonly container: ContainerInstance;
	readonly state: ProcessState;
	readonly startedAt: number;
	readonly finishedAt?: number;
	readonly exitCode?: number;

	wait(): Promise<number>;
	kill(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
}

export type ProcessState = "Created" | "Running" | "Exited";
```

The process itself should not directly own network routing. Instead, the
`ProcessContext` supplied to image code exposes helper methods that delegate to
the pod's network registration.

```ts
import type { KubeConfig } from "../client/types";

export interface ProcessContext {
	readonly pid: number;
	readonly argv: readonly string[];
	readonly env: ReadonlyMap<string, string>;
	readonly container: ContainerInstance;
	readonly pod: PodInstance;
	readonly kubeConfig: KubeConfig;

	exec(argv: string[], options?: ExecOptions): ProcessInstance;
	listenHttp(port: number, handler: HttpHandler): HttpListener;
	listenDns(port: number, handler: DnsHandler): DnsListener;
	fetch(target: string, init?: HttpRequest): Promise<HttpResponse>;
	resolveDns(name: string, type?: DnsRecordType): Promise<DnsResponse>;
	sleep(ms: number): Promise<void>;
	exit(code?: number): never;
}
```

Implementation notes:

- `listenHttp()` binds at pod IP scope, not process scope.
- `listenDns()` exists so a fake CoreDNS image can bind DNS behavior at the
  `kube-dns` Service IP/port through normal Service routing.
- If the process exits, listeners registered by that process must close.
- `fetch()` should call `ClusterNetwork.fetch()` with the process's pod as the
  source peer.
- `resolveDns()` should call `ClusterNetwork.resolveDns()` using the pod's
  namespace and DNS search configuration.
- `kubeConfig` should be the existing fake client `KubeConfig` from
  `src/client/types.ts`, not a new runtime-specific config shape.
- `exec()` can be implemented by delegating to `container.exec()`.

## HTTP Types

The network is an in-memory HTTP dispatcher. Requests and responses should be
small project-owned types rather than browser `Request`/`Response` objects. This
keeps the implementation portable across Node and browser tests.

```ts
export interface HttpRequest {
	method?: string;
	path?: string;
	headers?: Record<string, string>;
	body?: string;
}

export interface HttpResponse {
	status: number;
	headers?: Record<string, string>;
	body?: string;
}

export type HttpHandler = (request: HttpRequest) => Promise<HttpResponse>;

export interface HttpListener {
	readonly ip: string;
	readonly port: number;
	close(): void;
}
```

## DNS Types

DNS should also be modeled as an application-level protocol rather than UDP/TCP.
The fake CoreDNS pod should expose a DNS handler, and the cluster network should
route DNS requests to that handler.

```ts
export type DnsRecordType = "A" | "AAAA" | "CNAME" | "SRV";

export interface DnsRequest {
	name: string;
	type: DnsRecordType;
}

export interface DnsResponse {
	rcode: "NOERROR" | "NXDOMAIN" | "SERVFAIL";
	answers: DnsAnswer[];
}

export type DnsAnswer =
	| { type: "A" | "AAAA"; name: string; address: string; ttl: number }
	| { type: "CNAME"; name: string; target: string; ttl: number }
	| { type: "SRV"; name: string; target: string; port: number; ttl: number };

export type DnsHandler = (request: DnsRequest) => Promise<DnsResponse>;

export interface DnsListener {
	readonly ip: string;
	readonly port: number;
	close(): void;
}
```

Default request behavior:

- `method` defaults to `GET`.
- `path` defaults to `/`.
- Headers should be treated case-insensitively only if tests require it.
- A thrown HTTP handler error should become a synthetic `500` response.
- A thrown DNS handler error should become a `SERVFAIL` response.

## ClusterNetwork

`ClusterNetwork` is the simulated dataplane. It allocates pod and Service IPs,
tracks HTTP and DNS listeners, stores Services, resolves request targets, and
dispatches in-cluster HTTP and DNS calls through map lookups.

```ts
export interface Network {
	registerPod(pod: PodInstance): NetworkRegistration;
	unregisterPod(podUid: string): void;

	registerService(service: ServiceInstance): void;
	unregisterService(namespace: string, name: string): void;

	resolveName(from: NetworkPeer, name: string): NetworkEndpoint[];
	fetch(from: NetworkPeer, target: string, init?: HttpRequest): Promise<HttpResponse>;
	fetchNodePort(nodePort: number, init?: HttpRequest): Promise<HttpResponse>;
	resolveDns(from: NetworkPeer, request: DnsRequest): Promise<DnsResponse>;
}

export interface NetworkRegistration {
	readonly podUid: string;
	readonly ip: string;
	bindHttp(port: number, handler: HttpHandler): HttpListener;
	bindDns(port: number, handler: DnsHandler): DnsListener;
	unregister(): void;
}

export interface NetworkPeer {
	namespace: string;
	podName: string;
	podUid: string;
	ip: string;
}

export interface NetworkEndpoint {
	namespace: string;
	name: string;
	uid?: string;
	ip: string;
	port?: number;
	kind: "pod" | "service";
}
```

Recommended internal state:

```ts
class ClusterNetwork implements Network {
	private podsByUid = new Map<string, PodInstance>();
	private podsByIp = new Map<string, PodInstance>();
	private podUidsByDnsName = new Map<string, Set<string>>();
	private httpListeners = new Map<string, HttpHandler>();
	private dnsListeners = new Map<string, DnsHandler>();

	private servicesByKey = new Map<string, ServiceInstance>();
	private servicesByClusterIp = new Map<string, ServiceInstance>();
	private serviceKeysByDnsName = new Map<string, string>();
}
```

Useful keys:

```ts
const listenerKey = `${ip}:${port}`;
const namespacedNameKey = `${namespace}/${name}`;
```

`NetworkPeer` represents an in-cluster pod. Node-originated and external traffic
should use explicit methods such as `fetchNodePort()` rather than pretending the
node is an in-cluster workload peer.

Do not model pod DNS records in the first implementation. Only Service DNS names
matter for now.

Service DNS names can follow the common Kubernetes forms:

```ts
function serviceDnsNames(service: ServiceInstance): string[] {
	return [
		service.name,
		`${service.name}.${service.namespace}`,
		`${service.name}.${service.namespace}.svc`,
		`${service.name}.${service.namespace}.svc.cluster.local`,
	];
}
```

When resolving a short name like `api`, follow Kubernetes Service DNS search
behavior and prefer Services in the caller's namespace. In practice, a pod with
namespace `default` searches names like `api.default.svc.cluster.local` before
less-specific cluster domains. This means a short name should resolve as a
Service name. Do not resolve short names to pods.

## Fake CoreDNS

DNS should be exercised through a fake CoreDNS pod rather than being a hidden
special case in `ProcessContext`.

Recommended cluster bootstrapping:

1. Create a `kube-system` namespace.
2. Create a `kube-dns` or `coredns` Service with a stable cluster IP.
3. Start a fake CoreDNS `PodInstance` in `kube-system`.
4. The CoreDNS process calls `listenDns(53, handler)`.
5. Pod DNS config points at the DNS Service IP.
6. `ProcessContext.resolveDns()` sends a DNS request to that Service.
7. `ProcessContext.fetch()` resolves hostnames through `resolveDns()` before it
   dispatches HTTP.

The fake CoreDNS image can implement Kubernetes DNS records by querying the
simulated apiserver through its `kubeConfig`. This mirrors real CoreDNS: Service
DNS records are not pushed into CoreDNS by a separate controller that rewrites
CoreDNS configuration for each Service. Instead, CoreDNS runs with a mostly
static Corefile containing the `kubernetes` plugin, connects to the apiserver
using in-cluster configuration, and watches Kubernetes resources.

For this simulator, copy that model:

- Boot CoreDNS from a fake `ImageDefinition`.
- Give it the existing project `KubeConfig` from `src/client/types.ts`.
- Have the CoreDNS process watch/list Services and EndpointSlices through the
  fake client API.
- Have it answer Service `A` records from Service ClusterIPs.

The CoreDNS ConfigMap/Corefile can be modeled later if tests need to change DNS
plugin settings. It should not be required for normal Service DNS updates.

## Binding Rules

HTTP and DNS listeners should be bound by pod IP and port:

```ts
httpListeners.set(`${pod.ip}:${port}`, handler);
dnsListeners.set(`${pod.ip}:${port}`, handler);
```

This gives useful Kubernetes-like behavior without TCP simulation:

- Two containers in the same pod cannot bind the same port.
- A container restart can close/reopen listeners without changing the pod IP.
- A Service can keep routing to the same pod IP while containers restart.
- Deleting the pod removes every listener for that pod.

Listeners are process-owned but bound at pod scope. When a process exits, its
listeners should close. The pod IP remains allocated until the pod is deleted.

Container `ports` should be treated as metadata used by Services, DNS SRV
records, eventual probes, and tests. Host ports can remain out of scope, but
NodePort Services should be supported either initially or shortly after
ClusterIP Services so shared integration tests can send traffic into both real
and simulated clusters.

## Fetch Target Parsing

`ClusterNetwork.fetch()` should accept HTTP-like targets:

- `http://10.0.0.12:8080/path`
- `http://service-name:80/path`
- `http://service-name.namespace:80/path`
- `http://service-name.namespace.svc.cluster.local:80/path`

Optional shorthand can be added later, but the first implementation should
require a port unless routing through a Service with an unambiguous single port.

Resolution order:

1. IP literal plus port: dispatch directly to `httpListeners.get(ip:port)`.
2. Hostname plus port: resolve DNS through the configured fake CoreDNS Service.
3. Service ClusterIP plus port: resolve Service, select endpoint, map Service
   port to target port, dispatch to endpoint pod IP and target port.
4. Pod IP plus port: dispatch to pod IP and port.
5. Unknown target: reject with a deterministic network error.

Network failures, DNS failures, and missing listeners should reject the fetch
promise. Handler exceptions are different: those should become synthetic `500`
HTTP responses.

## Services

Services should be modeled in the network layer, not in pods or containers.
Services do not own handlers. They select ready pods and route traffic to pod
listeners.

Service API defaulting/allocation should be modeled at the apiserver Service
storage boundary, not in a Service controller:

- Allocate `spec.clusterIP`/`spec.clusterIPs` when a ClusterIP or NodePort
  Service is created without an explicit ClusterIP.
- Allocate `spec.ports[*].nodePort` when a NodePort Service is created without
  explicit NodePorts.
- Preserve allocated ClusterIPs and NodePorts across updates when clients omit
  them.
- Release allocated ClusterIPs and NodePorts when Services are deleted.
- Headless Services and ExternalName Services can be deferred for now.

This mirrors Kubernetes: ClusterIP and NodePort are persisted `spec` fields and
are allocated during Service REST create/update before the object is stored. A
Service controller or network reconciler should consume those already-allocated
values and register routing state; it should not allocate them later.

```ts
export interface ServiceInstance {
	readonly uid: string;
	readonly name: string;
	readonly namespace: string;
	readonly clusterIp: string;
	readonly type: "ClusterIP" | "NodePort";
	readonly selector: ReadonlyMap<string, string>;
	readonly ports: readonly ServicePort[];
}

export interface ServicePort {
	name?: string;
	port: number;
	targetPort: number | string;
	nodePort?: number;
	protocol?: "TCP" | "UDP" | "SCTP";
}
```

Endpoint selection:

```ts
export interface ServiceEndpoint {
	service: ServiceInstance;
	pod: PodInstance;
	port: number;
	targetPort: number;
}
```

Endpoint computation should be driven by EndpointSlices:

- The EndpointSlice reconciler finds pods in the same namespace.
- It matches `service.selector` against pod labels.
- It includes only ready pods.
- It writes minimal EndpointSlice objects with endpoint addresses and named
  ports.
- The kube-proxy-style network controller consumes Services and EndpointSlices
  and registers routing state in `ClusterNetwork`.
- `ClusterNetwork` selects an endpoint according to the configured simulated
  proxy policy.

This is worth modeling early. Real kube-proxy and CoreDNS both consume
EndpointSlices. If shared tests ever inspect EndpointSlices or rely on CoreDNS
watching the realistic resource path, direct endpoint computation from
`PodInstance`s will be the wrong seam.

`targetPort` resolution:

- If numeric, use it directly.
- If string, find a matching named `ContainerPort` on any container in the pod.
- If no matching named port exists, exclude that pod from endpoints for that
  Service port.

Service cluster IP allocation should be part of the initial Service
implementation. Kubernetes DNS returns the Service ClusterIP for normal
ClusterIP Services; the dataplane then load-balances traffic sent to that IP.
The simulator should mirror that split:

- DNS returns Service ClusterIP records.
- `fetch()` to a Service ClusterIP routes through Service endpoint selection.
- `fetch()` to a NodePort routes through the matching NodePort Service.
- Services do not own handlers; selected pods own the handlers.

NodePort should be supported in the initial Service implementation. It matters
for shared client tests because the same test code should be able to send
traffic into a real cluster and into the simulated cluster. LoadBalancer,
ExternalName, session affinity, and topology-aware routing can be deferred.

## Service Selection

Kubernetes does not have one universal "Service round robin" implementation.
The behavior depends on the proxy mode:

- `iptables` kube-proxy writes probabilistic random rules. Each endpoint rule,
  except the last, uses the `statistic` module with `--mode random`; the final
  endpoint is the guaranteed fallback. The probabilities are computed so each
  endpoint has roughly equal chance.
- `ipvs` kube-proxy defaults to the `rr` scheduler, meaning round robin, unless
  configured with a different IPVS scheduler.
- DNS for a normal ClusterIP Service does not select pods. CoreDNS returns the
  Service ClusterIP; endpoint selection happens when traffic reaches the Service
  IP.

For the simulator, use a deterministic round-robin policy for Service endpoint
selection by default. It is easy to test, close to IPVS default behavior, and
avoids flaky tests. Document that this is a simulator policy, not an exact model
of every kube-proxy mode. A later option can add a seeded random policy to mimic
iptables mode if needed.

## Deferred Probes

Do not implement kubelet probe behavior in this increment. The runtime and
network should only make it possible for processes to make in-cluster HTTP and
DNS requests, bind HTTP/DNS handlers, and execute image-defined commands.

Add `TODO(probes)` comments to any temporary readiness defaults or manual
readiness shortcuts. Probe behavior can later build on the existing
`execSync()`, `fetch()`, and port metadata.

## Cleanup Semantics

The cleanup path should be explicit and deterministic.

Deleting a `PodInstance` should:

- stop all container processes
- close all HTTP listeners for the pod
- unregister the pod IP and DNS names
- remove the pod from runtime maps

Stopping a `ContainerInstance` should:

- stop its main process
- close listeners registered by that process
- update container status
- leave the pod IP registered

Exiting a `ProcessInstance` should:

- set exit code and finished timestamp
- resolve `wait()`
- close process-owned listeners

Unregistering a Service should:

- remove Service DNS names
- remove Service routing state from `ClusterNetwork`
- leave ClusterIP/NodePort release to apiserver Service storage delete handling
- not modify pods or pod listeners

## First NodePort Milestone Contract

Before implementation starts, make the first vertical slice executable and
source-backed. This contract is intentionally narrower than the full plan, but
it should not contradict Kubernetes behavior.

API/resource scope:

- Support raw Pods and NodePort Services first. Deployments, ReplicaSets,
  Service DNS, fake CoreDNS, and probes can follow after this milestone.
- Include minimal EndpointSlice objects before the first NodePort test. Real
  kube-proxy watches Services and EndpointSlices, and the EndpointSlice
  controller is the Kubernetes seam between Service selectors and routable
  endpoints.
- Do not require pod DNS, Service environment variables, ExternalName Services,
  LoadBalancers, headless Services, session affinity, or topology-aware routing.

Cluster defaults:

- Use Kubernetes' default NodePort range, `30000-32767`.
- Make Service CIDR configurable. A kubeadm-like default such as
  `10.96.0.0/12` is reasonable for this simulator, but the kube-apiserver also
  has its own code default and real clusters commonly override it.
- Allocate pod IPs from the assigned `Server`/node pod CIDR. This keeps pod IP
  assignment on the kubelet/runtime side rather than on Service storage.

Allocation policy:

- Accept explicit `spec.clusterIP` and `spec.ports[*].nodePort` values when
  they are valid and unallocated.
- Reject explicit values that are out of range or already allocated.
- Preserve allocated `clusterIP`, `clusterIPs`, and `nodePort` values across
  updates unless the update is a supported Service type transition.
- Release allocated values when Services are deleted.
- Kubernetes dynamic allocation uses a random-scan allocator with an offset so
  the upper part of the range is preferred before the lower reserved band. For
  browser-test determinism, use either a seeded version of this strategy or a
  deterministic allocator that is clearly documented as a simulator deviation.
  Shared tests should not assert exact dynamically allocated values.

Readiness/status policy:

- For a container without a readiness probe, Kubernetes treats a running and
  started container as ready. The first simulator slice should do the same:
  once the image `start()` process is running, mark the container ready.
- If a Pod specifies readiness/liveness/startup probes before probe support
  exists, leave `TODO(probes)` at the status shortcut and avoid relying on that
  Pod in the first shared test.
- Pod `Ready` and `ContainersReady` should be computed from container readiness,
  not from listener binding. The first test should use an image with no
  readiness probe.

Process policy:

- `ImageDefinition.start()` returns a `Promise<number>` that resolves when the
  long-running process exits. A server process should keep this promise pending
  until it is stopped or calls `ctx.exit(code)`.
- `ctx.exit(code)` should resolve the process with that numeric exit code and
  close all listeners owned by that process.
- Runtime stop/delete should close process-owned listeners and resolve or cancel
  outstanding process work consistently.
- Restart policy can be deferred for the first test; use a stable long-running
  process and add restart behavior once shared tests require it.

Network/error policy:

- Add a small `NetworkError extends Error` under `src/cluster/cni/` and reject
  `fetch()`/`fetchNodePort()` promises with it for DNS misses, unknown Services,
  no endpoints, missing listeners, or unsupported protocols.
- Handler exceptions are not network errors. Convert thrown HTTP handler errors
  into synthetic `500` responses.
- Only route HTTP over TCP in the first NodePort test. Keep DNS as a planned
  application protocol, but do not require it for the first milestone.

Service routing policy:

- The kube-proxy-style controller watches Services and EndpointSlices and writes
  routing state into `ClusterNetwork`.
- No endpoints should behave as an unreachable Service. A rejected
  `NetworkError` is the simulator equivalent of kube-proxy's reject/drop rules.
- Multiple Service ports are allowed, but routing must use the requested Service
  port or NodePort to choose the matching Service port.
- Numeric `targetPort` maps directly. Named `targetPort` resolves through named
  container ports when the EndpointSlice is built.
- Empty-selector Services should not get controller-managed EndpointSlices.
  Manually-created EndpointSlices can be deferred until tests need selectorless
  Services.
- Service, Pod, and EndpointSlice updates must remove stale routes.

Test harness policy:

- The first shared test creates resources through the client API and discovers
  allocated fields from the returned/read Service object.
- If real-cluster access is easier with an explicit NodePort, the test may set
  one in the default range, but it still should not assert simulator-specific
  dynamic allocation order.
- The chosen Docker Hub image response should be treated as authoritative at
  implementation time. The fake image should replicate only the status, headers,
  and body parts that the shared test asserts.

## Implementation TODOs

This should progress in small vertical slices. The first milestone is one shared
test that creates a pod, exposes it through a NodePort Service, and reaches it
over HTTP in both a real cluster and the simulator. DNS, Deployments, probes,
and richer controllers should come after that first signal.

### Phase 1: API And Storage Prerequisites

- [ ] Add minimal Service generated/client types needed by shared tests:
      `V1Service`, `V1ServiceSpec`, `V1ServicePort`, `V1ServiceList`, and any
      required metadata/status support.
- [ ] Add minimal CoreV1 Service API methods in `src/client/gen/apis/` and
      storage under `src/cluster/storage/`.
- [ ] Implement Service create/update/delete allocation semantics in apiserver
      Service storage: allocate `spec.clusterIP` for ClusterIP/NodePort
      Services, allocate `spec.ports[*].nodePort` for NodePort Services,
      preserve allocated values across updates, and release allocations on
      delete. Service controllers consume these allocated values; they do not
      allocate them.
- [ ] Add Service validation/defaulting only as far as the first shared test
      needs. Avoid trying to fully clone apiserver Service validation up front.
- [ ] Add a cluster-level NodePort fetch helper, exposed from `Cluster` or
      `ClusterNetwork`. It should match the existing fetch-style boundary:
      accept a NodePort and `HttpRequest`, then return `Promise<HttpResponse>`.

### Phase 2: Runtime And Network Primitives

- [ ] Move existing `src/cluster/network.ts` into `src/cluster/cni/network.ts`
      so there is one network implementation under `src/cluster/cni/`.
- [ ] Add shared HTTP types in `src/cluster/cni/http.ts`.
- [ ] Add initial `ClusterNetwork` support for pod IP allocation, pod
      registration, process-owned HTTP listener binding, listener cleanup, and
      direct HTTP dispatch by IP/port.
- [ ] Add `ImageRegistry` and `ImageDefinition` in `src/cluster/cri/image.ts`.
- [ ] Add `PodInstance`, `ContainerInstance`, and `ProcessInstance` in
      `src/cluster/cri/`, including argv handling and `Promise<number>` process
      exits.
- [ ] Add `ProcessContext.listenHttp()` and `ProcessContext.fetch()` for IP and
      Service/NodePort paths needed by the first test. `listenDns()` and
      `resolveDns()` can wait until the DNS phase.
- [ ] Add the kubelet-facing runtime in `src/cluster/cri/runtime.ts`, owning
      live pod/container maps and delegating listener/fetch work to
      `ClusterNetwork`.

### Phase 3: Scheduling And Kubelet Startup

- [ ] Add a minimal scheduler that watches unscheduled pods and assigns
      `spec.nodeName` to a `Server`. A simple deterministic first-fit or
      round-robin policy is enough. This is intentionally much simpler than the
      real Kubernetes scheduler; it only exists to create the observable
      `spec.nodeName` binding that kubelet relies on.
- [ ] Wire `Cluster` to own `ImageRegistry` and `ClusterNetwork`.
- [ ] Wire each `Server` to own a runtime and pass it to `Kubelet`.
- [ ] Teach `Kubelet` to watch pods assigned to its server, create
      `PodInstance`s, create/start container instances from image refs, and stop
      runtime state when pods are deleted. Keep this flow aligned with the real
      kubelet source as much as practical, especially the desired-pod watch,
      pod-worker style reconciliation, runtime delegation, and status update
      boundaries.
- [ ] Update Pod status from kubelet with at least phase, pod IP, and container
      state fields needed by Service endpoint selection and shared tests.
- [ ] Add `TODO(probes)` comments to readiness defaults. Until probes exist,
      containers without readiness probes can become ready when their main
      process is running/started. Do not infer readiness from listener binding.

### Phase 4: Services And NodePort Routing

- [ ] Add minimal EndpointSlice generated/client/storage types needed for
      internal controllers and shared tests.
- [ ] Add an EndpointSlice reconciler that watches Services and Pods, uses
      Service selectors to choose ready pod endpoints, and writes EndpointSlice
      objects.
- [ ] Add a kube-proxy-style network controller that watches Services and
      EndpointSlices and registers/unregisters Service routing state in
      `ClusterNetwork`. Do not put this in apiserver Service storage, and do not
      model it as the Kubernetes Service controller.
- [ ] Implement `targetPort` resolution for numeric and named container ports.
- [ ] Implement deterministic round-robin endpoint selection.
- [ ] Implement ClusterIP routing by mapping Service IP/port to selected pod
      IP/targetPort.
- [ ] Implement NodePort routing by mapping nodePort to selected Service
      endpoint.
- [ ] Ensure pod deletion, Service deletion, and process exit remove stale
      listeners/endpoints from routing.

### Phase 5: First Shared NodePort Test

- [ ] Choose a small, trusted Docker Hub image with an HTTP endpoint, likely
      `crccheck/hello-world` if it is still appropriate at implementation time.
- [ ] Write one shared test that creates a Pod or simple Deployment plus a
      NodePort Service through the Kubernetes client API.
- [ ] Make the real-cluster version call the real NodePort endpoint.
- [ ] Register the same image reference in the simulator's `ImageRegistry`.
- [ ] Replicate only the image behavior needed by the test in the fake image.
- [ ] Make the simulator version call the simulator NodePort fetch helper.
- [ ] Treat this test passing in both environments as the first completion
      signal for the runtime/network stack.

### Phase 6: Service DNS And Fake CoreDNS

- [ ] Add DNS request/response types in `src/cluster/cni/dns.ts`.
- [ ] Add `ProcessContext.listenDns()` and `ProcessContext.resolveDns()`.
- [ ] Bootstrap `kube-system`, a `kube-dns`/`coredns` Service with a stable
      ClusterIP, and a fake CoreDNS image/pod.
- [ ] Have fake CoreDNS use the existing project `KubeConfig` from
      `src/client/types.ts` to list/watch Services and EndpointSlices.
- [ ] Answer Service `A` records from Service ClusterIPs.
- [ ] Update `ProcessContext.fetch()` to resolve Service hostnames through fake
      CoreDNS before HTTP dispatch.
- [ ] Add shared tests for in-cluster Service DNS after the NodePort test works.

### Phase 7: Kubernetes Compatibility Increments

- [ ] Add Deployment and ReplicaSet controllers when shared tests move from raw
      Pods to Deployments.
- [ ] Add default ServiceAccount behavior and in-cluster controller identity
      once controller tests need it.
- [ ] Add readiness/liveness/startup probing after the basic Service routing
      stack works.
- [ ] Add ConfigMap, Secret, downward API, and volume support only when a fake
      image or controller test needs them.
- [ ] Add Service environment variable injection only if tests depend on it;
      prefer DNS for service discovery.

## Testing Strategy

Test this through shared client tests, following the pattern already used in the
repo for real-cluster and simulated-cluster compatibility. Avoid a separate
unit-test-first strategy for these runtime/network features unless a small unit
test is needed to isolate a hard-to-debug failure.

The target test shape is:

- The same test code runs against a real Kubernetes cluster and this simulator.
- The test creates Kubernetes resources through the client API.
- The simulator observes those resources and drives kubelet/runtime/network
  behavior.
- Traffic enters the workload through a NodePort Service.
- In-cluster workload code resolves and calls Service DNS names.
- In-cluster controller code uses the existing project `KubeConfig` to
  communicate with the apiserver.

Start small. The first shared test should prove the minimal external traffic
path:

1. Pick a small, trusted Docker Hub image that serves HTTP, such as
   `crccheck/hello-world`, if it is still appropriate when implementation
   starts.
2. Run that image in a real cluster as a Pod or Deployment.
3. Expose it with a NodePort Service.
4. Send an HTTP request to the NodePort from the test harness.
5. Register a fake image with the same image reference in the simulator's
   `ImageRegistry`.
6. Replicate only the image behavior needed by the test in the fake image,
   including the HTTP response shape.
7. Run the same test against the simulator.

Once this single NodePort-to-pod HTTP test passes against both environments, it
is a strong signal that the first slice of the container, process, network,
Service, and NodePort stack is wired correctly. Add broader DNS, controller, and
multi-endpoint tests after this first test works.

Coverage should come from user-visible Kubernetes behavior:

- Creating a Pod/Deployment starts fake image processes.
- Creating a Service allocates a ClusterIP.
- Creating a NodePort Service exposes traffic to the test harness.
- Service DNS resolves through the fake CoreDNS pod.
- Service traffic routes to matching ready pods.
- Numeric and named `targetPort` values both work.
- Restarting a container keeps the pod IP stable.

## Kubernetes Source Notes

These implementation choices are based on the current Kubernetes and CoreDNS
boundaries:

- Current kubelet talks to container runtimes through CRI. It does not call CNI
  directly.
- Kubelet's main loop dispatches pod add/update/delete/reconcile events to pod
  workers, then `SyncPod` delegates desired state to the runtime and updates API
  pod status.
- Scheduler binds pods by selecting a node and setting `spec.nodeName`; kubelet
  is not responsible for choosing a node.
- Service ClusterIP and NodePort allocation is part of Service REST storage,
  not kube-proxy or CoreDNS.
- Kubernetes' default NodePort range is `30000-32767`. Dynamic ClusterIP and
  NodePort allocation uses random scan with an upper-range preference, so tests
  should discover allocated values rather than assert a specific dynamic
  allocation order.
- Kubelet marks running containers without readiness probes as ready. Pod
  `Ready` then follows `ContainersReady` plus readiness gates. Listener binding
  is not part of Kubernetes readiness unless a probe checks that listener.
- EndpointSlice controller lists pods matching Service selectors and reconciles
  EndpointSlice objects for Services with selectors.
- CoreDNS's Kubernetes plugin handles Service records under `.svc`.
- CoreDNS is not updated for each Service by a separate configuration
  controller. The Kubernetes plugin watches the Kubernetes API directly.
- CoreDNS watches Services, EndpointSlices, and Namespaces for the Service DNS
  behavior this simulator needs.
- CoreDNS returns ClusterIP records for normal ClusterIP Services. It does not
  select a backend pod for those Services.
- kube-proxy selects backend endpoints when traffic reaches the Service IP.
- kube-proxy iptables mode uses probabilistic random endpoint rules.
- kube-proxy IPVS mode defaults to the `rr` round-robin scheduler.

Relevant source references:

- Kubernetes CRI service interfaces:
  <https://raw.githubusercontent.com/kubernetes/cri-api/master/pkg/apis/services.go>
- Kubelet sync loop and `SyncPod`:
  `~/Developer/github.com/kubernetes/kubernetes/pkg/kubelet/kubelet.go`
- Kubelet runtime interface:
  `~/Developer/github.com/kubernetes/kubernetes/pkg/kubelet/container/runtime.go`
- Kubelet pod DNS config:
  `~/Developer/github.com/kubernetes/kubernetes/pkg/kubelet/network/dns/dns.go`
- Scheduler binding flow:
  `~/Developer/github.com/kubernetes/kubernetes/pkg/scheduler/schedule_one.go`
- Service storage allocation:
  `~/Developer/github.com/kubernetes/kubernetes/pkg/registry/core/service/storage/alloc.go`
- Default NodePort range:
  `~/Developer/github.com/kubernetes/kubernetes/pkg/kubeapiserver/options/options.go`
- NodePort allocation:
  `~/Developer/github.com/kubernetes/kubernetes/pkg/registry/core/service/portallocator/allocator.go`
- Random-scan allocator:
  `~/Developer/github.com/kubernetes/kubernetes/pkg/registry/core/service/allocator/bitmap.go`
- Service IP allocation:
  `~/Developer/github.com/kubernetes/kubernetes/pkg/registry/core/service/ipallocator/ipallocator.go`
- Kubelet no-readiness-probe default:
  `~/Developer/github.com/kubernetes/kubernetes/pkg/kubelet/prober/prober_manager.go`
- Pod readiness conditions:
  `~/Developer/github.com/kubernetes/kubernetes/pkg/kubelet/status/generate.go`
- EndpointSlice controller:
  `~/Developer/github.com/kubernetes/kubernetes/pkg/controller/endpointslice/endpointslice_controller.go`
- kube-proxy Service and EndpointSlice watches:
  `~/Developer/github.com/kubernetes/kubernetes/pkg/proxy/config/config.go`
- kube-proxy iptables endpoint rules:
  <https://raw.githubusercontent.com/kubernetes/kubernetes/master/pkg/proxy/iptables/proxier.go>
- kube-proxy IPVS default scheduler:
  <https://raw.githubusercontent.com/kubernetes/kubernetes/master/pkg/proxy/ipvs/proxier.go>
- CoreDNS Kubernetes plugin:
  <https://raw.githubusercontent.com/coredns/coredns/master/plugin/kubernetes/kubernetes.go>
- CoreDNS Kubernetes plugin setup:
  <https://raw.githubusercontent.com/coredns/coredns/master/plugin/kubernetes/setup.go>
- CoreDNS Kubernetes plugin controllers:
  <https://raw.githubusercontent.com/coredns/coredns/master/plugin/kubernetes/controller.go>
- CoreDNS Kubernetes plugin docs:
  <https://coredns.io/plugins/kubernetes/>

## Open Decisions

- Whether readiness should live only on containers or also be summarized on
  `PodInstance`; defer this until probe work.

## Design Principles

- Keep Kubernetes semantics where they make tests and behavior clearer.
- Avoid real CRI/CNI shapes unless they directly help implementation.
- Put pod-level state on `PodInstance`.
- Put image/env/command/restart state on `ContainerInstance`.
- Put one-execution state on `ProcessInstance`.
- Keep networking application-protocol-only and map-backed.
- Support HTTP and DNS directly; do not simulate raw TCP or UDP.
- Route Services to ready pods, not directly to containers or processes.
- Allocate Service ClusterIPs as part of Service creation.
- Use fake CoreDNS for DNS requests rather than hidden hostname magic.
- Prefer deterministic behavior over realism when the two conflict.
