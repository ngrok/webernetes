import { splitMaybeSubscriptedPath } from "../../../fieldpath/fieldpath";

// Models kubernetes/pkg/apis/core/pods/helpers.go ConvertDownwardAPIFieldLabel.
export function convertDownwardAPIFieldLabel(
	version: string,
	label: string,
	value: string,
): [label: string, value: string, err: Error | undefined] {
	if (version !== "v1") {
		return ["", "", new Error(`unsupported pod version: ${version}`)];
	}

	const [path, , ok] = splitMaybeSubscriptedPath(label);
	if (ok) {
		switch (path) {
			case "metadata.annotations":
			case "metadata.labels":
				return [label, value, undefined];
			default:
				return ["", "", new Error(`field label does not support subscript: ${label}`)];
		}
	}

	switch (label) {
		case "metadata.annotations":
		case "metadata.labels":
		case "metadata.name":
		case "metadata.namespace":
		case "metadata.uid":
		case "spec.nodeName":
		case "spec.restartPolicy":
		case "spec.serviceAccountName":
		case "spec.schedulerName":
		case "status.phase":
		case "status.hostIP":
		case "status.hostIPs":
		case "status.podIP":
		case "status.podIPs":
			return [label, value, undefined];
		case "spec.host":
			return ["spec.nodeName", value, undefined];
		default:
			return ["", "", new Error(`field label not supported: ${label}`)];
	}
}
