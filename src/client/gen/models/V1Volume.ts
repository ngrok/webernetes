/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1AWSElasticBlockStoreVolumeSource } from "./V1AWSElasticBlockStoreVolumeSource";
import { V1AzureDiskVolumeSource } from "./V1AzureDiskVolumeSource";
import { V1AzureFileVolumeSource } from "./V1AzureFileVolumeSource";
import { V1CSIVolumeSource } from "./V1CSIVolumeSource";
import { V1CephFSVolumeSource } from "./V1CephFSVolumeSource";
import { V1CinderVolumeSource } from "./V1CinderVolumeSource";
import { V1ConfigMapVolumeSource } from "./V1ConfigMapVolumeSource";
import { V1DownwardAPIVolumeSource } from "./V1DownwardAPIVolumeSource";
import { V1EmptyDirVolumeSource } from "./V1EmptyDirVolumeSource";
import { V1EphemeralVolumeSource } from "./V1EphemeralVolumeSource";
import { V1FCVolumeSource } from "./V1FCVolumeSource";
import { V1FlexVolumeSource } from "./V1FlexVolumeSource";
import { V1FlockerVolumeSource } from "./V1FlockerVolumeSource";
import { V1GCEPersistentDiskVolumeSource } from "./V1GCEPersistentDiskVolumeSource";
import { V1GitRepoVolumeSource } from "./V1GitRepoVolumeSource";
import { V1GlusterfsVolumeSource } from "./V1GlusterfsVolumeSource";
import { V1HostPathVolumeSource } from "./V1HostPathVolumeSource";
import { V1ISCSIVolumeSource } from "./V1ISCSIVolumeSource";
import { V1ImageVolumeSource } from "./V1ImageVolumeSource";
import { V1NFSVolumeSource } from "./V1NFSVolumeSource";
import { V1PersistentVolumeClaimVolumeSource } from "./V1PersistentVolumeClaimVolumeSource";
import { V1PhotonPersistentDiskVolumeSource } from "./V1PhotonPersistentDiskVolumeSource";
import { V1PortworxVolumeSource } from "./V1PortworxVolumeSource";
import { V1ProjectedVolumeSource } from "./V1ProjectedVolumeSource";
import { V1QuobyteVolumeSource } from "./V1QuobyteVolumeSource";
import { V1RBDVolumeSource } from "./V1RBDVolumeSource";
import { V1ScaleIOVolumeSource } from "./V1ScaleIOVolumeSource";
import { V1SecretVolumeSource } from "./V1SecretVolumeSource";
import { V1StorageOSVolumeSource } from "./V1StorageOSVolumeSource";
import { V1VsphereVirtualDiskVolumeSource } from "./V1VsphereVirtualDiskVolumeSource";
export interface V1Volume {
	awsElasticBlockStore?: V1AWSElasticBlockStoreVolumeSource;
	azureDisk?: V1AzureDiskVolumeSource;
	azureFile?: V1AzureFileVolumeSource;
	cephfs?: V1CephFSVolumeSource;
	cinder?: V1CinderVolumeSource;
	configMap?: V1ConfigMapVolumeSource;
	csi?: V1CSIVolumeSource;
	downwardAPI?: V1DownwardAPIVolumeSource;
	emptyDir?: V1EmptyDirVolumeSource;
	ephemeral?: V1EphemeralVolumeSource;
	fc?: V1FCVolumeSource;
	flexVolume?: V1FlexVolumeSource;
	flocker?: V1FlockerVolumeSource;
	gcePersistentDisk?: V1GCEPersistentDiskVolumeSource;
	gitRepo?: V1GitRepoVolumeSource;
	glusterfs?: V1GlusterfsVolumeSource;
	hostPath?: V1HostPathVolumeSource;
	image?: V1ImageVolumeSource;
	iscsi?: V1ISCSIVolumeSource;
	name: string;
	nfs?: V1NFSVolumeSource;
	persistentVolumeClaim?: V1PersistentVolumeClaimVolumeSource;
	photonPersistentDisk?: V1PhotonPersistentDiskVolumeSource;
	portworxVolume?: V1PortworxVolumeSource;
	projected?: V1ProjectedVolumeSource;
	quobyte?: V1QuobyteVolumeSource;
	rbd?: V1RBDVolumeSource;
	scaleIO?: V1ScaleIOVolumeSource;
	secret?: V1SecretVolumeSource;
	storageos?: V1StorageOSVolumeSource;
	vsphereVolume?: V1VsphereVirtualDiskVolumeSource;
}
