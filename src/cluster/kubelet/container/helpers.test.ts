import { expect, it } from "vitest";
import { browser } from "../../../test/describe";
import { hashContainer } from "./helpers";

browser.describe("hashContainer", () => {
	it("matches the upstream Kubernetes container hash fixture", () => {
		/*
		package main

		import (
			"fmt"

			v1 "k8s.io/api/core/v1"
			kubecontainer "k8s.io/kubernetes/pkg/kubelet/container"
		)

		func main() {
			container := v1.Container{
				Name:  "test_container",
				Image: "foo/image:v1",
				Args: []string{
					"/bin/sh",
					"-c",
					"echo abc",
				},
				Ports: []v1.ContainerPort{{ContainerPort: 8001}},
			}

			fmt.Printf("0x%08x\n", kubecontainer.HashContainer(&container))
			// 0x8e45cbd0
		}
		*/
		expect(
			hashContainer({
				name: "test_container",
				image: "foo/image:v1",
				args: ["/bin/sh", "-c", "echo abc"],
				ports: [{ containerPort: 8001 }],
			}),
		).toBe(0x8e45cbd0);
	});

	it("hashes only the fields upstream picks for running status", () => {
		/*
		package main

		import (
			"fmt"

			v1 "k8s.io/api/core/v1"
			kubecontainer "k8s.io/kubernetes/pkg/kubelet/container"
		)

		func main() {
			base := v1.Container{
				Name:  "test_container",
				Image: "foo/image:v1",
			}
			withIgnoredFields := v1.Container{
				Name:    "test_container",
				Image:   "foo/image:v1",
				Command: []string{"ignored"},
				Args:    []string{"ignored"},
				Env: []v1.EnvVar{{
					Name:  "IGNORED",
					Value: "ignored",
				}},
				Ports: []v1.ContainerPort{{
					Name:          "ignored",
					ContainerPort: 8001,
					Protocol:      v1.ProtocolUDP,
					HostIP:        "127.0.0.1",
					HostPort:      8002,
				}},
			}

			fmt.Printf("0x%08x\n0x%08x\n",
				kubecontainer.HashContainer(&base),
				kubecontainer.HashContainer(&withIgnoredFields),
			)
			// 0x8e45cbd0
			// 0x8e45cbd0
		}
		*/
		const base = hashContainer({
			name: "test_container",
			image: "foo/image:v1",
		});

		expect(
			hashContainer({
				name: "test_container",
				image: "foo/image:v1",
				command: ["ignored"],
				args: ["ignored"],
				env: [{ name: "IGNORED", value: "ignored" }],
				ports: [
					{
						name: "ignored",
						containerPort: 8001,
						protocol: "UDP",
						hostIP: "127.0.0.1",
						hostPort: 8002,
					},
				],
			}),
		).toBe(base);
	});
});
