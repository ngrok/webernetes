# Webernetes

Webernetes is a browser-friendly simulation of selected Kubernetes components.
This map focuses on the current simulator implementation: substantial components
owned by the kubelet, then the central subsystems those components own or create.

## Kubelet Component Map

Nodes link to the local TypeScript implementation and, where the implementation
mirrors Kubernetes, the upstream Go file at the Kubernetes 1.36 commit this
repository targets. Dashed orange nodes are simulator-only pieces or simulator
adapters around a Kubernetes-shaped boundary.

Render and watch this file locally with:

```sh
pnpm readme:preview
```

Then open `dist/readme-preview.html` and refresh the browser after changes.

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
