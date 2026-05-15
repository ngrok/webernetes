import type { V1Pod } from "../../../client";
import * as kubecontainer from "../container";
import * as kubetypes from "../types";
import { getHashFromMirrorPod, getPodHash } from "./mirror-client";

// Models kubernetes/pkg/kubelet/pod/pod_manager.go basicManager.
export class PodManager {
	private podByUid = new Map<string, V1Pod>();
	private mirrorPodByUid = new Map<string, V1Pod>();
	private podByFullName = new Map<string, V1Pod>();
	private mirrorPodByFullName = new Map<string, V1Pod>();
	private translationByUid = new Map<string, string>();

	constructor() {
		this.setPods([]);
	}

	// Models kubernetes/pkg/kubelet/pod/pod_manager.go SetPods.
	setPods(newPods: V1Pod[]): void {
		this.podByUid.clear();
		this.podByFullName.clear();
		this.mirrorPodByUid.clear();
		this.mirrorPodByFullName.clear();
		this.translationByUid.clear();

		this.updatePodsInternal(...newPods);
	}

	// Models kubernetes/pkg/kubelet/pod/pod_manager.go AddPod.
	addPod(pod: V1Pod): void {
		this.updatePod(pod);
	}

	// Models kubernetes/pkg/kubelet/pod/pod_manager.go UpdatePod.
	updatePod(pod: V1Pod): void {
		this.updatePodsInternal(pod);
	}

	// updatePodsInternal replaces the given pods in the current state of the
	// manager, updating the various indices.
	// Models kubernetes/pkg/kubelet/pod/pod_manager.go updatePodsInternal.
	private updatePodsInternal(...pods: V1Pod[]): void {
		for (const pod of pods) {
			const podFullName = kubecontainer.getPodFullName(pod);
			// This logic relies on a static pod and its mirror to have the same name.
			// Static and mirror pods are not currently produced by the simulator, but
			// when they are, this branch should mirror Kubernetes' mirror indexes.
			if (kubetypes.isMirrorPod(pod)) {
				const mirrorPodUid = pod.metadata?.uid ?? "";
				this.mirrorPodByUid.set(mirrorPodUid, pod);
				this.mirrorPodByFullName.set(podFullName, pod);
				const p = this.podByFullName.get(podFullName);
				if (p?.metadata?.uid) {
					this.translationByUid.set(mirrorPodUid, p.metadata.uid);
				}
			} else {
				const resolvedPodUid = pod.metadata?.uid ?? "";
				this.podByUid.set(resolvedPodUid, pod);
				this.podByFullName.set(podFullName, pod);
				const mirror = this.mirrorPodByFullName.get(podFullName);
				if (mirror?.metadata?.uid) {
					this.translationByUid.set(mirror.metadata.uid, resolvedPodUid);
				}
			}
		}
	}

	// Models kubernetes/pkg/kubelet/pod/pod_manager.go RemovePod.
	removePod(pod: V1Pod): void {
		const podFullName = kubecontainer.getPodFullName(pod);
		// Mirror pods are not currently produced by the simulator. If that changes,
		// remove their mirror indexes and translation entry here.
		if (kubetypes.isMirrorPod(pod)) {
			const mirrorPodUid = pod.metadata?.uid ?? "";
			this.mirrorPodByUid.delete(mirrorPodUid);
			this.mirrorPodByFullName.delete(podFullName);
			this.translationByUid.delete(mirrorPodUid);
		} else {
			this.podByUid.delete(pod.metadata?.uid ?? "");
			this.podByFullName.delete(podFullName);
		}
	}

	// Models kubernetes/pkg/kubelet/pod/pod_manager.go GetPods.
	getPods(): V1Pod[] {
		return podsMapToPods(this.podByUid);
	}

	// Models kubernetes/pkg/kubelet/pod/pod_manager.go GetPodsAndMirrorPods.
	getPodsAndMirrorPods(): {
		allPods: V1Pod[];
		allMirrorPods: V1Pod[];
		orphanedMirrorPodFullnames: string[];
	} {
		const allPods = podsMapToPods(this.podByUid);
		const allMirrorPods = mirrorPodsMapToMirrorPods(this.mirrorPodByUid);
		const orphanedMirrorPodFullnames: string[] = [];

		for (const podFullName of this.mirrorPodByFullName.keys()) {
			if (!this.podByFullName.has(podFullName)) {
				orphanedMirrorPodFullnames.push(podFullName);
			}
		}
		return { allPods, allMirrorPods, orphanedMirrorPodFullnames };
	}

