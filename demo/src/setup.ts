import * as w8s from "webernetes";

export async function setup(cluster: w8s.Cluster): Promise<void> {
	await cluster.apply([
		{
			apiVersion: "v1",
			kind: "Pod",
			metadata: {
				name: "frontend",
				namespace: "default",
				labels: { app: "frontend", tier: "web" },
			},
			spec: {
				containers: [
					{
						name: "web",
						image: "registry.k8s.io/e2e-test-images/agnhost:2.40",
						command: ["/agnhost", "netexec", "--http-port=8080"],
						ports: [{ name: "http", containerPort: 8080 }],
						readinessProbe: {
							httpGet: { path: "/readyz", port: "http" },
							periodSeconds: 2,
							failureThreshold: 1,
						},
						livenessProbe: {
							httpGet: { path: "/healthz", port: "http" },
							periodSeconds: 3,
							failureThreshold: 2,
						},
					},
				],
			},
		},
		{
			apiVersion: "v1",
			kind: "Pod",
			metadata: {
				name: "api",
				namespace: "default",
				labels: { app: "api", tier: "backend" },
			},
			spec: {
				containers: [
					{
						name: "api",
						image: "registry.k8s.io/e2e-test-images/agnhost:2.40",
						command: ["/agnhost", "netexec", "--http-port=8080"],
						ports: [{ name: "http", containerPort: 8080 }],
						readinessProbe: {
							httpGet: { path: "/echo?code=500", port: "http" },
							periodSeconds: 2,
							failureThreshold: 1,
						},
					},
				],
			},
		},
		{
			apiVersion: "v1",
			kind: "Pod",
			metadata: {
				name: "worker",
				namespace: "default",
				labels: { app: "worker", tier: "jobs" },
			},
			spec: {
				containers: [
					{
						name: "jobs",
						image: "busybox:1.36",
						command: ["sleep", "3600"],
						readinessProbe: {
							exec: { command: ["true"] },
							periodSeconds: 2,
							failureThreshold: 1,
						},
					},
				],
			},
		},
		{
			apiVersion: "v1",
			kind: "Service",
			metadata: {
				name: "frontend",
				namespace: "default",
				labels: { app: "frontend" },
			},
			spec: {
				type: "NodePort",
				selector: { app: "frontend" },
				ports: [{ name: "http", port: 80, targetPort: 8080 }],
			},
		},
		{
			apiVersion: "v1",
			kind: "Service",
			metadata: {
				name: "api",
				namespace: "default",
				labels: { app: "api" },
			},
			spec: {
				type: "ClusterIP",
				selector: { app: "api" },
				ports: [{ name: "http", port: 80, targetPort: 8080 }],
			},
		},
	]);
}
