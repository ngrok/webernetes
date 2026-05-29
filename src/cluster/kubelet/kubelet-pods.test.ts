import { expect, it } from "vitest";
import type { V1Pod } from "../../client";
import { Cluster } from "../cluster";
import { browser } from "../../test/describe";

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go TestGeneratePodHostNameAndDomain.
browser.describe("generatePodHostNameAndDomain", () => {
	it.each([
		{
			name: "Default behavior - pod name as hostname",
			podName: "test-pod",
			podHostname: undefined,
			podSubdomain: undefined,
			podHostnameOverride: undefined,
			expectedHostname: "test-pod",
			expectedDomain: "",
			errorContains: undefined,
		},
		{
			name: "Custom Hostname - uses pod.Spec.Hostname",
			podName: "test-pod",
			podHostname: "custom-hostname",
			podSubdomain: undefined,
			podHostnameOverride: undefined,
			expectedHostname: "custom-hostname",
			expectedDomain: "",
			errorContains: undefined,
		},
		{
			name: "Custom Subdomain - constructs FQDN",
			podName: "test-pod",
			podHostname: undefined,
			podSubdomain: "my-subdomain",
			podHostnameOverride: undefined,
			expectedHostname: "test-pod",
			expectedDomain: "my-subdomain.default.svc.cluster.local",
			errorContains: undefined,
		},
		{
			name: "HostnameOverride - overrides all",
			podName: "test-pod",
			podHostname: "custom-hostname",
			podSubdomain: "my-subdomain",
			podHostnameOverride: "override-hostname",
			expectedHostname: "override-hostname",
			expectedDomain: "",
			errorContains: undefined,
		},
		{
			name: "HostnameOverride - enabled - overrides all - invalid hostname",
			podName: "test-pod",
			podHostname: "custom-hostname",
			podSubdomain: "my-subdomain",
			podHostnameOverride: "Invalid-Hostname-!",
			expectedHostname: "",
			expectedDomain: "",
			errorContains: 'pod HostnameOverride "Invalid-Hostname-!" is not a valid DNS subdomain',
		},
		{
			name: "HostnameOverride - enabled - overrides all - valid DNS hostname",
			podName: "test-pod",
			podHostname: undefined,
			podSubdomain: undefined,
			podHostnameOverride: "valid.hostname",
			expectedHostname: "valid.hostname",
			expectedDomain: "",
			errorContains: undefined,
		},
		{
			name: "Hostname Truncation - pod name is too long",
			podName: "a".repeat(65),
			podHostname: undefined,
			podSubdomain: undefined,
			podHostnameOverride: undefined,
			expectedHostname: "a".repeat(63),
			expectedDomain: "",
			errorContains: undefined,
		},
		{
			name: "Validation - invalid hostname",
			podName: "test-pod",
			podHostname: "Invalid-Hostname-!",
			podSubdomain: undefined,
			podHostnameOverride: undefined,
			expectedHostname: "",
			expectedDomain: "",
			errorContains: 'pod Hostname "Invalid-Hostname-!" is not a valid DNS label',
		},
		{
			name: "Validation - invalid subdomain",
			podName: "test-pod",
			podHostname: undefined,
			podSubdomain: "invalid_subdomain",
			podHostnameOverride: undefined,
			expectedHostname: "",
			expectedDomain: "",
			errorContains: 'pod Subdomain "invalid_subdomain" is not a valid DNS label',
		},
		{
			name: "Validation - too long hostname",
			podName: "test-pod",
			podHostname: "a".repeat(64),
			podSubdomain: undefined,
			podHostnameOverride: undefined,
			expectedHostname: "",
			expectedDomain: "",
			errorContains: "must be no more than 63 characters",
		},
	])(
		"$name",
		({
			podName,
			podHostname,
			podSubdomain,
			podHostnameOverride,
			expectedHostname,
			expectedDomain,
			errorContains,
		}) => {
			const cluster = new Cluster();
			const pod: V1Pod = {
				metadata: {
					name: podName,
					namespace: "default",
				},
				spec: {
					containers: [],
					hostname: podHostname,
					hostnameOverride: podHostnameOverride,
					subdomain: podSubdomain,
				},
			};

			const [hostname, domain, err] = cluster.servers[0].kubelet.generatePodHostNameAndDomain(pod);

			expect(err?.message ?? "").toContain(errorContains ?? "");
			expect(err === undefined).toBe(errorContains === undefined);
			expect(hostname).toBe(expectedHostname);
			expect(domain).toBe(expectedDomain);
		},
	);
});
