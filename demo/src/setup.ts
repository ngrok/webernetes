import * as w8s from "webernetes";

import { DemoApiImage, DemoDatabaseImage, DemoRedisImage, DemoScheduledJobImage } from "./images";

export async function setup(cluster: w8s.Cluster): Promise<void> {
	cluster.registerImage(DemoApiImage);
	cluster.registerImage(DemoDatabaseImage);
	cluster.registerImage(DemoRedisImage);
	cluster.registerImage(DemoScheduledJobImage);

	await cluster.apply([
		deployment({
			name: "scheduled-job",
			labels: { app: "scheduled-job", tier: "jobs" },
			containers: [
				{
					name: "scheduled-job",
					image: "demo/scheduled-job:1.0",
				},
			],
		}),
		deployment({
			name: "api",
			labels: { app: "api", tier: "edge" },
			containers: [
				{
					name: "api",
					image: "demo/api:1.0",
					ports: [{ name: "http", containerPort: 8080 }],
					readinessProbe: {
						httpGet: { path: "/readyz", port: "http" },
						periodSeconds: 2,
						failureThreshold: 1,
						timeoutSeconds: 3,
					},
					livenessProbe: {
						httpGet: { path: "/healthz", port: "http" },
						periodSeconds: 3,
						failureThreshold: 2,
						timeoutSeconds: 3,
					},
				},
			],
		}),
		deployment({
			name: "database",
			labels: { app: "database", tier: "data" },
			containers: [
				{
					name: "database",
					image: "demo/database:1.0",
					ports: [{ name: "http", containerPort: 5432 }],
					readinessProbe: {
						httpGet: { path: "/readyz", port: "http" },
						periodSeconds: 2,
						failureThreshold: 1,
						timeoutSeconds: 3,
					},
				},
			],
		}),
		deployment({
			name: "redis",
			labels: { app: "redis", tier: "cache" },
			containers: [
				{
					name: "redis",
					image: "demo/redis:1.0",
					ports: [{ name: "http", containerPort: 6379 }],
					readinessProbe: {
						httpGet: { path: "/readyz", port: "http" },
						periodSeconds: 2,
						failureThreshold: 1,
						timeoutSeconds: 3,
					},
				},
			],
		}),
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

function deployment({
	containers,
	labels,
	name,
}: {
	containers: w8s.V1Container[];
	labels: Record<string, string>;
	name: string;
}): w8s.ClusterApplyResource {
	return {
		apiVersion: "apps/v1",
		kind: "Deployment",
		metadata: {
			name,
			namespace: "default",
			labels,
		},
		spec: {
			replicas: 1,
			selector: {
				matchLabels: {
					app: labels.app,
				},
			},
			template: {
				metadata: {
					labels,
				},
				spec: {
					containers,
				},
			},
		},
	};
}
