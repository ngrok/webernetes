import { expect, it } from "vitest";
import { browser } from "../../../../test/describe";
import { getNodenameForKernel } from "./util";

browser.describe("getNodenameForKernel", () => {
	it.each([
		{
			description: "no hostDomain, setHostnameAsFQDN false",
			hostname: "test.pod.hostname",
			hostDomain: "",
			setHostnameAsFQDN: false,
			expectedHostname: "test.pod.hostname",
			expectError: false,
		},
		{
			description: "no hostDomain, setHostnameAsFQDN true",
			hostname: "test.pod.hostname",
			hostDomain: "",
			setHostnameAsFQDN: true,
			expectedHostname: "test.pod.hostname",
			expectError: false,
		},
		{
			description: "valid hostDomain, setHostnameAsFQDN false",
			hostname: "test.pod.hostname",
			hostDomain: "svc.subdomain.local",
			setHostnameAsFQDN: false,
			expectedHostname: "test.pod.hostname",
			expectError: false,
		},
		{
			description: "valid hostDomain, setHostnameAsFQDN true",
			hostname: "test.pod.hostname",
			hostDomain: "svc.subdomain.local",
			setHostnameAsFQDN: true,
			expectedHostname: "test.pod.hostname.svc.subdomain.local",
			expectError: false,
		},
		{
			description: "FQDN is too long, setHostnameAsFQDN false",
			hostname: "1234567.1234567",
			hostDomain: "1234567.1234567.1234567.1234567.1234567.1234567.1234567",
			setHostnameAsFQDN: false,
			expectedHostname: "1234567.1234567",
			expectError: false,
		},
		{
			description: "FQDN is too long, setHostnameAsFQDN true",
			hostname: "1234567.1234567",
			hostDomain: "1234567.1234567.1234567.1234567.1234567.1234567.1234567",
			setHostnameAsFQDN: true,
			expectedHostname: "",
			expectError: true,
		},
	])(
		"$description",
		({ hostname, hostDomain, setHostnameAsFQDN, expectedHostname, expectError }) => {
			const [nodeName, err] = getNodenameForKernel(hostname, hostDomain, setHostnameAsFQDN);
			expect(nodeName).toBe(expectedHostname);
			expect(err !== undefined).toBe(expectError);
		},
	);
});
