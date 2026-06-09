/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";
import type { V1PodSecurityContext, V1Sysctl } from "../../../client";
import { browser } from "../../../test/describe";
import { convertPodSysctlsVariableToDotsSeparator } from "./util";

// Models kubernetes/pkg/kubelet/sysctl/util_test.go TestConvertPodSysctlsVariableToDotsSeparator.
browser.describe("TestConvertPodSysctlsVariableToDotsSeparator", () => {
	it("converts sysctl names to dot separators", () => {
		const sysctls: V1Sysctl[] = [
			{
				name: "kernel.msgmax",
				value: "8192",
			},
			{
				name: "kernel.shm_rmid_forced",
				value: "1",
			},
			{
				name: "net.ipv4.conf.eno2/100.rp_filter",
				value: "1",
			},
			{
				name: "net/ipv4/ip_local_port_range",
				value: "1024 65535",
			},
		];
		const exceptSysctls: V1Sysctl[] = [
			{
				name: "kernel.msgmax",
				value: "8192",
			},
			{
				name: "kernel.shm_rmid_forced",
				value: "1",
			},
			{
				name: "net.ipv4.conf.eno2/100.rp_filter",
				value: "1",
			},
			{
				name: "net.ipv4.ip_local_port_range",
				value: "1024 65535",
			},
		];
		const securityContext: V1PodSecurityContext = {
			sysctls,
		};

		convertPodSysctlsVariableToDotsSeparator(securityContext);
		expect(securityContext.sysctls).toEqual(exceptSysctls);
	});
});
