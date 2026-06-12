import type * as Real from "@kubernetes/client-node";
import type * as Fake from "../index";

type IsAssignable<From, To> = [From] extends [To] ? true : false;
type IsMutuallyAssignable<Left, Right> =
	IsAssignable<Left, Right> extends true ? IsAssignable<Right, Left> : false;
type Assert<T extends true> = T;

export type ClientTypeCompatibility = [
	Assert<IsMutuallyAssignable<Fake.IntOrString, Real.IntOrString>>,
	Assert<IsMutuallyAssignable<Fake.KubernetesObject, Real.KubernetesObject>>,
	Assert<
		IsMutuallyAssignable<
			Fake.KubernetesListObject<Fake.V1Deployment>,
			Real.KubernetesListObject<Real.V1Deployment>
		>
	>,
];

export type ModelCompatibility = [
	Assert<IsMutuallyAssignable<Fake.CoreV1ResourceClaim, Real.CoreV1ResourceClaim>>,
	Assert<IsMutuallyAssignable<Fake.CoreV1Event, Real.CoreV1Event>>,
	Assert<IsMutuallyAssignable<Fake.CoreV1EventList, Real.CoreV1EventList>>,
	Assert<IsMutuallyAssignable<Fake.CoreV1EventSeries, Real.CoreV1EventSeries>>,
	Assert<IsMutuallyAssignable<Fake.DiscoveryV1EndpointPort, Real.DiscoveryV1EndpointPort>>,
	Assert<
		IsMutuallyAssignable<
			Fake.V1AWSElasticBlockStoreVolumeSource,
			Real.V1AWSElasticBlockStoreVolumeSource
		>
	>,
	Assert<IsMutuallyAssignable<Fake.V1Affinity, Real.V1Affinity>>,
	Assert<IsMutuallyAssignable<Fake.V1AttachedVolume, Real.V1AttachedVolume>>,
	Assert<IsMutuallyAssignable<Fake.V1AppArmorProfile, Real.V1AppArmorProfile>>,
	Assert<IsMutuallyAssignable<Fake.V1AzureDiskVolumeSource, Real.V1AzureDiskVolumeSource>>,
	Assert<IsMutuallyAssignable<Fake.V1AzureFileVolumeSource, Real.V1AzureFileVolumeSource>>,
	Assert<IsMutuallyAssignable<Fake.V1Binding, Real.V1Binding>>,
	Assert<IsMutuallyAssignable<Fake.V1CSIVolumeSource, Real.V1CSIVolumeSource>>,
	Assert<IsMutuallyAssignable<Fake.V1Capabilities, Real.V1Capabilities>>,
	Assert<IsMutuallyAssignable<Fake.V1CephFSVolumeSource, Real.V1CephFSVolumeSource>>,
	Assert<IsMutuallyAssignable<Fake.V1CinderVolumeSource, Real.V1CinderVolumeSource>>,
	Assert<
		IsMutuallyAssignable<Fake.V1ClusterTrustBundleProjection, Real.V1ClusterTrustBundleProjection>
	>,
	Assert<IsMutuallyAssignable<Fake.V1Condition, Real.V1Condition>>,
	Assert<IsMutuallyAssignable<Fake.V1ConfigMapEnvSource, Real.V1ConfigMapEnvSource>>,
	Assert<IsMutuallyAssignable<Fake.V1ConfigMapKeySelector, Real.V1ConfigMapKeySelector>>,
	Assert<IsMutuallyAssignable<Fake.V1ConfigMapNodeConfigSource, Real.V1ConfigMapNodeConfigSource>>,
	Assert<IsMutuallyAssignable<Fake.V1ConfigMapProjection, Real.V1ConfigMapProjection>>,
	Assert<IsMutuallyAssignable<Fake.V1ConfigMapVolumeSource, Real.V1ConfigMapVolumeSource>>,
	Assert<IsMutuallyAssignable<Fake.V1Container, Real.V1Container>>,
	Assert<
		IsMutuallyAssignable<
			Fake.V1ContainerExtendedResourceRequest,
			Real.V1ContainerExtendedResourceRequest
		>
	>,
	Assert<IsMutuallyAssignable<Fake.V1ContainerImage, Real.V1ContainerImage>>,
	Assert<IsMutuallyAssignable<Fake.V1ContainerPort, Real.V1ContainerPort>>,
	Assert<IsMutuallyAssignable<Fake.V1ContainerResizePolicy, Real.V1ContainerResizePolicy>>,
	Assert<IsMutuallyAssignable<Fake.V1ContainerRestartRule, Real.V1ContainerRestartRule>>,
	Assert<
		IsMutuallyAssignable<
			Fake.V1ContainerRestartRuleOnExitCodes,
			Real.V1ContainerRestartRuleOnExitCodes
		>
	>,
	Assert<IsMutuallyAssignable<Fake.V1ContainerState, Real.V1ContainerState>>,
	Assert<IsMutuallyAssignable<Fake.V1ContainerStateRunning, Real.V1ContainerStateRunning>>,
	Assert<IsMutuallyAssignable<Fake.V1ContainerStateTerminated, Real.V1ContainerStateTerminated>>,
	Assert<IsMutuallyAssignable<Fake.V1ContainerStateWaiting, Real.V1ContainerStateWaiting>>,
	Assert<IsMutuallyAssignable<Fake.V1ContainerStatus, Real.V1ContainerStatus>>,
	Assert<IsMutuallyAssignable<Fake.V1ContainerUser, Real.V1ContainerUser>>,
	Assert<IsMutuallyAssignable<Fake.V1DownwardAPIProjection, Real.V1DownwardAPIProjection>>,
	Assert<IsMutuallyAssignable<Fake.V1DownwardAPIVolumeFile, Real.V1DownwardAPIVolumeFile>>,
	Assert<IsMutuallyAssignable<Fake.V1DownwardAPIVolumeSource, Real.V1DownwardAPIVolumeSource>>,
	Assert<IsMutuallyAssignable<Fake.V1DaemonEndpoint, Real.V1DaemonEndpoint>>,
	Assert<IsMutuallyAssignable<Fake.V1EmptyDirVolumeSource, Real.V1EmptyDirVolumeSource>>,
	Assert<IsMutuallyAssignable<Fake.V1EnvFromSource, Real.V1EnvFromSource>>,
	Assert<IsMutuallyAssignable<Fake.V1EnvVar, Real.V1EnvVar>>,
	Assert<IsMutuallyAssignable<Fake.V1EnvVarSource, Real.V1EnvVarSource>>,
	Assert<IsMutuallyAssignable<Fake.V1Endpoint, Real.V1Endpoint>>,
	Assert<IsMutuallyAssignable<Fake.V1EndpointConditions, Real.V1EndpointConditions>>,
	Assert<IsMutuallyAssignable<Fake.V1EndpointHints, Real.V1EndpointHints>>,
	Assert<IsMutuallyAssignable<Fake.V1EndpointSlice, Real.V1EndpointSlice>>,
	Assert<IsMutuallyAssignable<Fake.V1EndpointSliceList, Real.V1EndpointSliceList>>,
	Assert<IsMutuallyAssignable<Fake.V1EventSource, Real.V1EventSource>>,
	Assert<IsMutuallyAssignable<Fake.V1EphemeralContainer, Real.V1EphemeralContainer>>,
	Assert<IsMutuallyAssignable<Fake.V1EphemeralVolumeSource, Real.V1EphemeralVolumeSource>>,
	Assert<IsMutuallyAssignable<Fake.V1ExecAction, Real.V1ExecAction>>,
	Assert<IsMutuallyAssignable<Fake.V1FCVolumeSource, Real.V1FCVolumeSource>>,
	Assert<IsMutuallyAssignable<Fake.V1FileKeySelector, Real.V1FileKeySelector>>,
	Assert<IsMutuallyAssignable<Fake.V1FlexVolumeSource, Real.V1FlexVolumeSource>>,
	Assert<IsMutuallyAssignable<Fake.V1FlockerVolumeSource, Real.V1FlockerVolumeSource>>,
	Assert<IsMutuallyAssignable<Fake.V1ForNode, Real.V1ForNode>>,
	Assert<IsMutuallyAssignable<Fake.V1ForZone, Real.V1ForZone>>,
	Assert<
		IsMutuallyAssignable<Fake.V1GCEPersistentDiskVolumeSource, Real.V1GCEPersistentDiskVolumeSource>
	>,
	Assert<IsMutuallyAssignable<Fake.V1GRPCAction, Real.V1GRPCAction>>,
	Assert<IsMutuallyAssignable<Fake.V1GitRepoVolumeSource, Real.V1GitRepoVolumeSource>>,
	Assert<IsMutuallyAssignable<Fake.V1GlusterfsVolumeSource, Real.V1GlusterfsVolumeSource>>,
	Assert<IsMutuallyAssignable<Fake.V1HTTPGetAction, Real.V1HTTPGetAction>>,
	Assert<IsMutuallyAssignable<Fake.V1HTTPHeader, Real.V1HTTPHeader>>,
	Assert<IsMutuallyAssignable<Fake.V1HostAlias, Real.V1HostAlias>>,
	Assert<IsMutuallyAssignable<Fake.V1HostIP, Real.V1HostIP>>,
	Assert<IsMutuallyAssignable<Fake.V1HostPathVolumeSource, Real.V1HostPathVolumeSource>>,
	Assert<IsMutuallyAssignable<Fake.V1ISCSIVolumeSource, Real.V1ISCSIVolumeSource>>,
	Assert<IsMutuallyAssignable<Fake.V1ImageVolumeSource, Real.V1ImageVolumeSource>>,
	Assert<IsMutuallyAssignable<Fake.V1KeyToPath, Real.V1KeyToPath>>,
	Assert<IsMutuallyAssignable<Fake.V1LabelSelector, Real.V1LabelSelector>>,
	Assert<IsMutuallyAssignable<Fake.V1LabelSelectorRequirement, Real.V1LabelSelectorRequirement>>,
	Assert<IsMutuallyAssignable<Fake.V1Lifecycle, Real.V1Lifecycle>>,
	Assert<IsMutuallyAssignable<Fake.V1LifecycleHandler, Real.V1LifecycleHandler>>,
	Assert<IsMutuallyAssignable<Fake.V1LoadBalancerIngress, Real.V1LoadBalancerIngress>>,
	Assert<IsMutuallyAssignable<Fake.V1LoadBalancerStatus, Real.V1LoadBalancerStatus>>,
	Assert<IsMutuallyAssignable<Fake.V1LinuxContainerUser, Real.V1LinuxContainerUser>>,
	Assert<IsMutuallyAssignable<Fake.V1LocalObjectReference, Real.V1LocalObjectReference>>,
	Assert<IsMutuallyAssignable<Fake.V1ManagedFieldsEntry, Real.V1ManagedFieldsEntry>>,
	Assert<IsMutuallyAssignable<Fake.V1NFSVolumeSource, Real.V1NFSVolumeSource>>,
	Assert<IsMutuallyAssignable<Fake.V1Node, Real.V1Node>>,
	Assert<IsMutuallyAssignable<Fake.V1NodeAffinity, Real.V1NodeAffinity>>,
	Assert<IsMutuallyAssignable<Fake.V1NodeAddress, Real.V1NodeAddress>>,
	// V1NodeAllocatableResourceClaimStatus is modeled for Kubernetes 1.36, but client-node 1.4.0 does not export it.
	Assert<IsMutuallyAssignable<Fake.V1NodeConfigSource, Real.V1NodeConfigSource>>,
	Assert<IsMutuallyAssignable<Fake.V1NodeConfigStatus, Real.V1NodeConfigStatus>>,
	Assert<IsMutuallyAssignable<Fake.V1NodeCondition, Real.V1NodeCondition>>,
	Assert<IsMutuallyAssignable<Fake.V1NodeDaemonEndpoints, Real.V1NodeDaemonEndpoints>>,
	Assert<IsMutuallyAssignable<Fake.V1NodeFeatures, Real.V1NodeFeatures>>,
	Assert<IsMutuallyAssignable<Fake.V1NodeList, Real.V1NodeList>>,
	Assert<IsMutuallyAssignable<Fake.V1NodeRuntimeHandler, Real.V1NodeRuntimeHandler>>,
	Assert<
		IsMutuallyAssignable<Fake.V1NodeRuntimeHandlerFeatures, Real.V1NodeRuntimeHandlerFeatures>
	>,
	Assert<IsMutuallyAssignable<Fake.V1NodeSelector, Real.V1NodeSelector>>,
	Assert<IsMutuallyAssignable<Fake.V1NodeSelectorRequirement, Real.V1NodeSelectorRequirement>>,
	Assert<IsMutuallyAssignable<Fake.V1NodeSelectorTerm, Real.V1NodeSelectorTerm>>,
	Assert<IsMutuallyAssignable<Fake.V1NodeSpec, Real.V1NodeSpec>>,
	Assert<IsMutuallyAssignable<Fake.V1NodeStatus, Real.V1NodeStatus>>,
	Assert<IsMutuallyAssignable<Fake.V1NodeSwapStatus, Real.V1NodeSwapStatus>>,
	Assert<IsMutuallyAssignable<Fake.V1NodeSystemInfo, Real.V1NodeSystemInfo>>,
	Assert<IsMutuallyAssignable<Fake.V1ObjectFieldSelector, Real.V1ObjectFieldSelector>>,
	Assert<IsMutuallyAssignable<Fake.V1ObjectReference, Real.V1ObjectReference>>,
	Assert<IsMutuallyAssignable<Fake.V1ObjectMeta, Real.V1ObjectMeta>>,
	Assert<IsMutuallyAssignable<Fake.V1OwnerReference, Real.V1OwnerReference>>,
	Assert<IsMutuallyAssignable<Fake.V1PersistentVolumeClaimSpec, Real.V1PersistentVolumeClaimSpec>>,
	Assert<
		IsMutuallyAssignable<Fake.V1PersistentVolumeClaimTemplate, Real.V1PersistentVolumeClaimTemplate>
	>,
	Assert<
		IsMutuallyAssignable<
			Fake.V1PersistentVolumeClaimVolumeSource,
			Real.V1PersistentVolumeClaimVolumeSource
		>
	>,
	Assert<
		IsMutuallyAssignable<
			Fake.V1PhotonPersistentDiskVolumeSource,
			Real.V1PhotonPersistentDiskVolumeSource
		>
	>,
	Assert<IsMutuallyAssignable<Fake.V1DeleteOptions, Real.V1DeleteOptions>>,
	Assert<IsMutuallyAssignable<Fake.V1Deployment, Real.V1Deployment>>,
	Assert<IsMutuallyAssignable<Fake.V1DeploymentCondition, Real.V1DeploymentCondition>>,
	Assert<IsMutuallyAssignable<Fake.V1DeploymentList, Real.V1DeploymentList>>,
	Assert<IsMutuallyAssignable<Fake.V1DeploymentSpec, Real.V1DeploymentSpec>>,
	Assert<IsMutuallyAssignable<Fake.V1DeploymentStatus, Real.V1DeploymentStatus>>,
	Assert<IsMutuallyAssignable<Fake.V1DeploymentStrategy, Real.V1DeploymentStrategy>>,
	Assert<IsMutuallyAssignable<Fake.V1ListMeta, Real.V1ListMeta>>,
	Assert<IsMutuallyAssignable<Fake.V1Namespace, Real.V1Namespace>>,
	Assert<IsMutuallyAssignable<Fake.V1NamespaceCondition, Real.V1NamespaceCondition>>,
	Assert<IsMutuallyAssignable<Fake.V1NamespaceList, Real.V1NamespaceList>>,
	Assert<IsMutuallyAssignable<Fake.V1NamespaceSpec, Real.V1NamespaceSpec>>,
	Assert<IsMutuallyAssignable<Fake.V1NamespaceStatus, Real.V1NamespaceStatus>>,
	Assert<IsMutuallyAssignable<Fake.V1Pod, Real.V1Pod>>,
	Assert<IsMutuallyAssignable<Fake.V1PodList, Real.V1PodList>>,
	Assert<IsMutuallyAssignable<Fake.V1PodTemplateSpec, Real.V1PodTemplateSpec>>,
	Assert<IsMutuallyAssignable<Fake.V1Preconditions, Real.V1Preconditions>>,
	Assert<IsMutuallyAssignable<Fake.V1Status, Real.V1Status>>,
	Assert<IsMutuallyAssignable<Fake.V1StatusCause, Real.V1StatusCause>>,
	Assert<IsMutuallyAssignable<Fake.V1StatusDetails, Real.V1StatusDetails>>,
	Assert<IsMutuallyAssignable<Fake.V1PodAffinity, Real.V1PodAffinity>>,
	Assert<IsMutuallyAssignable<Fake.V1PodAffinityTerm, Real.V1PodAffinityTerm>>,
	Assert<IsMutuallyAssignable<Fake.V1PodAntiAffinity, Real.V1PodAntiAffinity>>,
	Assert<IsMutuallyAssignable<Fake.V1PodCertificateProjection, Real.V1PodCertificateProjection>>,
	Assert<IsMutuallyAssignable<Fake.V1PodCondition, Real.V1PodCondition>>,
	Assert<IsMutuallyAssignable<Fake.V1PodDNSConfig, Real.V1PodDNSConfig>>,
	Assert<IsMutuallyAssignable<Fake.V1PodDNSConfigOption, Real.V1PodDNSConfigOption>>,
	Assert<
		IsMutuallyAssignable<
			Fake.V1PodExtendedResourceClaimStatus,
			Real.V1PodExtendedResourceClaimStatus
		>
	>,
	Assert<IsMutuallyAssignable<Fake.V1PodIP, Real.V1PodIP>>,
	Assert<IsMutuallyAssignable<Fake.V1PodOS, Real.V1PodOS>>,
	Assert<IsMutuallyAssignable<Fake.V1PodReadinessGate, Real.V1PodReadinessGate>>,
	Assert<IsMutuallyAssignable<Fake.V1PodResourceClaim, Real.V1PodResourceClaim>>,
	Assert<IsMutuallyAssignable<Fake.V1PodResourceClaimStatus, Real.V1PodResourceClaimStatus>>,
	Assert<IsMutuallyAssignable<Fake.V1PodSchedulingGate, Real.V1PodSchedulingGate>>,
	Assert<IsMutuallyAssignable<Fake.V1PodSecurityContext, Real.V1PodSecurityContext>>,
	Assert<IsMutuallyAssignable<Fake.V1PodSpec, Real.V1PodSpec>>,
	Assert<IsMutuallyAssignable<Fake.V1PodStatus, Real.V1PodStatus>>,
	Assert<IsMutuallyAssignable<Fake.V1PortworxVolumeSource, Real.V1PortworxVolumeSource>>,
	Assert<IsMutuallyAssignable<Fake.V1PortStatus, Real.V1PortStatus>>,
	Assert<IsMutuallyAssignable<Fake.V1PreferredSchedulingTerm, Real.V1PreferredSchedulingTerm>>,
	Assert<IsMutuallyAssignable<Fake.V1Probe, Real.V1Probe>>,
	Assert<IsMutuallyAssignable<Fake.V1ProjectedVolumeSource, Real.V1ProjectedVolumeSource>>,
	Assert<IsMutuallyAssignable<Fake.V1QuobyteVolumeSource, Real.V1QuobyteVolumeSource>>,
	Assert<IsMutuallyAssignable<Fake.V1RBDVolumeSource, Real.V1RBDVolumeSource>>,
	Assert<IsMutuallyAssignable<Fake.V1ResourceFieldSelector, Real.V1ResourceFieldSelector>>,
	Assert<IsMutuallyAssignable<Fake.V1ResourceHealth, Real.V1ResourceHealth>>,
	Assert<IsMutuallyAssignable<Fake.V1ResourceRequirements, Real.V1ResourceRequirements>>,
	Assert<IsMutuallyAssignable<Fake.V1ResourceStatus, Real.V1ResourceStatus>>,
	Assert<IsMutuallyAssignable<Fake.V1ReplicaSet, Real.V1ReplicaSet>>,
	Assert<IsMutuallyAssignable<Fake.V1ReplicaSetCondition, Real.V1ReplicaSetCondition>>,
	Assert<IsMutuallyAssignable<Fake.V1ReplicaSetList, Real.V1ReplicaSetList>>,
	Assert<IsMutuallyAssignable<Fake.V1ReplicaSetSpec, Real.V1ReplicaSetSpec>>,
	Assert<IsMutuallyAssignable<Fake.V1ReplicaSetStatus, Real.V1ReplicaSetStatus>>,
	Assert<IsMutuallyAssignable<Fake.V1RollingUpdateDeployment, Real.V1RollingUpdateDeployment>>,
	Assert<IsMutuallyAssignable<Fake.V1SELinuxOptions, Real.V1SELinuxOptions>>,
	Assert<IsMutuallyAssignable<Fake.V1ScaleIOVolumeSource, Real.V1ScaleIOVolumeSource>>,
	Assert<IsMutuallyAssignable<Fake.V1Scale, Real.V1Scale>>,
	Assert<IsMutuallyAssignable<Fake.V1ScaleSpec, Real.V1ScaleSpec>>,
	Assert<IsMutuallyAssignable<Fake.V1ScaleStatus, Real.V1ScaleStatus>>,
	Assert<IsMutuallyAssignable<Fake.V1SeccompProfile, Real.V1SeccompProfile>>,
	Assert<IsMutuallyAssignable<Fake.V1SecretEnvSource, Real.V1SecretEnvSource>>,
	Assert<IsMutuallyAssignable<Fake.V1SecretKeySelector, Real.V1SecretKeySelector>>,
	Assert<IsMutuallyAssignable<Fake.V1SecretProjection, Real.V1SecretProjection>>,
	Assert<IsMutuallyAssignable<Fake.V1SecretVolumeSource, Real.V1SecretVolumeSource>>,
	Assert<IsMutuallyAssignable<Fake.V1SecurityContext, Real.V1SecurityContext>>,
	Assert<IsMutuallyAssignable<Fake.V1Service, Real.V1Service>>,
	Assert<
		IsMutuallyAssignable<Fake.V1ServiceAccountTokenProjection, Real.V1ServiceAccountTokenProjection>
	>,
	Assert<IsMutuallyAssignable<Fake.V1ServiceList, Real.V1ServiceList>>,
	Assert<IsMutuallyAssignable<Fake.V1ServicePort, Real.V1ServicePort>>,
	Assert<IsMutuallyAssignable<Fake.V1ServiceSpec, Real.V1ServiceSpec>>,
	Assert<IsMutuallyAssignable<Fake.V1ServiceStatus, Real.V1ServiceStatus>>,
	Assert<IsMutuallyAssignable<Fake.V1SleepAction, Real.V1SleepAction>>,
	Assert<IsMutuallyAssignable<Fake.V1StorageOSVolumeSource, Real.V1StorageOSVolumeSource>>,
	Assert<IsMutuallyAssignable<Fake.V1Sysctl, Real.V1Sysctl>>,
	Assert<IsMutuallyAssignable<Fake.V1TCPSocketAction, Real.V1TCPSocketAction>>,
	Assert<IsMutuallyAssignable<Fake.V1Toleration, Real.V1Toleration>>,
	Assert<IsMutuallyAssignable<Fake.V1TopologySpreadConstraint, Real.V1TopologySpreadConstraint>>,
	Assert<IsMutuallyAssignable<Fake.V1TypedLocalObjectReference, Real.V1TypedLocalObjectReference>>,
	Assert<IsMutuallyAssignable<Fake.V1TypedObjectReference, Real.V1TypedObjectReference>>,
	Assert<IsMutuallyAssignable<Fake.V1Volume, Real.V1Volume>>,
	Assert<IsMutuallyAssignable<Fake.V1VolumeDevice, Real.V1VolumeDevice>>,
	Assert<IsMutuallyAssignable<Fake.V1VolumeMount, Real.V1VolumeMount>>,
	Assert<IsMutuallyAssignable<Fake.V1VolumeMountStatus, Real.V1VolumeMountStatus>>,
	Assert<IsMutuallyAssignable<Fake.V1VolumeProjection, Real.V1VolumeProjection>>,
	Assert<
		IsMutuallyAssignable<Fake.V1VolumeResourceRequirements, Real.V1VolumeResourceRequirements>
	>,
	Assert<
		IsMutuallyAssignable<
			Fake.V1VsphereVirtualDiskVolumeSource,
			Real.V1VsphereVirtualDiskVolumeSource
		>
	>,
	Assert<IsMutuallyAssignable<Fake.V1WeightedPodAffinityTerm, Real.V1WeightedPodAffinityTerm>>,
	Assert<
		IsMutuallyAssignable<Fake.V1WindowsSecurityContextOptions, Real.V1WindowsSecurityContextOptions>
	>,
];
