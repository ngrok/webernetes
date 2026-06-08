import { expect, it } from "vitest";
import { browser } from "../test/describe";
import { formatMap } from "./fieldpath";

// Models kubernetes/pkg/fieldpath/fieldpath_test.go TestFormatMap test case.
interface FormatMapUpstreamTestCase {
	name: string;
	args: {
		m: Record<string, string> | undefined;
	};
	wantFmtStr: string;
}

browser.describe("formatMap", () => {
	// Models kubernetes/pkg/fieldpath/fieldpath_test.go TestFormatMap.
	const tests: FormatMapUpstreamTestCase[] = [
		{
			name: "nil",
			args: {
				m: undefined,
			},
			wantFmtStr: "",
		},
		{
			name: "label",
			args: {
				m: {
					"beta.kubernetes.io/os": "linux",
					"kubernetes.io/arch": "amd64",
					"kubernetes.io/hostname": "master01",
					"kubernetes.io/os": "linux",
					"node-role.kubernetes.io/control-plane": "true",
					"node-role.kubernetes.io/master": "true",
				},
			},
			wantFmtStr: `beta.kubernetes.io/os="linux"
kubernetes.io/arch="amd64"
kubernetes.io/hostname="master01"
kubernetes.io/os="linux"
node-role.kubernetes.io/control-plane="true"
node-role.kubernetes.io/master="true"`,
		},
		{
			name: "annotation",
			args: {
				m: {
					"flannel.alpha.coreos.com/backend-data": `{"VNI":1,"VtepMAC":"ce:f9:c7:a4:de:64"}`,
					"flannel.alpha.coreos.com/backend-type": "vxlan",
					"flannel.alpha.coreos.com/kube-subnet-manager": "true",
					"flannel.alpha.coreos.com/public-ip": "192.168.19.160",
					"management.cattle.io/pod-limits": `{"cpu":"11400m","memory":"7965Mi"}`,
					"management.cattle.io/pod-requests": `{"cpu":"2482m","memory":"7984Mi","pods":"26"}`,
					"node.alpha.kubernetes.io/ttl": "0",
					"volumes.kubernetes.io/controller-managed-attach-detach": "true",
				},
			},
			wantFmtStr: `flannel.alpha.coreos.com/backend-data="{\\"VNI\\":1,\\"VtepMAC\\":\\"ce:f9:c7:a4:de:64\\"}"
flannel.alpha.coreos.com/backend-type="vxlan"
flannel.alpha.coreos.com/kube-subnet-manager="true"
flannel.alpha.coreos.com/public-ip="192.168.19.160"
management.cattle.io/pod-limits="{\\"cpu\\":\\"11400m\\",\\"memory\\":\\"7965Mi\\"}"
management.cattle.io/pod-requests="{\\"cpu\\":\\"2482m\\",\\"memory\\":\\"7984Mi\\",\\"pods\\":\\"26\\"}"
node.alpha.kubernetes.io/ttl="0"
volumes.kubernetes.io/controller-managed-attach-detach="true"`,
		},
	];

	it.each(tests)("$name", ({ args, wantFmtStr }) => {
		expect(formatMap(args.m)).toBe(wantFmtStr);
	});
});
