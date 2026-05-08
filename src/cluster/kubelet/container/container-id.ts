export class ContainerID {
	constructor(
		readonly type: string,
		readonly id: string,
	) {}

	toString(): string {
		return `${this.type}://${this.id}`;
	}
}

// Models kubernetes/pkg/kubelet/container/runtime.go BuildContainerID.
export function buildContainerID(type: string, id: string): ContainerID {
	return new ContainerID(type, id);
}

// Models kubernetes/pkg/kubelet/container/runtime.go ParseContainerID.
export function parseContainerID(containerID: string | undefined): ContainerID {
	const parts = containerID?.replace(/^"+|"+$/g, "").split("://") ?? [];
	if (parts.length !== 2) {
		return new ContainerID("", "");
	}
	return new ContainerID(parts[0] ?? "", parts[1] ?? "");
}