	// Models kubernetes/pkg/kubelet/pod/pod_manager.go GetStaticPodToMirrorPodMap.
	getStaticPodToMirrorPodMap(): Map<V1Pod, V1Pod | undefined> {
		const staticPodsMapToMirrorPods = new Map<V1Pod, V1Pod | undefined>();
		for (const pod of podsMapToPods(this.podByUid)) {
			if (kubetypes.isStaticPod(pod)) {
				// Static pods are not currently produced by the simulator. If that
				// changes, this map should drive mirror pod reconciliation.
				staticPodsMapToMirrorPods.set(
					pod,
					this.mirrorPodByFullName.get(kubecontainer.getPodFullName(pod)),
				);
			}
		}
		return staticPodsMapToMirrorPods;
	}

	// Models kubernetes/pkg/kubelet/pod/pod_manager.go GetPodByUID.
	getPodByUid(uid: string): V1Pod | undefined {
		return this.podByUid.get(uid);
	}

	// Models kubernetes/pkg/kubelet/pod/pod_manager.go GetPodByName.
	getPodByName(namespace: string, name: string): V1Pod | undefined {
		const podFullName = kubecontainer.buildPodFullName(name, namespace);
		return this.getPodByFullName(podFullName);
	}

	// Models kubernetes/pkg/kubelet/pod/pod_manager.go GetPodByFullName.
	getPodByFullName(podFullName: string): V1Pod | undefined {
		return this.podByFullName.get(podFullName);
	}

	// Models kubernetes/pkg/kubelet/pod/pod_manager.go TranslatePodUID.
	translatePodUid(uid: string): string {
		if (uid === "") {
			return uid;
		}

		return this.translationByUid.get(uid) ?? uid;
	}

	// Models kubernetes/pkg/kubelet/pod/pod_manager.go GetUIDTranslations.
	getUidTranslations(): {
		podToMirror: Map<string, string>;
		mirrorToPod: Map<string, string>;
	} {
		const mirrorToPod = new Map<string, string>();
		const podToMirror = new Map<string, string>();
		for (const [uid, pod] of this.podByUid) {
			if (!kubetypes.isStaticPod(pod)) {
				continue;
			}
			podToMirror.set(uid, "");
		}
		for (const [k, v] of this.translationByUid) {
			mirrorToPod.set(k, v);
			podToMirror.set(v, k);
		}
		return { podToMirror, mirrorToPod };
	}

	// Models kubernetes/pkg/kubelet/pod/pod_manager.go GetMirrorPodByPod.
	getMirrorPodByPod(pod: V1Pod): V1Pod | undefined {
		return this.mirrorPodByFullName.get(kubecontainer.getPodFullName(pod));
	}

	// Models kubernetes/pkg/kubelet/pod/pod_manager.go GetPodByMirrorPod.
	getPodByMirrorPod(mirrorPod: V1Pod): V1Pod | undefined {
		return this.podByFullName.get(kubecontainer.getPodFullName(mirrorPod));
	}

	// Models kubernetes/pkg/kubelet/pod/pod_manager.go GetPodAndMirrorPod.
	getPodAndMirrorPod(aPod: V1Pod): {
		pod: V1Pod | undefined;
		mirrorPod: V1Pod | undefined;
		wasMirror: boolean;
	} {
		const fullName = kubecontainer.getPodFullName(aPod);
		if (kubetypes.isMirrorPod(aPod)) {
			return { pod: this.podByFullName.get(fullName), mirrorPod: aPod, wasMirror: true };
		}
		return { pod: aPod, mirrorPod: this.mirrorPodByFullName.get(fullName), wasMirror: false };
	}
}

// IsMirrorPodOf returns true if pod and mirrorPod are associated with each other.
// Models kubernetes/pkg/kubelet/pod/pod_manager.go IsMirrorPodOf.
export function isMirrorPodOf(mirrorPod: V1Pod, pod: V1Pod): boolean {
	// Check name and namespace first.
	if (
		pod.metadata?.name !== mirrorPod.metadata?.name ||
		pod.metadata?.namespace !== mirrorPod.metadata?.namespace
	) {
		return false;
	}
	const hash = getHashFromMirrorPod(mirrorPod);
	if (hash === undefined) {
		return false;
	}
	return hash === getPodHash(pod);
}

// Models kubernetes/pkg/kubelet/pod/pod_manager.go podsMapToPods.
function podsMapToPods(uidMap: Map<string, V1Pod>): V1Pod[] {
	return [...uidMap.values()];
}

// Models kubernetes/pkg/kubelet/pod/pod_manager.go mirrorPodsMapToMirrorPods.
function mirrorPodsMapToMirrorPods(uidMap: Map<string, V1Pod>): V1Pod[] {
	return [...uidMap.values()];
}
