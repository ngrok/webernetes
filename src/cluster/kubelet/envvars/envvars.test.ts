/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";
import type { V1EnvVar, V1Service } from "../../../client";
import { browser } from "../../../test/describe";
import { fromServices } from "./envvars";

// Models kubernetes/pkg/kubelet/envvars/envvars_test.go TestFromServices.
browser.describe("fromServices", () => {
	it("builds service environment variables", () => {
		const sl: V1Service[] = [
			{
				metadata: { name: "foo-bar" },
				spec: {
					selector: { bar: "baz" },
					clusterIP: "1.2.3.4",
					ports: [{ port: 8080, protocol: "TCP" }],
				},
			},
			{
				metadata: { name: "abc-123" },
				spec: {
					selector: { bar: "baz" },
					clusterIP: "5.6.7.8",
					ports: [
						{ name: "u-d-p", port: 8081, protocol: "UDP" },
						{ name: "t-c-p", port: 8081, protocol: "TCP" },
					],
				},
			},
			{
				metadata: { name: "q-u-u-x" },
				spec: {
					selector: { bar: "baz" },
					clusterIP: "9.8.7.6",
					ports: [
						{ port: 8082, protocol: "TCP" },
						{ name: "8083", port: 8083, protocol: "TCP" },
					],
				},
			},
			{
				metadata: { name: "svrc-clusterip-none" },
				spec: {
					selector: { bar: "baz" },
					clusterIP: "None",
					ports: [{ port: 8082, protocol: "TCP" }],
				},
			},
			{
				metadata: { name: "svrc-clusterip-empty" },
				spec: {
					selector: { bar: "baz" },
					clusterIP: "",
					ports: [{ port: 8082, protocol: "TCP" }],
				},
			},
			{
				metadata: { name: "super-ipv6" },
				spec: {
					selector: { bar: "baz" },
					clusterIP: "2001:DB8::",
					ports: [
						{ name: "u-d-p", port: 8084, protocol: "UDP" },
						{ name: "t-c-p", port: 8084, protocol: "TCP" },
					],
				},
			},
			{
				metadata: { name: "sctp-1" },
				spec: {
					selector: { bar: "sctp-sel" },
					clusterIP: "1.2.3.4",
					ports: [{ port: 777, protocol: "SCTP" }],
				},
			},
		];
		const vars = fromServices(sl);
		const expected: V1EnvVar[] = [
			{ name: "FOO_BAR_SERVICE_HOST", value: "1.2.3.4" },
			{ name: "FOO_BAR_SERVICE_PORT", value: "8080" },
			{ name: "FOO_BAR_PORT", value: "tcp://1.2.3.4:8080" },
			{ name: "FOO_BAR_PORT_8080_TCP", value: "tcp://1.2.3.4:8080" },
			{ name: "FOO_BAR_PORT_8080_TCP_PROTO", value: "tcp" },
			{ name: "FOO_BAR_PORT_8080_TCP_PORT", value: "8080" },
			{ name: "FOO_BAR_PORT_8080_TCP_ADDR", value: "1.2.3.4" },
			{ name: "ABC_123_SERVICE_HOST", value: "5.6.7.8" },
			{ name: "ABC_123_SERVICE_PORT", value: "8081" },
			{ name: "ABC_123_SERVICE_PORT_U_D_P", value: "8081" },
			{ name: "ABC_123_SERVICE_PORT_T_C_P", value: "8081" },
			{ name: "ABC_123_PORT", value: "udp://5.6.7.8:8081" },
			{ name: "ABC_123_PORT_8081_UDP", value: "udp://5.6.7.8:8081" },
			{ name: "ABC_123_PORT_8081_UDP_PROTO", value: "udp" },
			{ name: "ABC_123_PORT_8081_UDP_PORT", value: "8081" },
			{ name: "ABC_123_PORT_8081_UDP_ADDR", value: "5.6.7.8" },
			{ name: "ABC_123_PORT_8081_TCP", value: "tcp://5.6.7.8:8081" },
			{ name: "ABC_123_PORT_8081_TCP_PROTO", value: "tcp" },
			{ name: "ABC_123_PORT_8081_TCP_PORT", value: "8081" },
			{ name: "ABC_123_PORT_8081_TCP_ADDR", value: "5.6.7.8" },
			{ name: "Q_U_U_X_SERVICE_HOST", value: "9.8.7.6" },
			{ name: "Q_U_U_X_SERVICE_PORT", value: "8082" },
			{ name: "Q_U_U_X_SERVICE_PORT_8083", value: "8083" },
			{ name: "Q_U_U_X_PORT", value: "tcp://9.8.7.6:8082" },
			{ name: "Q_U_U_X_PORT_8082_TCP", value: "tcp://9.8.7.6:8082" },
			{ name: "Q_U_U_X_PORT_8082_TCP_PROTO", value: "tcp" },
			{ name: "Q_U_U_X_PORT_8082_TCP_PORT", value: "8082" },
			{ name: "Q_U_U_X_PORT_8082_TCP_ADDR", value: "9.8.7.6" },
			{ name: "Q_U_U_X_PORT_8083_TCP", value: "tcp://9.8.7.6:8083" },
			{ name: "Q_U_U_X_PORT_8083_TCP_PROTO", value: "tcp" },
			{ name: "Q_U_U_X_PORT_8083_TCP_PORT", value: "8083" },
			{ name: "Q_U_U_X_PORT_8083_TCP_ADDR", value: "9.8.7.6" },
			{ name: "SUPER_IPV6_SERVICE_HOST", value: "2001:DB8::" },
			{ name: "SUPER_IPV6_SERVICE_PORT", value: "8084" },
			{ name: "SUPER_IPV6_SERVICE_PORT_U_D_P", value: "8084" },
			{ name: "SUPER_IPV6_SERVICE_PORT_T_C_P", value: "8084" },
			{ name: "SUPER_IPV6_PORT", value: "udp://[2001:DB8::]:8084" },
			{ name: "SUPER_IPV6_PORT_8084_UDP", value: "udp://[2001:DB8::]:8084" },
			{ name: "SUPER_IPV6_PORT_8084_UDP_PROTO", value: "udp" },
			{ name: "SUPER_IPV6_PORT_8084_UDP_PORT", value: "8084" },
			{ name: "SUPER_IPV6_PORT_8084_UDP_ADDR", value: "2001:DB8::" },
			{ name: "SUPER_IPV6_PORT_8084_TCP", value: "tcp://[2001:DB8::]:8084" },
			{ name: "SUPER_IPV6_PORT_8084_TCP_PROTO", value: "tcp" },
			{ name: "SUPER_IPV6_PORT_8084_TCP_PORT", value: "8084" },
			{ name: "SUPER_IPV6_PORT_8084_TCP_ADDR", value: "2001:DB8::" },
			{ name: "SCTP_1_SERVICE_HOST", value: "1.2.3.4" },
			{ name: "SCTP_1_SERVICE_PORT", value: "777" },
			{ name: "SCTP_1_PORT", value: "sctp://1.2.3.4:777" },
			{ name: "SCTP_1_PORT_777_SCTP", value: "sctp://1.2.3.4:777" },
			{ name: "SCTP_1_PORT_777_SCTP_PROTO", value: "sctp" },
			{ name: "SCTP_1_PORT_777_SCTP_PORT", value: "777" },
			{ name: "SCTP_1_PORT_777_SCTP_ADDR", value: "1.2.3.4" },
		];

		expect(vars).toHaveLength(expected.length);
		for (let i = 0; i < expected.length; i++) {
			expect(vars[i]).toEqual(expected[i]);
		}
	});
});
