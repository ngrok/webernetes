# Webernetes

> Kubernetes that runs in your browser.

_Wait, what?_

This project is a port of a subset of the Kubernetes project to make it such
that clusters can be booted up in the browser, without any backend server
components.

_But why?_

At [ngrok](https://ngrok.com/), we wanted to make visual and interactive content
about Kubernetes. We didn't want to create infrastructure for spinning up real
clusters in some sort of backend and maintain that, so we decided to create a
browser-based simulator instead. This is an experiment, we will be building a
variety of content on top of this library in 2026. It may not work, but we're
going to give it a good ol' try.

## How does it work?

First, install webernetes as a dependency:

```bash
npm install webernetes
```

Then define an image to run in your cluster. **Webernetes does not run real
images from Docker Hub or anything like that, nor is it a goal to do so.**

```typescript
import { BaseImage, type ProcessContext } from "webernetes";

class MyImage extends BaseImage {
	// The imageName and imageVersion variables are what make up the image label
	// you'll use in your container definition. Here we have my-image:1.0 but
	// webernetes also knows what to do if you specify just my-image or
	// my-image:latest
	static readonly imageName = "my-image";
	static readonly imageVersion = "1.0";

	// If no other command is specified in your container manifest, this is the
	// command that will be passed in as argv below.
	readonly defaultCommand = ["server"];

	// exec is the main entrypoint for your image. It will be called with the
	// command-line arguments passed in from your container definition.
	override async exec(ctx: ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "server") {
			// The base image defines a bunch of core utils (cat, false, printenv,
			// etc.) so if we don't recognize the command, fall back to the base
			// image.
			return await super.exec(ctx, argv);
		}

		// Binds to port 8080 on this container.
		ctx.listenHttp(8080, async (request) => {
			return {
				statusCode: 200,
				body: "hello, world\n",
			};
		});

		// Required for long-running processes to be cancellable when clusters shut
		// down. If we returned an exit code of 0 here, the listener above would be
		// unregistered because this container will have exited.
		return await ctx.waitUntilKilled();
	}
}
```

Then we create a cluster and register our image with it.

```typescript
import { Cluster } from "webernetes";

const cluster = new Cluster();
cluster.registerImage(MyImage);
```

And then we can run the cluster and spawn a pod using our image in it.

```typescript
// By default this spins up a 3-node cluster. This can't currently be changed.
await cluster.init();

await cluster.apply([
	{
		apiVersion: "v1",
		kind: "Pod",
		metadata: {
			name: "my-pod",
			labels: { app: "my-pod" },
		},
		spec: {
			containers: [
				{
					name: "my-container",
					image: "my-image:1.0",
				},
			],
		},
	},
]);
```

To send a request to your pod, you'll need to create a `Service` to talk to it.
In this case, a `NodePort` service gives us the easiest route.

```typescript
await cluster.apply([
	{
		apiVersion: "v1",
		kind: "Service",
		metadata: { name: "my-service" },
		spec: {
			type: "NodePort",
			ports: [
				{
					port: 80,
					targetPort: 8080,
					nodePort: 31000,
					protocol: "TCP",
				},
			],
			selector: {
				app: "my-pod",
			},
		},
	},
]);

const resp = await cluster.fetch("http://node-1:31000");
const text = await resp.text(); // hello, world
```

Pods are also able to talk to each other over HTTP. To see how this works in a
more complete example, check out the code under the `demo/` directory.

## What's implemented and what isn't

I've scoped this so far to the bits I need to make the first piece of content
I want to make, which is about probing.

- [x]

## Map of the code

Below is a map of most of the major components involved in this project, how
they talk to each other, and links to both the Webertnetes (TS) implementation
and the upstream Kubernetes (Go) implementation.

```mermaid
flowchart LR
    subgraph ClusterWiring["Cluster and node wiring"]
        Cluster["`Cluster<br/><a href='src/cluster/cluster.ts'>TS</a>`"]
        Server["`Server<br/><a href='src/cluster/server.ts'>TS</a>`"]
    end

    Kubelet["`Kubelet<br/><a href='src/cluster/kubelet/kubelet.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/kubelet.go'>Go</a>`"]

    subgraph PodInput["Pod input and config"]
        PodConfig["`PodConfig<br/><a href='src/cluster/kubelet/config/config.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/config/config.go'>Go</a>`"]
        PodListWatchClient["`PodListWatchClient<br/><a href='src/cluster/kubelet/config/apiserver.ts'>TS</a><br/>simulator adapter`"]
        ListWatch["`ListWatch<br/><a href='src/client-go/tools/cache/listwatch.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/staging/src/k8s.io/client-go/tools/cache/listwatch.go'>Go</a>`"]
        Reflector["`Reflector<br/><a href='src/client-go/tools/cache/reflector.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/staging/src/k8s.io/client-go/tools/cache/reflector.go'>Go</a>`"]
        UndeltaStore["`UndeltaStore<br/><a href='src/client-go/tools/cache/undelta_store.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/staging/src/k8s.io/client-go/tools/cache/undelta_store.go'>Go</a>`"]
        ClientGoStore["`Store<br/><a href='src/client-go/tools/cache/store.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/staging/src/k8s.io/client-go/tools/cache/store.go'>Go</a>`"]
        Mux["`Mux<br/><a href='src/cluster/kubelet/config/mux.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/config/mux.go'>Go</a>`"]
        PodStorage["`podStorage<br/><a href='src/cluster/kubelet/config/config.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/config/config.go'>Go</a>`"]
        SourcesReady["`SourcesReady<br/><a href='src/cluster/kubelet/config/config.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/config/sources.go'>Go</a>`"]
    end

    subgraph APIStorage["API storage and fake etcd"]
        KubeClient["`KubeClient<br/><a href='src/cluster/cluster.ts'>TS</a>`"]
        KubeConfig["`KubeConfig<br/><a href='src/client/config.ts'>TS</a>`"]
        CoreV1Api["`CoreV1Api<br/><a href='src/client/gen/apis/impls/CoreV1Api.ts'>TS</a>`"]
        DiscoveryV1Api["`DiscoveryV1Api<br/><a href='src/client/gen/apis/impls/DiscoveryV1Api.ts'>TS</a>`"]
        ClientWatch["`Watch<br/><a href='src/client/watch.ts'>TS</a>`"]
        ResourceStore["`Resource Store<br/><a href='src/cluster/storage/store.ts'>TS</a>`"]
        PodStore["`PodStore<br/><a href='src/cluster/storage/pod.ts'>TS</a>`"]
        ServiceStore["`ServiceStore<br/><a href='src/cluster/storage/service.ts'>TS</a>`"]
        NodeStore["`NodeStore<br/><a href='src/cluster/storage/node.ts'>TS</a>`"]
        NamespaceStore["`NamespaceStore<br/><a href='src/cluster/storage/namespace.ts'>TS</a>`"]
        EventStore["`EventStore<br/><a href='src/cluster/storage/event.ts'>TS</a>`"]
        EndpointSliceStore["`EndpointSliceStore<br/><a href='src/cluster/storage/endpointslice.ts'>TS</a>`"]
        IpRange["`IpRange<br/><a href='src/cluster/storage/allocatable.ts'>TS</a>`"]
        PortRange["`PortRange<br/><a href='src/cluster/storage/allocatable.ts'>TS</a>`"]
        AllocatableRange["`AllocatableRange<br/><a href='src/cluster/storage/allocatable.ts'>TS</a>`"]
        Etcd["`Etcd<br/><a href='src/cluster/etcd.ts'>TS</a>`"]
        EventRecorder["`EventRecorderImpl<br/><a href='src/cluster/events.ts'>TS</a>`"]
    end

    subgraph PodSync["Pod sync, status, and lifecycle"]
        PodManager["`PodManager<br/><a href='src/cluster/kubelet/pod/pod-manager.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/pod/pod_manager.go'>Go</a>`"]
        PodWorkers["`PodWorkersImpl<br/><a href='src/cluster/kubelet/pod-workers.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/pod_workers.go'>Go</a>`"]
        WorkQueue["`BasicWorkQueue<br/><a href='src/cluster/kubelet/util/queue/work-queue.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/util/queue/work_queue.go'>Go</a>`"]
        PodStatusCache["`PodStatusCache<br/><a href='src/cluster/kubelet/container/cache.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/container/cache.go'>Go</a>`"]
        StatusManager["`StatusManagerImpl<br/><a href='src/cluster/kubelet/status/status-manager.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/status/status_manager.go'>Go</a>`"]
        ActiveDeadline["`ActiveDeadlineHandler<br/><a href='src/cluster/kubelet/active-deadline.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/active_deadline.go'>Go</a>`"]
        SyncHandlers["`PodSyncHandlers<br/><a href='src/cluster/kubelet/lifecycle/interfaces.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/lifecycle/interfaces.go'>Go</a>`"]
        SyncLoopHandlers["`PodSyncLoopHandlers<br/><a href='src/cluster/kubelet/lifecycle/interfaces.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/lifecycle/interfaces.go'>Go</a>`"]
        PodSyncer["`interface<br/>PodSyncer<br/><a href='src/cluster/kubelet/pod-workers.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/pod_workers.go'>Go</a>`"]
        ReasonCache["`ReasonCache<br/><a href='src/cluster/kubelet/reason-cache.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/reason_cache.go'>Go</a>`"]
        NodeStatusSetters["`Node status setters<br/><a href='src/cluster/kubelet/nodestatus/setters.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/nodestatus/setters.go'>Go</a>`"]
        DNSConfigurer["`DNS Configurer<br/><a href='src/cluster/kubelet/network/dns/dns.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/network/dns/dns.go'>Go</a>`"]
    end

    subgraph Runtime["Container runtime path"]
        RuntimeManager["`KubeGenericRuntimeManager<br/><a href='src/cluster/kubelet/kuberuntime/kuberuntime-manager.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/kuberuntime/kuberuntime_manager.go'>Go</a>`"]
        RuntimeCache["`RuntimeCacheImpl<br/><a href='src/cluster/kubelet/container/runtime-cache.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/container/runtime_cache.go'>Go</a>`"]
        RuntimeState["`RuntimeState<br/><a href='src/cluster/kubelet/runtime.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/runtime.go'>Go</a>`"]
        KubeletContainerGC["`Kubelet container GC<br/><a href='src/cluster/kubelet/container/container-gc.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/container/container_gc.go'>Go</a>`"]
        RuntimeContainerGC["`kuberuntime ContainerGC<br/><a href='src/cluster/kubelet/kuberuntime/kuberuntime-gc.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/kuberuntime/kuberuntime_gc.go'>Go</a>`"]
        PodContainerDeletor["`PodContainerDeletor<br/><a href='src/cluster/kubelet/pod-container-deletor.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/pod_container_deletor.go'>Go</a>`"]
        ImageManager["`KubeletImageManager<br/><a href='src/cluster/kubelet/images/image-manager.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/images/image_manager.go'>Go</a>`"]
        ImagePuller["`ParallelImagePuller<br/><a href='src/cluster/kubelet/images/puller.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/images/puller.go'>Go</a>`"]
        NoopPullManager["`NoopImagePullManager<br/><a href='src/cluster/kubelet/images/pullmanager/noop-pull-manager.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/images/pullmanager/noop_pull_manager.go'>Go</a>`"]
        HandlerRunner["`LifecycleHandlerRunner<br/><a href='src/cluster/kubelet/lifecycle/handlers.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/lifecycle/handlers.go'>Go</a>`"]
    end

    subgraph Probes["Probe subsystem"]
        ProbeManager["`ProbeManagerImpl<br/><a href='src/cluster/kubelet/prober/prober-manager.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/prober/prober_manager.go'>Go</a>`"]
        ProbeWorker["`ProbeWorker<br/><a href='src/cluster/kubelet/prober/worker.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/prober/worker.go'>Go</a>`"]
        ResultsManager["`ResultsManager<br/><a href='src/cluster/kubelet/prober/results/results-manager.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/prober/results/results_manager.go'>Go</a>`"]
        Prober["`Prober<br/><a href='src/cluster/kubelet/prober/prober.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/prober/prober.go'>Go</a>`"]
        ExecProber["`ExecProber<br/><a href='src/cluster/probe/exec/exec.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/probe/exec/exec.go'>Go</a>`"]
        HTTPProber["`HTTPProber<br/><a href='src/cluster/probe/http/http.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/probe/http/http.go'>Go</a>`"]
        TCPProber["`TCPProber<br/><a href='src/cluster/probe/tcp/tcp.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/probe/tcp/tcp.go'>Go</a>`"]
    end

    subgraph PLEG["Pod lifecycle events"]
        GenericPLEG["`GenericPLEG<br/><a href='src/cluster/kubelet/pleg/generic.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/kubelet/pleg/generic.go'>Go</a>`"]
    end

    subgraph SimulatorInfra["Simulator runtime infrastructure"]
        ClusterNetwork["`ClusterNetwork<br/><a href='src/cluster/cni/network.ts'>TS</a>`"]
        NetworkRegistration["`NetworkRegistration<br/><a href='src/cluster/cni/network.ts'>TS</a>`"]
        ImageRegistry["`ImageRegistry<br/><a href='src/cluster/cri/image.ts'>TS</a>`"]
        ImageDefinition["`interface<br/>ImageDefinition<br/><a href='src/cluster/cri/image.ts'>TS</a>`"]
        BaseImage["`BaseImage<br/><a href='src/cluster/images/base.ts'>TS</a>`"]

        subgraph WorkloadImages["Registered workload images"]
            PauseImage["`PauseImage<br/><a href='src/cluster/images/pause.ts'>TS</a>`"]
            BusyBoxImage["`BusyBoxImage<br/><a href='src/cluster/images/busybox.ts'>TS</a>`"]
            HelloWorldImage["`HelloWorldImage<br/><a href='src/cluster/images/hello-world.ts'>TS</a>`"]
            HttpEchoImage["`HttpEchoImage<br/><a href='src/cluster/images/http-echo.ts'>TS</a>`"]
            AgnhostImage["`AgnhostImage<br/><a href='src/cluster/images/agnhost.ts'>TS</a>`"]
        end

        subgraph ControlPlaneImages["Registered control-plane images"]
            SchedulerImage["`Scheduler<br/><a href='src/cluster/images/scheduler.ts'>TS</a>`"]
            KubeProxyImage["`KubeProxy<br/><a href='src/cluster/images/proxy.ts'>TS</a>`"]
            EndpointSliceControllerImage["`EndpointSliceController<br/><a href='src/cluster/images/endpointslice-controller.ts'>TS</a>`"]
            NamespaceControllerImage["`NamespaceController<br/><a href='src/cluster/images/namespace-controller.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/pkg/controller/namespace/namespace_controller.go'>Go</a>`"]
            CoreDNSImage["`CoreDNS<br/><a href='src/cluster/images/coredns.ts'>TS</a>`"]
        end

        PodSandboxInstance["`PodSandboxInstance<br/><a href='src/cluster/cri/runtime.ts'>TS</a>`"]
        ContainerInstance["`ContainerInstance<br/><a href='src/cluster/cri/runtime.ts'>TS</a>`"]
        ProcessInstance["`ProcessInstance<br/><a href='src/cluster/cri/runtime.ts'>TS</a>`"]
        ProcessContext["`ProcessContext<br/><a href='src/cluster/cri/runtime.ts'>TS</a>`"]
        ContainerFS["`ContainerFileSystem<br/><a href='src/cluster/cri/runtime.ts'>TS</a>`"]

        subgraph InProcessRuntimeBox["In-process CRI services"]
            CRIRuntime["`InProcessRuntimeService<br/><a href='src/cluster/cri/runtime.ts'>TS</a>`"]
            CRIRuntimeService["`interface<br/>RuntimeService<br/><a href='src/cluster/cri/apis/services.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/staging/src/k8s.io/cri-api/pkg/apis/services.go'>Go</a>`"]
            CRIImageService["`interface<br/>ImageManagerService<br/><a href='src/cluster/cri/apis/services.ts'>TS</a> | <a href='https://github.com/kubernetes/kubernetes/blob/ecf6decece6a6de25a57aad9ba90b6ce580f6f78/staging/src/k8s.io/cri-api/pkg/apis/services.go'>Go</a>`"]
            RuntimeDiagnostics["`interface<br/>RuntimeDiagnostics<br/><a href='src/cluster/cri/runtime.ts'>TS</a>`"]
        end
    end

    Cluster --> Server
    Cluster --> Etcd
    Cluster --> KubeConfig
    Cluster --> KubeClient
    Cluster --> ClusterNetwork
    Cluster --> ImageRegistry
    Cluster --> ServiceStore
    Server --> Kubelet
    Server --> KubeConfig
    Server --> KubeClient
    Server --> ClusterNetwork
    Server --> ImageRegistry
    Server --> CRIRuntime
    Server --> CRIRuntimeService
    Server --> CRIImageService
    Server --> RuntimeDiagnostics
    Server --> EventRecorder

    Kubelet --> PodConfig
    Kubelet --> PodListWatchClient
    Kubelet --> SourcesReady
    Kubelet --> KubeClient
    Kubelet --> PodManager
    Kubelet --> PodWorkers
    Kubelet --> WorkQueue
    Kubelet --> PodStatusCache
    Kubelet --> StatusManager
    Kubelet --> ActiveDeadline
    Kubelet --> SyncHandlers
    Kubelet --> SyncLoopHandlers
    Kubelet --> ReasonCache
    Kubelet --> NodeStatusSetters
    Kubelet --> DNSConfigurer
    Kubelet --> RuntimeManager
    Kubelet --> RuntimeCache
    Kubelet --> RuntimeState
    Kubelet --> KubeletContainerGC
    Kubelet --> PodContainerDeletor
    Kubelet --> ProbeManager
    Kubelet --> GenericPLEG
    Kubelet --> EventRecorder
    Kubelet --> ResultsManager

    PodConfig --> Mux
    PodConfig --> PodStorage
    PodConfig --> EventRecorder
    PodListWatchClient --> KubeConfig
    PodListWatchClient --> CoreV1Api
    PodListWatchClient --> ListWatch
    PodListWatchClient --> ClientWatch
    SourcesReady --> PodConfig
    KubeConfig --> Etcd
    KubeConfig --> CoreV1Api
    KubeConfig --> DiscoveryV1Api
    KubeConfig --> ClientWatch
    KubeClient --> KubeConfig
    KubeClient --> CoreV1Api
    KubeClient --> DiscoveryV1Api
    CoreV1Api --> PodStore
    CoreV1Api --> ServiceStore
    CoreV1Api --> NodeStore
    CoreV1Api --> NamespaceStore
    CoreV1Api --> EventStore
    DiscoveryV1Api --> EndpointSliceStore
    CoreV1Api --> ResourceStore
    DiscoveryV1Api --> ResourceStore
    ClientWatch --> ResourceStore
    PodStore --> ResourceStore
    ServiceStore --> ResourceStore
    NodeStore --> ResourceStore
    NamespaceStore --> ResourceStore
    EventStore --> ResourceStore
    EndpointSliceStore --> ResourceStore
    ServiceStore --> IpRange
    ServiceStore --> PortRange
    IpRange --> AllocatableRange
    PortRange --> AllocatableRange
    AllocatableRange --> Etcd
    ResourceStore --> Etcd
    EventRecorder --> CoreV1Api
    Reflector --> ListWatch
    Reflector --> UndeltaStore
    UndeltaStore --> ClientGoStore
    Mux --> PodStorage

    PodWorkers --> WorkQueue
    PodWorkers --> PodStatusCache
    PodWorkers --> PodSyncer
    PodSyncer --> Kubelet
    StatusManager --> PodManager
    StatusManager --> KubeClient
    ActiveDeadline --> StatusManager
    ActiveDeadline --> EventRecorder
    SyncHandlers --> ActiveDeadline
    SyncLoopHandlers --> ActiveDeadline
    NodeStatusSetters --> RuntimeManager
    NodeStatusSetters --> RuntimeState
    DNSConfigurer --> EventRecorder

    RuntimeManager --> RuntimeContainerGC
    RuntimeManager --> ImageManager
    RuntimeManager --> HandlerRunner
    RuntimeManager --> CRIRuntimeService
    RuntimeManager --> DNSConfigurer
    RuntimeManager --> EventRecorder
    RuntimeManager --> ClusterNetwork
    RuntimeManager --> ResultsManager
    RuntimeManager --> PodWorkers
    RuntimeCache --> RuntimeManager
    KubeletContainerGC --> RuntimeManager
    KubeletContainerGC --> SourcesReady
    PodContainerDeletor --> RuntimeManager
    RuntimeState --> GenericPLEG
    ImageManager --> ImagePuller
    ImageManager --> NoopPullManager
    ImageManager --> CRIImageService
    ImageManager --> EventRecorder
    ImagePuller --> CRIImageService
    HandlerRunner --> ClusterNetwork
    HandlerRunner --> RuntimeManager
    RuntimeContainerGC --> CRIRuntimeService
    RuntimeContainerGC --> PodWorkers

    ProbeManager --> ResultsManager
    ProbeManager --> ProbeWorker
    ProbeManager --> Prober
    ProbeManager --> StatusManager
    ProbeWorker --> StatusManager
    ProbeWorker --> ResultsManager
    ProbeWorker --> Prober
    Prober --> ExecProber
    Prober --> HTTPProber
    Prober --> TCPProber
    Prober --> RuntimeManager
    Prober --> EventRecorder
    HTTPProber --> ClusterNetwork
    TCPProber --> ClusterNetwork

    GenericPLEG --> RuntimeManager
    GenericPLEG --> PodStatusCache

    CRIRuntimeService --> CRIRuntime
    CRIImageService --> CRIRuntime
    RuntimeDiagnostics --> CRIRuntime
    CRIRuntime --> ImageRegistry
    CRIRuntime --> PodSandboxInstance
    CRIRuntime --> ContainerInstance
    CRIRuntime --> ProcessInstance
    CRIRuntime --> ClusterNetwork
    CRIRuntime --> KubeConfig
    PodSandboxInstance --> NetworkRegistration
    PodSandboxInstance --> ContainerInstance
    ContainerInstance --> ProcessInstance
    ContainerInstance --> ContainerFS
    ProcessInstance --> ProcessContext
    ProcessContext --> ContainerFS
    ProcessContext --> ClusterNetwork
    ProcessContext --> KubeConfig
    ClusterNetwork --> PodSandboxInstance
    ClusterNetwork --> NetworkRegistration
    ImageRegistry --> ImageDefinition
    ImageRegistry --> BaseImage
    ImageRegistry --> PauseImage
    ImageRegistry --> BusyBoxImage
    ImageRegistry --> HelloWorldImage
    ImageRegistry --> HttpEchoImage
    ImageRegistry --> AgnhostImage
    ImageRegistry --> SchedulerImage
    ImageRegistry --> KubeProxyImage
    ImageRegistry --> EndpointSliceControllerImage
    ImageRegistry --> NamespaceControllerImage
    ImageRegistry --> CoreDNSImage
    PauseImage --> BaseImage
    BusyBoxImage --> BaseImage
    HelloWorldImage --> BaseImage
    HttpEchoImage --> BaseImage
    AgnhostImage --> BaseImage
    SchedulerImage --> BaseImage
    KubeProxyImage --> BaseImage
    EndpointSliceControllerImage --> BaseImage
    NamespaceControllerImage --> BaseImage
    CoreDNSImage --> BaseImage
    BaseImage --> ImageDefinition
    BaseImage --> ProcessContext
    BaseImage --> ProcessInstance
    BaseImage --> ContainerFS
    BusyBoxImage --> ProcessContext
    HelloWorldImage --> ProcessContext
    HttpEchoImage --> ProcessContext
    AgnhostImage --> ProcessContext
    SchedulerImage --> KubeConfig
    SchedulerImage --> CoreV1Api
    SchedulerImage --> EventRecorder
    KubeProxyImage --> KubeConfig
    KubeProxyImage --> CoreV1Api
    KubeProxyImage --> DiscoveryV1Api
    KubeProxyImage --> ClusterNetwork
    EndpointSliceControllerImage --> KubeConfig
    EndpointSliceControllerImage --> CoreV1Api
    EndpointSliceControllerImage --> DiscoveryV1Api
    NamespaceControllerImage --> KubeConfig
    NamespaceControllerImage --> CoreV1Api
    NamespaceControllerImage --> DiscoveryV1Api
    CoreDNSImage --> KubeConfig
    CoreDNSImage --> CoreV1Api

    classDef simOnly fill:#fff7ed,stroke:#ea580c,stroke-width:2px,stroke-dasharray:5 4,color:#7c2d12;
    classDef iface fill:#eff6ff,stroke:#2563eb,stroke-width:2px,color:#1e3a8a;
    class Cluster,Server,PodListWatchClient,KubeClient,KubeConfig,CoreV1Api,DiscoveryV1Api,ClientWatch,ResourceStore,PodStore,ServiceStore,NodeStore,NamespaceStore,EventStore,EndpointSliceStore,IpRange,PortRange,AllocatableRange,Etcd,EventRecorder,ClusterNetwork,NetworkRegistration,CRIRuntime,ImageRegistry,BaseImage,PauseImage,BusyBoxImage,HelloWorldImage,HttpEchoImage,AgnhostImage,SchedulerImage,KubeProxyImage,EndpointSliceControllerImage,NamespaceControllerImage,CoreDNSImage,PodSandboxInstance,ContainerInstance,ProcessInstance,ProcessContext,ContainerFS simOnly;
    class ImageDefinition,PodSyncer,CRIRuntimeService,CRIImageService,RuntimeDiagnostics iface;
```
