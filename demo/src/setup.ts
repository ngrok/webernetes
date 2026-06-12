import * as w8s from "webernetes";

import { DemoApiImage, DemoDatabaseImage, DemoRedisImage } from "./images";

export async function setup(cluster: w8s.Cluster): Promise<void> {
	cluster.registerImage(DemoApiImage);
	cluster.registerImage(DemoDatabaseImage);
	cluster.registerImage(DemoRedisImage);

	await cluster.apply([
		{
			apiVersion: "v1",
			kind: "Pod",
			metadata: {
				name: "api",
				namespace: "default",
				labels: { app: "api", tier: "edge" },
			},
			spec: {
				containers: [
					{
						name: "api",
						image: "demo/api:1.0",
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
				name: "database",
				namespace: "default",
				labels: { app: "database", tier: "data" },
			},
			spec: {
				containers: [
					{
						name: "database",
						image: "demo/database:1.0",
						ports: [{ name: "http", containerPort: 5432 }],
						readinessProbe: {
							httpGet: { path: "/readyz", port: "http" },
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
				name: "redis",
				namespace: "default",
				labels: { app: "redis", tier: "cache" },
			},
			spec: {
				containers: [
					{
						name: "redis",
						image: "demo/redis:1.0",
						ports: [{ name: "http", containerPort: 6379 }],
						readinessProbe: {
							httpGet: { path: "/readyz", port: "http" },
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
				name: "api",
				namespace: "default",
				labels: { app: "api" },
			},
			spec: {
				type: "NodePort",
				selector: { app: "api" },
				ports: [{ name: "http", port: 80, targetPort: 8080 }],
			},
		},
		{
			apiVersion: "v1",
			kind: "Service",
			metadata: {
				name: "database",
				namespace: "default",
				labels: { app: "database" },
			},
			spec: {
				type: "ClusterIP",
				selector: { app: "database" },
				ports: [{ name: "http", port: 5432, targetPort: 5432 }],
			},
		},
		{
			apiVersion: "v1",
			kind: "Service",
			metadata: {
				name: "redis",
				namespace: "default",
				labels: { app: "redis" },
			},
			spec: {
				type: "ClusterIP",
				selector: { app: "redis" },
				ports: [{ name: "http", port: 6379, targetPort: 6379 }],
			},
		},
	]);
}
